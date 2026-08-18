import type { FastifyInstance } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";
import {
  decodeAbi,
  EventConsumerAckRequestSchema,
  EventConsumerAckResponseSchema,
  EventConsumerClaimResponseSchema,
  EventConsumerParamsSchema,
  EventStreamQuerySchema,
  encodeAbi,
  ProjectionCriticalTaskRunEventSchemaByType,
  TaskRunEventSchema,
  TaskRunParamsSchema,
  type EventConsumerParams,
  type KnownTaskRunEventType,
  type TaskRunParams,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { requestIdOf, successEnvelope, V1HttpError } from "./errors.js";
import { mapEventConsumerCursor, mapTaskRunEvent } from "./mappers.js";
import { authorizeChannel, conflict, decodeQuery, missing, requireChannelTaskRun } from "./route-support.js";
import { SseWritePump } from "./sse-write-pump.js";

const EVENT_REPLAY_BATCH_SIZE = 256;
const EVENT_REPLAY_BUFFER_LIMIT = 1_000;
const EVENT_REPLAY_SLICE_EVENTS = 32;
const EVENT_REPLAY_SLICE_MS = 10;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function registerEventV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const { persistence, service, serviceCredentials } = dependencies;
  const { eventConsumers, taskRuns } = persistence;

  app.post("/api/v1/task-runs/:taskRunId/event-consumers/:consumerId/claim", {
    onRequest: authorizeChannel(serviceCredentials, "events:consume"),
    schema: { params: EventConsumerParamsSchema },
  }, async (request) => {
    const { taskRunId, consumerId } = request.params as EventConsumerParams;
    requireChannelTaskRun(request, taskRuns, taskRunId);
    return encodeAbi(
      EventConsumerClaimResponseSchema,
      successEnvelope(request, {
        cursor: mapEventConsumerCursor(eventConsumers.claimEventConsumer(taskRunId, consumerId)),
      }),
    );
  });

  app.get("/api/v1/task-runs/:taskRunId/events", {
    onRequest: authorizeChannel(serviceCredentials, "events:consume"),
    schema: { params: TaskRunParamsSchema },
  }, async (request, reply) => {
    const { taskRunId } = request.params as TaskRunParams;
    const rawQuery = request.query as { consumerId?: string; generation?: string; after?: string };
    const query = decodeQuery(EventStreamQuerySchema, {
      consumerId: rawQuery.consumerId,
      generation: Number(rawQuery.generation),
      ...(rawQuery.after === undefined ? {} : { after: Number(rawQuery.after) }),
    });
    requireChannelTaskRun(request, taskRuns, taskRunId);
    const cursor = eventConsumers.getEventConsumer(taskRunId, query.consumerId);
    if (!cursor || cursor.generation !== query.generation) throw conflict("event_consumer.stale_generation", "Consumer generation is stale");
    if (query.after !== undefined && query.after > cursor.ackedSeq) {
      throw conflict(
        "event_consumer.cursor_mismatch",
        `Requested replay position ${query.after} is ahead of durable acknowledgement ${cursor.ackedSeq}`,
      );
    }
    // The durable acknowledgement is authoritative. An older local cursor may
    // replay duplicates, but a client may never skip unacknowledged events.
    const replayAfter = cursor.ackedSeq;
    const inheritedHeaders = Object.fromEntries(
      Object.entries(reply.getHeaders()).filter((entry) => entry[1] !== undefined),
    ) as OutgoingHttpHeaders;
    reply.hijack();
    const response = reply.raw;
    const responseHeaders: OutgoingHttpHeaders = { ...inheritedHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Request-Id": requestIdOf(request) };
    response.writeHead(200, responseHeaders);
    let unsubscribe = () => {};
    let closed = false;
    let replaying = true;
    const buffered: ReturnType<typeof service.replay> = [];
    let bufferedOffset = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let writer: SseWritePump | undefined;
    const closeStream = (): void => {
      if (closed) return;
      closed = true;
      writer?.stop();
      if (heartbeat) clearInterval(heartbeat);
      try { unsubscribe(); } catch { /* stream closure must remain deterministic */ }
      if (!response.writableEnded) response.end();
    };
    writer = new SseWritePump(response, {
      maxPending: EVENT_REPLAY_BUFFER_LIMIT,
      onError: closeStream,
      onOverflow: closeStream,
    });
    response.once("close", closeStream);
    response.on("error", closeStream);
    const generationIsCurrent = (): boolean =>
      eventConsumers.getEventConsumer(taskRunId, query.consumerId)?.generation === query.generation;
    const frame = (event: ReturnType<typeof service.replay>[number]): string => {
      const publicEvent = mapTaskRunEvent(event);
      const schema = ProjectionCriticalTaskRunEventSchemaByType[publicEvent.type as KnownTaskRunEventType];
      if (!schema) throw new Error(`Unsupported public TaskRun event type: ${publicEvent.type}`);
      const projected = encodeAbi(schema, publicEvent as never);
      const mapped = encodeAbi(TaskRunEventSchema, projected as never);
      return `id: ${mapped.eventId}\ndata: ${JSON.stringify(mapped)}\n\n`;
    };
    const send = (event: ReturnType<typeof service.replay>[number], live = false): Promise<boolean> => writer!.enqueue(() => {
      if (live) {
        if (!generationIsCurrent()) {
          closeStream();
          return undefined;
        }
      }
      try {
        return frame(event);
      } catch {
        closeStream();
        return undefined;
      }
    });
    let sliceEventCount = 0;
    let sliceStartedAt = performance.now();
    const yieldReplaySlice = async (): Promise<boolean> => {
      sliceEventCount += 1;
      if (sliceEventCount < EVENT_REPLAY_SLICE_EVENTS
        && performance.now() - sliceStartedAt < EVENT_REPLAY_SLICE_MS) return true;
      await yieldToEventLoop();
      sliceEventCount = 0;
      sliceStartedAt = performance.now();
      if (closed) return false;
      if (!generationIsCurrent()) {
        closeStream();
        return false;
      }
      return true;
    };
    try {
      const subscribed = service.subscribe(taskRunId, (event) => {
        if (replaying) {
          if (buffered.length - bufferedOffset >= EVENT_REPLAY_BUFFER_LIMIT) return closeStream();
          buffered.push(event);
        }
        else void send(event, true);
      });
      unsubscribe = subscribed;
      if (closed) {
        try { unsubscribe(); } catch { /* stream closure must remain deterministic */ }
        return;
      }
      const runState = taskRuns.getRunExecutionState(taskRunId);
      if (!runState) {
        closeStream();
        return;
      }
      const replayHighWatermark = runState.lastEventSeq;
      let deliveredSequence = replayAfter;
      while (deliveredSequence < replayHighWatermark) {
        const batch = service.replay(taskRunId, deliveredSequence, EVENT_REPLAY_BATCH_SIZE)
          .filter((event) => event.seq <= replayHighWatermark);
        if (!batch.length) break;
        for (const event of batch) {
          if (!await send(event)) return;
          deliveredSequence = event.seq;
          if (!await yieldReplaySlice()) return;
        }
      }
      while (bufferedOffset < buffered.length) {
        const event = buffered[bufferedOffset++]!;
        if (event.seq > deliveredSequence) {
          if (!await send(event)) return;
          deliveredSequence = event.seq;
          if (!await yieldReplaySlice()) return;
        }
        if (bufferedOffset >= EVENT_REPLAY_BATCH_SIZE) {
          buffered.splice(0, bufferedOffset);
          bufferedOffset = 0;
        }
      }
      replaying = false;
      buffered.length = 0;
    } catch {
      closeStream();
      return;
    }
    if (closed) return;
    heartbeat = setInterval(() => {
      try {
        if (!generationIsCurrent()) return closeStream();
        if (closed || writer!.backpressured || writer!.pendingCount > 0) return;
        void writer!.enqueue(() => ": heartbeat\n\n");
      } catch {
        closeStream();
      }
    }, 15_000);
    request.raw.on("close", closeStream);
  });

  app.post("/api/v1/task-runs/:taskRunId/event-consumers/:consumerId/ack", {
    onRequest: authorizeChannel(serviceCredentials, "events:consume"),
    schema: {
      params: EventConsumerParamsSchema,
      body: EventConsumerAckRequestSchema,
    },
  }, async (request) => {
    const { taskRunId, consumerId } = request.params as EventConsumerParams;
    requireChannelTaskRun(request, taskRuns, taskRunId);
    const body = decodeAbi(EventConsumerAckRequestSchema, request.body);
    const status = eventConsumers.ackEventConsumer(taskRunId, consumerId, body.generation, body.sequence);
    if (status === "missing") throw missing("task_run");
    if (status === "stale") throw conflict("event_consumer.stale_generation", "Consumer generation is stale");
    if (status === "invalid") throw new V1HttpError(400, "event_consumer.invalid_acknowledgement", "Acknowledgement sequence is invalid", "validation");
    return encodeAbi(
      EventConsumerAckResponseSchema,
      successEnvelope(request, {
        status: "accepted" as const,
        cursor: mapEventConsumerCursor(eventConsumers.getEventConsumer(taskRunId, consumerId)!),
      }),
    );
  });
}
