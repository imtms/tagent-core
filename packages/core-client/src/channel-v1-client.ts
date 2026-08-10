import type {
  ArtifactContent,
  ArtifactListResponse,
  CommandReceipt,
  CoreCapabilities,
  EventConsumerAckRequest,
  EventConsumerCursor,
  EventStreamQuery,
  Session,
  SessionCreateRequest,
  SubmissionCreateRequest,
  SubmissionReceipt,
  TaskRun,
  TaskRunArtifact,
  TaskRunCommand,
  TaskRunEvent,
  TaskRunInteractionsResponse,
  TranscriptItem,
  TranscriptResponse,
} from "@tagent/abi";
import { loadCoreAbi, type CoreAbi } from "./abi-loader.js";
import { CoreClientError, protocolError } from "./errors.js";
import { OperatorReadClient } from "./operator-read-v1-client.js";
import { decodeJsonSse } from "./sse.js";
import type { CoreClientOptions, CoreSseOptions, CoreSseSubscription } from "./transport.js";

export type {
  ArtifactContent,
  ArtifactListResponse,
  CommandReceipt,
  CoreCapabilities,
  ConsoleCreateWorkspaceGoalRequest,
  ConsoleDecideWorkspaceGoalRequest,
  ConsoleGenerateWorkspaceGoalRoadmapRequest,
  ConsoleReviseWorkspaceGoalDefinitionRequest,
  ConsoleReviseWorkspaceGoalRoadmapRequest,
  ConsoleStartWorkspaceGoalTaskRunRequest,
  ConsoleStartWorkspaceGoalTaskRunResult,
  ConsoleWorkspaceGoal,
  ConsoleWorkspaceGoalOperationReceipt,
  ConsoleWorkspaceGoalRevision,
  ConsoleWorkspaceGoalSummary,
  EventConsumerCursor,
  Session,
  SessionCreateRequest,
  SubmissionCreateRequest,
  SubmissionReceipt,
  TaskRun,
  TaskRunArtifact,
  TaskRunCommand,
  TaskRunEvent,
  TaskRunInteractionsResponse,
  TranscriptItem,
  TranscriptResponse,
  OperatorReadCapabilities,
  OperatorSessionListResponse,
  OperatorSessionTaskRunListResponse,
  OperatorTaskRunSummary,
} from "@tagent/abi";

export interface TaskRunEventSseOptions extends Omit<CoreSseOptions<TaskRunEvent>, "decode"> {
  after?: number;
  consumerId: string;
  generation: number;
}

