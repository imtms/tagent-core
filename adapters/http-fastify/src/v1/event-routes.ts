import type { FastifyInstance } from "fastify";
import {
  decodeAbi,
  EventConsumerAckRequestSchema,
  EventConsumerAckResponseSchema,
  EventConsumerClaimResponseSchema,
  EventConsumerParamsSchema,
  EventStreamQuerySchema,
  encodeAbi,
  ProjectionCriticalTaskRunEventSchema,
  TaskRunEventSchema,
  TaskRunParamsSchema,
  type EventConsumerParams,
  type TaskRunParams,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { requestIdOf, successEnvelope, V1HttpError } from "./errors.js";
import { mapEventConsumerCursor, mapTaskRunEvent } from "./mappers.js";
import { authorizeChannel, conflict, decodeQuery, missing } from "./route-support.js";

export function registerEventV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const { persistence, service, serviceCredentials } = dependencies;
  const { eventConsumers } = persistence;

  app.post("/api/v1/task-runs/:taskRunId/event-consumers/:consumerId/claim", {
    onRequest: authorizeChannel(serviceCredentials, "events:consume"),
    schema: { params: EventConsumerParamsSchema },
  }, async (request) => {
    const { taskRunId, consumerId } = request.params as EventConsumerParams;
    if (!service.getRun(taskRunId)) throw missing("task_run");
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
    if (!service.getRun(taskRunId)) throw missing("task_run");
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
    const replayHighWatermark = service.getRun(taskRunId)!.lastEventSeq;
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Request-Id": requestIdOf(request) });
    let unsubscribe = () => {};
    let closed = false;
    let replaying = true;
    const buffered: ReturnType<typeof service.replay> = [];
    const closeStream = (): void => {
      if (closed) return;
      closed = true;
      try { unsubscribe(); } catch { /* stream closure must remain deterministic */ }
      if (!response.writableEnded) response.end();
    };
    const send = (event: ReturnType<typeof service.replay>[number]): boolean => {
      try {
        if (eventConsumers.getEventConsumer(taskRunId, query.consumerId)?.generation !== query.generation) {
          closeStream();
          return false;
        }
        const projected = encodeAbi(ProjectionCriticalTaskRunEventSchema, mapTaskRunEvent(event) as never);
        const mapped = encodeAbi(TaskRunEventSchema, projected as never);
        const accepted = response.write(`id: ${mapped.eventId}\ndata: ${JSON.stringify(mapped)}\n\n`);
        if (!accepted) closeStream();
        return accepted;
      } catch {
        closeStream();
        return false;
      }
    };
    try {
      const subscribed = service.subscribe(taskRunId, (event) => {
        if (replaying) {
          if (buffered.length >= 1_000) return closeStream();
          buffered.push(event);
        }
        else send(event);
      });
      unsubscribe = subscribed;
      if (closed) {
        try { unsubscribe(); } catch { /* stream closure must remain deterministic */ }
        return;
      }
      let deliveredSequence = replayAfter;
      while (deliveredSequence < replayHighWatermark) {
        const batch = service.replay(taskRunId, deliveredSequence, 256)
          .filter((event) => event.seq <= replayHighWatermark);
        if (!batch.length) break;
        for (const event of batch) {
          if (!send(event)) return;
          deliveredSequence = event.seq;
        }
      }
      replaying = false;
      for (const event of buffered) {
        if (event.seq > deliveredSequence && !send(event)) return;
      }
    } catch {
      closeStream();
      return;
    }
    if (closed) return;
    const heartbeat = setInterval(() => { if (!response.write(": heartbeat\n\n")) closeStream(); }, 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      closeStream();
    });
  });

  app.post("/api/v1/task-runs/:taskRunId/event-consumers/:consumerId/ack", {
    onRequest: authorizeChannel(serviceCredentials, "events:consume"),
    schema: {
      params: EventConsumerParamsSchema,
      body: EventConsumerAckRequestSchema,
    },
  }, async (request) => {
    const { taskRunId, consumerId } = request.params as EventConsumerParams;
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