function validateRequest<T>(method: string, url: string, input: unknown, decode: (value: unknown) => T): T {
  try {
    return decode(input);
  } catch (error) {
    throw protocolError(method, url, `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
  }
}

function decodeSuccessData<T>(abi: CoreAbi, payload: unknown, decode: (data: unknown) => T): T {
  const envelope = abi.decodeAbi(abi.SuccessEnvelopeSchema, payload);
  return decode(envelope.data);
}

function encodePathSegment(value: string): string { return encodeURIComponent(value); }

function validateEventStreamQueryInput(url: string, query: EventStreamQuery): EventStreamQuery {
  const validConsumerId = typeof query.consumerId === "string" && query.consumerId.length >= 1 && query.consumerId.length <= 256;
  const validGeneration = Number.isSafeInteger(query.generation) && query.generation >= 1;
  const validAfter = query.after === undefined || (Number.isSafeInteger(query.after) && query.after >= 0);
  if (!validConsumerId || !validGeneration || !validAfter) {
    throw protocolError("GET", url, "TAgent Core request validation failed: invalid event stream query");
  }
  return query;
}

export class CoreClient extends OperatorReadClient {
  async getCapabilities(): Promise<CoreCapabilities> {
    const abi = await loadCoreAbi();
    return this.request("/api/v1/capabilities", { decode: (payload) => abi.decodeAbi(abi.CoreCapabilitiesResponseSchema, payload).data });
  }
  async createSession(input: SessionCreateRequest = {}): Promise<Session> {
    return this.createSessionIdempotent(crypto.randomUUID(), input);
  }
  async createSessionIdempotent(idempotencyKey: string, input: SessionCreateRequest = {}): Promise<Session> {
    const abi = await loadCoreAbi();
    const path = "/api/v1/sessions";
    const body = validateRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.SessionCreateRequestSchema, value));
    return this.request(path, {
      decode: (payload) => decodeSuccessData(abi, payload, (data) => abi.decodeAbi(abi.SessionSchema, data)),
      idempotencyKey,
      json: body,
      method: "POST",
    });
  }
  async getSession(sessionId: string): Promise<Session> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/sessions/${encodePathSegment(sessionId)}`;
    return this.request(path, {
      decode: (payload) => decodeSuccessData(abi, payload, (data) => abi.decodeAbi(abi.SessionSchema, data)),
    });
  }
  async submit(sessionId: string, idempotencyKey: string, input: SubmissionCreateRequest): Promise<SubmissionReceipt> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/sessions/${encodePathSegment(sessionId)}/submissions`;
    const body = validateRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.SubmissionCreateRequestSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.SubmissionResponseSchema, payload).data.receipt,
      idempotencyKey,
      json: body,
      method: "POST",
    });
  }

  async createSubmission(sessionId: string, idempotencyKey: string, input: SubmissionCreateRequest): Promise<SubmissionReceipt> {
    return this.submit(sessionId, idempotencyKey, input);
  }

  async getSubmission(sessionId: string, idempotencyKey: string): Promise<SubmissionReceipt> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/sessions/${encodePathSegment(sessionId)}/submissions/${encodePathSegment(idempotencyKey)}`;
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.SubmissionResponseSchema, payload).data.receipt,
    });
  }

  async getTaskRun(taskRunId: string): Promise<TaskRun> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/task-runs/${encodePathSegment(taskRunId)}`;
    return this.request(path, {
      decode: (payload) => decodeSuccessData(abi, payload, (data) => abi.decodeAbi(abi.TaskRunSchema, data)),
    });
  }

  async sendTaskRunCommand(taskRunId: string, input: TaskRunCommand): Promise<CommandReceipt> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/commands`;
    const body = validateRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.TaskRunCommandSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.CommandResponseSchema, payload).data.receipt,
      idempotent: true,
      json: body,
      method: "POST",
      requestId: body.commandId,
    });
  }

  async getTaskRunCommand(taskRunId: string, commandId: string): Promise<CommandReceipt> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/commands/${encodePathSegment(commandId)}`;
    return this.request(path, { decode: (payload) => abi.decodeAbi(abi.CommandResponseSchema, payload).data.receipt });
  }

  async getTranscript(taskRunId: string): Promise<TranscriptItem[]> {
    const items: TranscriptItem[] = [];
    let after: number | undefined;
    do {
      const page = await this.getTranscriptPage(taskRunId, { after, limit: 500 });
      items.push(...page.data.items);
      after = page.data.pageInfo.nextCursor ?? undefined;
      if (!page.data.pageInfo.hasMore) break;
    } while (after !== undefined);
    return items;
  }

  async getTaskRunInteractions(taskRunId: string, options: { after?: number; limit?: number } = {}): Promise<TaskRunInteractionsResponse> {
    const abi = await loadCoreAbi();
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set("after", String(options.after));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const basePath = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/interactions`;
    const path = query.size ? `${basePath}?${query}` : basePath;
    return this.request(path, { decode: (payload) => abi.decodeAbi(abi.TaskRunInteractionsResponseSchema, payload) });
  }

  async getTranscriptPage(taskRunId: string, options: { after?: number; limit?: number } = {}): Promise<TranscriptResponse> {
    const abi = await loadCoreAbi();
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set("after", String(options.after));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const basePath = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/transcript`;
    const path = query.size ? `${basePath}?${query}` : basePath;
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.TranscriptResponseSchema, payload),
    });
  }

  async listArtifacts(taskRunId: string): Promise<TaskRunArtifact[]> {
    const items: TaskRunArtifact[] = [];
    let after: number | undefined;
    do {
      const page = await this.getArtifactsPage(taskRunId, { after, limit: 200 });
      items.push(...page.data.items);
      after = page.data.pageInfo.nextCursor ?? undefined;
      if (!page.data.pageInfo.hasMore) break;
    } while (after !== undefined);
    return items;
  }

  async getArtifactsPage(taskRunId: string, options: { after?: number; limit?: number } = {}): Promise<ArtifactListResponse> {
    const abi = await loadCoreAbi();
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set("after", String(options.after));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const basePath = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/artifacts`;
    const path = query.size ? `${basePath}?${query}` : basePath;
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ArtifactListResponseSchema, payload),
    });
  }

  async getArtifactContent(taskRunId: string, artifactId: string): Promise<ArtifactContent> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/artifacts/${encodePathSegment(artifactId)}/content`;
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ArtifactContentResponseSchema, payload).data.artifact,
    });
  }

  async claimEventConsumer(taskRunId: string, consumerId: string): Promise<EventConsumerCursor> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/event-consumers/${encodePathSegment(consumerId)}/claim`;
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.EventConsumerClaimResponseSchema, payload).data.cursor,
      method: "POST",
    });
  }

  async ackEventConsumer(taskRunId: string, consumerId: string, input: EventConsumerAckRequest): Promise<EventConsumerCursor> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/event-consumers/${encodePathSegment(consumerId)}/ack`;
    const body = validateRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.EventConsumerAckRequestSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.EventConsumerAckResponseSchema, payload).data.cursor,
      idempotent: true,
      json: body,
      method: "POST",
    });
  }

  subscribeTaskRunEvents(taskRunId: string, options: TaskRunEventSseOptions): CoreSseSubscription {
    const { after, consumerId, generation, ...sseOptions } = options;
    const path = `/api/v1/task-runs/${encodePathSegment(taskRunId)}/events`;
    const queryInput = validateEventStreamQueryInput(this.resolve(path), {
      ...(after === undefined ? {} : { after }),
      consumerId,
      generation,
    });
    let activeSubscription: CoreSseSubscription | undefined;
    let closed = false;
    const completed = (async (): Promise<void> => {
      let started = false;
      try {
        const abi = await loadCoreAbi();
        if (closed) return;
        const query = validateRequest<EventStreamQuery>("GET", this.resolve(path), queryInput, (value) => abi.decodeAbi(abi.EventStreamQuerySchema, value));
        const search = new URLSearchParams({ consumerId: query.consumerId, generation: String(query.generation) });
        if (query.after !== undefined) search.set("after", String(query.after));
        activeSubscription = this.subscribeSse(`${path}?${search}`, {
          ...sseOptions,
          decode: decodeJsonSse((payload) => abi.decodeAbi(abi.TaskRunEventSchema, payload)),
        });
        started = true;
        if (closed) activeSubscription.close();
        await activeSubscription.completed;
      } catch (error) {
        if (closed) return;
        if (started) throw error;
        const clientError = error instanceof CoreClientError ? error : protocolError("GET", this.resolve(`/api/v1/task-runs/${encodePathSegment(taskRunId)}/events`), error instanceof Error ? error.message : String(error), "", {}, error);
        options.onError?.(clientError);
        throw clientError;
      }
    })();
    return {
      close: (): void => {
        closed = true;
        activeSubscription?.close();
      },
      completed,
    };
  }
}

export function createCoreClient(options: CoreClientOptions = {}): CoreClient { return new CoreClient(options); }
