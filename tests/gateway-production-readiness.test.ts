import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeAbi,
  EventConsumerAckResponseSchema,
  EventConsumerClaimResponseSchema,
  SubmissionResponseSchema,
  TaskRunEventSchema,
  type EventConsumerCursor,
  type SubmissionReceipt,
  type TaskRunEvent,
} from "@tagent/abi";
import {
  createCoreClient,
  createReplayAckCoordinator,
  type CoreClient,
  type CoreFetch,
} from "@tagent/core-client";
import { createApp } from "@tagent/http-fastify";
import { loadConfig } from "@tagent/core-service/config";
import { ShadowLearningProjectionWorker } from "@tagent/learning/application";
import { ATTEMPT_SCHEMA_V30_SQL } from "@tagent/persistence-sqlite/migrations";
import { createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite/sqlite";
import { Store } from "@tagent/persistence-sqlite/store";
import {
  acquireCoreInstanceLock,
  CoreWriterLease,
  WriterAuthorityLostError,
  WriterAuthorityUnavailableError,
  WriterFenceGuard,
} from "@tagent/persistence-sqlite/writer";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-05T00:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": "fake-core-request" },
  });
}

function errorResponse(status: number, code: string, details: Record<string, unknown> = {}): Response {
  return jsonResponse({
    error: {
      code,
      details,
      message: code.replaceAll(".", " "),
      requestId: "fake-core-request",
      retryable: false,
    },
  }, status);
}

interface ConsumerState {
  acknowledgedSequence: number;
  generation: number;
  terminalAcknowledgedSequence: number | null;
}

interface DeliveryContext {
  consumerId: string;
  generation: number;
  taskRunId: string;
}

interface GatewayDeliveryReceipt extends DeliveryContext {
  eventId: string;
  sequence: number;
}

function receiptKey(receipt: GatewayDeliveryReceipt): string {
  return `${receipt.taskRunId}:${receipt.consumerId}:g${receipt.generation}:${receipt.sequence}:${receipt.eventId}`;
}

class FakeGatewayDurableStore {
  readonly acknowledgedReceipts = new Set<string>();
  readonly deliveries = new Map<string, TaskRunEvent>();
  readonly operationLog: string[] = [];
  readonly receipts = new Map<string, GatewayDeliveryReceipt>();
  deliveryWrites = 0;
  receiptWrites = 0;

  persist(event: TaskRunEvent, context: DeliveryContext): void {
    const receipt = {
      ...context,
      eventId: event.eventId,
      sequence: event.sequence,
    };
    const key = receiptKey(receipt);
    if (this.receipts.has(key)) return;
    const operation = this.deliveries.has(event.eventId) ? "promote" : "persist";
    if (operation === "persist") {
      this.deliveries.set(event.eventId, event);
      this.deliveryWrites += 1;
    }
    this.receipts.set(key, receipt);
    this.receiptWrites += 1;
    this.operationLog.push(`${operation}:${key}`);
  }

  hasExactReceipt(receipt: GatewayDeliveryReceipt): boolean {
    return this.receipts.has(receiptKey(receipt));
  }

  beforeAck(receipt: GatewayDeliveryReceipt): void {
    this.operationLog.push(`ack:${receiptKey(receipt)}`);
  }

  markAcknowledged(receipt: GatewayDeliveryReceipt): void {
    this.acknowledgedReceipts.add(receiptKey(receipt));
  }

  unacknowledgedReceipts(): GatewayDeliveryReceipt[] {
    return [...this.receipts.entries()]
      .filter(([key]) => !this.acknowledgedReceipts.has(key))
      .map(([, receipt]) => receipt);
  }
}

class FakeCore {
  readonly acceptedAcks: GatewayDeliveryReceipt[] = [];
  readonly outbox: TaskRunEvent[] = [];
  readonly requestedPaths: string[] = [];
  readonly submissionAttempts = new Map<string, number>();
  readonly submissions = new Map<string, SubmissionReceipt>();
  readonly consumers = new Map<string, ConsumerState>();
  duplicateTerminalDelivery = true;
  gatewayDurability: FakeGatewayDurableStore | null = null;
  private submissionOrdinal = 0;

  readonly fetch: CoreFetch = async (input, init) => {
    const url = new URL(input);
    this.requestedPaths.push(url.pathname);
    if (!url.pathname.startsWith("/api/v1/")) return errorResponse(404, "route.not_found");
    if (new Headers(init?.headers).get("Authorization") !== "Bearer gateway-core-credential") {
      return errorResponse(401, "auth.unauthenticated");
    }

    const submission = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/submissions$/);
    if (submission && init?.method === "POST") {
      const sessionId = decodeURIComponent(submission[1]!);
      const idempotencyKey = new Headers(init.headers).get("Idempotency-Key") ?? "";
      this.submissionAttempts.set(idempotencyKey, (this.submissionAttempts.get(idempotencyKey) ?? 0) + 1);
      let receipt = this.submissions.get(idempotencyKey);
      if (!receipt) {
        this.submissionOrdinal += 1;
        const taskRunId = `task-run-${this.submissionOrdinal}`;
        receipt = {
          idempotencyKey,
          sessionId,
          submissionId: `submission-${this.submissionOrdinal}`,
          status: "started",
          taskRunId,
          error: null,
          audit: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.submissions.set(idempotencyKey, receipt);
        this.outbox.push(
          this.event(taskRunId, 1, "task_run.started", { source: "submission" }),
          this.event(taskRunId, 2, "task_run.completed", { response: "done" }),
        );
        throw new TypeError("connection reset after Core commit");
      }
      return jsonResponse(encodeAbi(SubmissionResponseSchema, {
        data: { receipt },
        requestId: "fake-core-request",
      }));
    }

    const claim = url.pathname.match(/^\/api\/v1\/task-runs\/([^/]+)\/event-consumers\/([^/]+)\/claim$/);
    if (claim && init?.method === "POST") {
      const taskRunId = decodeURIComponent(claim[1]!);
      const consumerId = decodeURIComponent(claim[2]!);
      const key = `${taskRunId}:${consumerId}`;
      const current = this.consumers.get(key);
      const next: ConsumerState = {
        acknowledgedSequence: current?.acknowledgedSequence ?? 0,
        generation: (current?.generation ?? 0) + 1,
        terminalAcknowledgedSequence: current?.terminalAcknowledgedSequence ?? null,
      };
      this.consumers.set(key, next);
      return jsonResponse(encodeAbi(EventConsumerClaimResponseSchema, {
        data: { cursor: this.cursor(taskRunId, consumerId, next) },
        requestId: "fake-core-request",
      }));
    }

    const ack = url.pathname.match(/^\/api\/v1\/task-runs\/([^/]+)\/event-consumers\/([^/]+)\/ack$/);
    if (ack && init?.method === "POST") {
      const taskRunId = decodeURIComponent(ack[1]!);
      const consumerId = decodeURIComponent(ack[2]!);
      const key = `${taskRunId}:${consumerId}`;
      const current = this.consumers.get(key);
      const body = JSON.parse(String(init.body)) as { generation: number; sequence: number };
      if (!current) return errorResponse(404, "task_run.not_found");
      if (body.generation !== current.generation) {
        return errorResponse(409, "event_consumer.stale_generation", {
          acknowledgedSequence: current.acknowledgedSequence,
          currentGeneration: current.generation,
        });
      }
      const event = this.outbox.find((candidate) =>
        candidate.aggregateId === taskRunId && candidate.sequence === body.sequence);
      const durableReceipt = event ? {
        consumerId,
        eventId: event.eventId,
        generation: body.generation,
        sequence: body.sequence,
        taskRunId,
      } : null;
      if (!durableReceipt || !this.gatewayDurability?.hasExactReceipt(durableReceipt)) {
        return errorResponse(409, "gateway.delivery_not_durable", {
          eventId: event?.eventId ?? null,
          generation: body.generation,
          sequence: body.sequence,
        });
      }
      current.acknowledgedSequence = Math.max(current.acknowledgedSequence, body.sequence);
      if (event?.type === "task_run.completed") current.terminalAcknowledgedSequence = body.sequence;
      this.acceptedAcks.push(durableReceipt);
      this.gatewayDurability.markAcknowledged(durableReceipt);
      return jsonResponse(encodeAbi(EventConsumerAckResponseSchema, {
        data: { status: "accepted", cursor: this.cursor(taskRunId, consumerId, current) },
        requestId: "fake-core-request",
      }));
    }

    const stream = url.pathname.match(/^\/api\/v1\/task-runs\/([^/]+)\/events$/);
    if (stream && init?.method === "GET") {
      const taskRunId = decodeURIComponent(stream[1]!);
      const consumerId = url.searchParams.get("consumerId") ?? "";
      const generation = Number(url.searchParams.get("generation"));
      const after = Number(url.searchParams.get("after") ?? 0);
      const current = this.consumers.get(`${taskRunId}:${consumerId}`);
      if (!current || current.generation !== generation) {
        return errorResponse(409, "event_consumer.stale_generation");
      }
      const watermark = Math.max(after, current.acknowledgedSequence);
      const replay = this.outbox.filter((event) =>
        event.aggregateId === taskRunId && event.sequence > watermark);
      if (this.duplicateTerminalDelivery) {
        const terminal = replay.find((event) => event.type === "task_run.completed");
        if (terminal) replay.push(terminal);
      }
      const body = replay.map((event) =>
        `id: ${event.eventId}\ndata: ${JSON.stringify(encodeAbi(TaskRunEventSchema, event))}\n\n`).join("");
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return errorResponse(404, "route.not_found");
  };

  consumer(taskRunId: string, consumerId: string): ConsumerState | undefined {
    const state = this.consumers.get(`${taskRunId}:${consumerId}`);
    return state ? { ...state } : undefined;
  }

  private cursor(taskRunId: string, consumerId: string, state: ConsumerState): EventConsumerCursor {
    return {
      taskRunId,
      consumerId,
      generation: state.generation,
      acknowledgedSequence: state.acknowledgedSequence,
      settledAcknowledgedSequence: state.terminalAcknowledgedSequence,
      finalAcknowledgedSequence: state.terminalAcknowledgedSequence,
      terminalAcknowledgedSequence: state.terminalAcknowledgedSequence,
      claimedAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private event(
    taskRunId: string,
    sequence: number,
    type: string,
    payload: Record<string, unknown>,
  ): TaskRunEvent {
    return {
      specVersion: "1.0",
      eventId: `task_run:${taskRunId}:${sequence}`,
      aggregateType: "task_run",
      aggregateId: taskRunId,
      sequence,
      type,
      occurredAt: timestamp,
      correlationId: null,
      causationId: null,
      payload,
    };
  }
}

class FakeGateway {
  readonly coordinator;
  private crashTriggered = false;
  private readonly eventsBySequence = new Map<number, TaskRunEvent>();

  constructor(
    private readonly client: CoreClient,
    private readonly durability: FakeGatewayDurableStore,
    private readonly taskRunId: string,
    private readonly consumerId: string,
    private readonly generation: number,
    initialAcknowledgedSequence: number,
    private readonly crashBeforeAckSequence: number | null = null,
  ) {
    this.coordinator = createReplayAckCoordinator<TaskRunEvent>({
      initialAcknowledgedSequence,
      sequence: (event) => event.sequence,
      persist: async (event) => {
        this.eventsBySequence.set(event.sequence, event);
        this.durability.persist(event, this.deliveryContext());
      },
      ack: async (sequence) => {
        const event = this.eventsBySequence.get(sequence);
        if (!event) throw new Error(`missing event ${sequence} before ACK`);
        if (!this.crashTriggered && sequence === this.crashBeforeAckSequence) {
          this.crashTriggered = true;
          throw new Error("simulated Gateway crash after terminal persist and before ACK");
        }
        const receipt = { ...this.deliveryContext(), eventId: event.eventId, sequence };
        this.durability.beforeAck(receipt);
        await this.client.ackEventConsumer(this.taskRunId, this.consumerId, {
          generation: this.generation,
          sequence,
        });
      },
    });
  }

  async replay(): Promise<void> {
    const subscription = this.client.subscribeTaskRunEvents(this.taskRunId, {
      consumerId: this.consumerId,
      generation: this.generation,
      after: 0,
      onMessage: (event) => this.coordinator.handle(event).then(() => undefined),
    });
    await subscription.completed;
    await this.coordinator.idle();
  }

  private deliveryContext(): DeliveryContext {
    return {
      consumerId: this.consumerId,
      generation: this.generation,
      taskRunId: this.taskRunId,
    };
  }
}

function createV30DatabaseFixture(filename: string): void {
  const db = new Database(filename);
  try {
    db.exec(`
      CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ${ATTEMPT_SCHEMA_V30_SQL}
      INSERT INTO schema_meta (id,version,updated_at) VALUES (1,30,1);
    `);
  } finally {
    db.close();
  }
}

function schemaInventory(store: Store): Array<{ name: string; type: string; sql: string | null }> {
  return store.db.prepare(`SELECT name,type,sql FROM sqlite_master
    WHERE name IN (
      'attempts',
      'approval_receipts',
      'idx_operations_attempt_created',
      'idx_runs_operator_session_created',
      'idx_runs_operator_session_updated',
      'idx_sessions_operator_created',
      'integration_outbox',
      'integration_consumer_delivery',
      'learning_projection_checkpoint',
      'learning_projection_authority_state'
    ) ORDER BY name`).all() as Array<{ name: string; type: string; sql: string | null }>;
}

function createCoreReleaseFixture(directory: string): void {
  const manifestScript = path.resolve("scripts/release-manifest.mjs");
  const readinessProbe = path.resolve("scripts/gateway-readiness-probe.mjs");
  for (const relative of [
    "dist/memory/postgres",
    "scripts",
    "node_modules/better-sqlite3/build/Release",
  ]) mkdirSync(path.join(directory, relative), { recursive: true });

  copyFileSync(path.resolve("package.json"), path.join(directory, "package.json"));
  copyFileSync(path.resolve("package-lock.json"), path.join(directory, "package-lock.json"));
  writeFileSync(path.join(directory, "dist/server.js"), "export {};\n");
  copyFileSync(
    path.resolve("packages/memory/dist/postgres/schema.sql"),
    path.join(directory, "dist/memory/postgres/schema.sql"),
  );
  copyFileSync(path.resolve("scripts/deploy-release.sh"), path.join(directory, "scripts/deploy-release.sh"));
  writeFileSync(path.join(directory, "scripts/release-manifest.mjs"), readFileSync(manifestScript));
  writeFileSync(path.join(directory, "scripts/gateway-readiness-probe.mjs"), readFileSync(readinessProbe));

  const workspaces = [
    ["@tagent/abi", "packages/abi"],
    ["@tagent/admission", "packages/admission"],
    ["@tagent/core-service", "apps/core-service"],
    ["@tagent/execution", "packages/execution"],
    ["@tagent/governance", "packages/governance"],
    ["@tagent/http-fastify", "adapters/http-fastify"],
    ["@tagent/learning", "packages/learning"],
    ["@tagent/memory", "packages/memory"],
    ["@tagent/persistence-sqlite", "adapters/persistence-sqlite"],
    ["@tagent/runtime-pi", "adapters/runtime-pi"],
    ["@tagent/workspace-local", "adapters/workspace-local"],
  ] as const;
  for (const [packageName, workspace] of workspaces) {
    const target = path.join(directory, "node_modules", packageName);
    mkdirSync(target, { recursive: true });
    copyFileSync(path.resolve(workspace, "package.json"), path.join(target, "package.json"));
    cpSync(path.resolve(workspace, "dist"), path.join(target, "dist"), { recursive: true });
  }
  chmodSync(
    path.join(directory, "node_modules/@tagent/workspace-local/dist/workspace-fd-helper.py"),
    0o755,
  );

  const require = createRequire(import.meta.url);
  const betterSqliteRoot = path.resolve(path.dirname(require.resolve("better-sqlite3")), "..");
  writeFileSync(path.join(directory, "node_modules/better-sqlite3/package.json"), JSON.stringify({
    main: "index.cjs",
  }));
  writeFileSync(
    path.join(directory, "node_modules/better-sqlite3/index.cjs"),
    `module.exports = require(${JSON.stringify(betterSqliteRoot)});\n`,
  );
  copyFileSync(
    path.join(betterSqliteRoot, "build/Release/better_sqlite3.node"),
    path.join(directory, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
  );
}

function runChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });
}

describe("Gateway production readiness", () => {
  it("preserves a scoped production principal through internal v1 authorization and canonical validation", async () => {
    const token = "gateway-production-internal-token";
    const config = loadConfig({
      TAGENT_API_BASE: "https://models.internal/v1",
      TAGENT_MEMORY_ENABLED: "false",
      TAGENT_MODEL: "gpt-5.6-sol",
      TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{
        token,
        scopes: ["internal", "runs:read"],
        principal: {
          subjectId: "gateway-production",
          resourceScopes: [{ type: "workspace", id: "production" }],
        },
      }]),
    });
    expect(config.serviceCredentials).toEqual([{
      token,
      scopes: ["internal", "runs:read"],
      principal: {
        subjectId: "gateway-production",
        resourceScopes: [{ type: "workspace", id: "production" }],
      },
    }]);

    let evaluationInput: unknown;
    const app = createApp({
      persistence: {} as never,
      service: {
        executeWorkflowEvaluation(input: unknown) {
          evaluationInput = input;
          return { id: "evaluation-1", status: "passed", receiptHash: "hash", signature: "signature" };
        },
        verifyWorkflowEvaluation: () => true,
      } as never,
      logger: false,
      serviceCredentials: config.serviceCredentials,
      onClose: async () => undefined,
    });
    try {
      const headers = { authorization: `Bearer ${token}`, "x-request-id": "gateway-request-1" };
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/internal/workflows/workflow-1/evaluate",
        headers,
        payload: {
          candidateRevisionId: "revision-candidate",
          baselineRevisionId: "revision-baseline",
          kind: "shadow",
          datasetId: "dataset-1",
          baselineRunIds: ["baseline-run-1"],
          candidateRunIds: ["candidate-run-1"],
        },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({
        data: { id: "evaluation-1", status: "passed", receiptHash: "hash", signature: "signature" },
        requestId: "gateway-request-1",
      });
      expect(evaluationInput).toEqual({
        workflowId: "workflow-1",
        candidateRevisionId: "revision-candidate",
        baselineRevisionId: "revision-baseline",
        kind: "shadow",
        datasetId: "dataset-1",
        baselineRunIds: ["baseline-run-1"],
        candidateRunIds: ["candidate-run-1"],
      });

      for (const payload of [
        {
          candidateRevisionId: "revision-candidate",
          baselineRevisionId: "revision-baseline",
          kind: "canary",
          datasetId: "dataset-1",
          baselineRunIds: ["baseline-run-1"],
          candidateRunIds: ["candidate-run-1"],
        },
        {
          candidateRevisionId: "revision-candidate",
          baselineRevisionId: "revision-baseline",
          kind: "shadow",
          datasetId: "dataset-1",
          baselineRunIds: [""],
          candidateRunIds: ["candidate-run-1"],
        },
      ]) {
        const rejected = await app.inject({
          method: "POST",
          url: "/api/v1/internal/workflows/workflow-1/evaluate",
          headers,
          payload,
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toMatchObject({
          error: { code: "request.validation_failed", requestId: "gateway-request-1" },
        });
      }
    } finally {
      await app.close();
    }

    expect(() => loadConfig({
      TAGENT_API_BASE: "https://models.internal/v1",
      TAGENT_MEMORY_ENABLED: "false",
      TAGENT_MODEL: "gpt-5.6-sol",
      TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{
        token,
        scopes: ["internal"],
        principal: { subjectId: "gateway-production", resourceScopes: [{ type: "tenant", id: "production" }] },
      }]),
    })).toThrow("principal.resourceScopes[0] is invalid");
  });

  it("returns a canonical v1 error envelope when CORS denies an origin", async () => {
    const previousOrigins = process.env.TAGENT_CORS_ALLOWED_ORIGINS;
    process.env.TAGENT_CORS_ALLOWED_ORIGINS = "https://gateway.example";
    const app = createApp({
      persistence: {} as never,
      service: {} as never,
      logger: false,
      serviceCredentials: [{ token: "gateway-production-internal-token", scopes: ["internal"] }],
      onClose: async () => undefined,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health",
        headers: { origin: "https://attacker.example", "x-request-id": "cors-request-1" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers["x-request-id"]).toBe("cors-request-1");
      expect(response.json()).toEqual({
        error: {
          code: "cors.origin_denied",
          message: "Cross-origin request is not allowed",
          requestId: "cors-request-1",
          retryable: false,
          details: {},
        },
      });
    } finally {
      await app.close();
      if (previousOrigins === undefined) delete process.env.TAGENT_CORS_ALLOWED_ORIGINS;
      else process.env.TAGENT_CORS_ALLOWED_ORIGINS = previousOrigins;
    }
  });

  it("survives response loss and persists the exact delivery before every public ACK", async () => {
    const core = new FakeCore();
    const client = createCoreClient({
      baseUrl: "https://fake-core.test",
      bearerToken: "gateway-core-credential",
      fetch: core.fetch,
      retry: { baseDelayMs: 0, maxAttempts: 2 },
    });
    const submission = await client.submit("session-1", "gateway-submission-1", {
      content: "run exactly once",
    });
    expect(submission).toMatchObject({
      submissionId: "submission-1",
      taskRunId: "task-run-1",
      status: "started",
    });
    expect(core.submissionAttempts.get("gateway-submission-1")).toBe(2);
    expect(core.submissions.size).toBe(1);
    expect(core.outbox.map((event) => event.type)).toEqual([
      "task_run.started",
      "task_run.completed",
    ]);

    const probe = await client.claimEventConsumer(submission.taskRunId!, "receipt-probe");
    const forgedDurability = new FakeGatewayDurableStore();
    forgedDurability.persist(
      { ...core.outbox[0]!, eventId: "forged-event-with-the-same-sequence" },
      {
        taskRunId: submission.taskRunId!,
        consumerId: "receipt-probe",
        generation: probe.generation,
      },
    );
    core.gatewayDurability = forgedDurability;
    await expect(client.ackEventConsumer(submission.taskRunId!, "receipt-probe", {
      generation: probe.generation,
      sequence: 1,
    })).rejects.toMatchObject({ code: "gateway.delivery_not_durable", status: 409 });

    const staleOne = await client.claimEventConsumer(submission.taskRunId!, "stale-client");
    const staleTwo = await client.claimEventConsumer(submission.taskRunId!, "stale-client");
    await expect(client.ackEventConsumer(submission.taskRunId!, "stale-client", {
      generation: staleOne.generation,
      sequence: 1,
    })).rejects.toMatchObject({ code: "event_consumer.stale_generation", status: 409 });
    expect(core.consumer(submission.taskRunId!, "stale-client")).toMatchObject({
      generation: staleTwo.generation,
      acknowledgedSequence: 0,
    });

    const durability = new FakeGatewayDurableStore();
    core.gatewayDurability = durability;
    const firstCursor = await client.claimEventConsumer(submission.taskRunId!, "gateway");
    const firstGateway = new FakeGateway(
      client,
      durability,
      submission.taskRunId!,
      "gateway",
      firstCursor.generation,
      firstCursor.acknowledgedSequence,
      2,
    );
    await expect(firstGateway.replay()).rejects.toThrow(
      "simulated Gateway crash after terminal persist and before ACK",
    );
    expect(core.consumer(submission.taskRunId!, "gateway")).toMatchObject({
      acknowledgedSequence: 1,
      terminalAcknowledgedSequence: null,
    });
    expect(durability.unacknowledgedReceipts()).toEqual([
      expect.objectContaining({
        eventId: `task_run:${submission.taskRunId}:2`,
        generation: firstCursor.generation,
        sequence: 2,
      }),
    ]);

    const restartCursor = await client.claimEventConsumer(submission.taskRunId!, "gateway");
    const restartedGateway = new FakeGateway(
      client,
      durability,
      submission.taskRunId!,
      "gateway",
      restartCursor.generation,
      restartCursor.acknowledgedSequence,
    );
    await restartedGateway.replay();
    expect(durability.deliveryWrites).toBe(2);
    expect(durability.receiptWrites).toBe(3);
    expect(core.acceptedAcks.map((ack) => ack.sequence)).toEqual([1, 2]);
    expect(core.consumer(submission.taskRunId!, "gateway")).toMatchObject({
      acknowledgedSequence: 2,
      terminalAcknowledgedSequence: 2,
    });

    for (const accepted of core.acceptedAcks) {
      const key = receiptKey(accepted);
      const persistedAt = durability.operationLog.findIndex((entry) =>
        entry === `persist:${key}` || entry === `promote:${key}`);
      const acknowledgedAt = durability.operationLog.indexOf(`ack:${key}`);
      expect(persistedAt).toBeGreaterThanOrEqual(0);
      expect(acknowledgedAt).toBeGreaterThan(persistedAt);
    }

    const operationsBeforeQuiescence = [...durability.operationLog];
    await restartedGateway.replay();
    expect(durability.operationLog).toEqual(operationsBeforeQuiescence);
    expect(core.requestedPaths.every((requestedPath) =>
      requestedPath.startsWith("/api/v1/"))).toBe(true);
  });

  it("uses the production instance lock, writer lease, and fence for crash takeover", async () => {
    const directory = temporaryDirectory("tagent-gateway-writer-");
    const databasePath = path.join(directory, "core.sqlite");
    const firstLock = await acquireCoreInstanceLock(databasePath, {
      instanceId: "gateway-a",
      pid: 1_001,
      host: "test-host",
      processStart: "gateway-a-start",
      clock: () => 1_000,
      filesystemProbe: async () => "local",
    });
    let firstStore: Store | null = null;
    let takeoverStore: Store | null = null;
    let takeoverLock: Awaited<ReturnType<typeof acquireCoreInstanceLock>> | null = null;
    let takeoverLease: CoreWriterLease | null = null;
    try {
      firstStore = new Store(databasePath);
      const firstLease = CoreWriterLease.claim(firstStore.db, {
        ownerId: "gateway-a",
        pid: 1_001,
        host: "test-host",
      }, {
        heartbeatIntervalMs: 10,
        leaseMs: 100,
        nowSql: "1000",
        skewMarginMs: 0,
      })!;
      const staleGuard = new WriterFenceGuard(firstStore.db, firstLease.authority, {
        nowSql: "1200",
        skewMarginMs: 0,
      });

      await expect(acquireCoreInstanceLock(databasePath, {
        instanceId: "gateway-b-live-contender",
        pid: 2_002,
        host: "test-host",
        processStart: "gateway-b-start",
        clock: () => 1_050,
        filesystemProbe: async () => "local",
        processProbe: async () => ({
          status: "alive",
          processStart: firstLock.metadata.processStart,
        }),
      })).rejects.toThrow(WriterAuthorityUnavailableError);
      await expect(firstLock.assertHeld()).resolves.toBeUndefined();

      takeoverLock = await acquireCoreInstanceLock(databasePath, {
        instanceId: "gateway-b",
        pid: 2_002,
        host: "test-host",
        processStart: "gateway-b-start",
        clock: () => 1_200,
        filesystemProbe: async () => "local",
        processProbe: async () => ({ status: "dead" }),
      });
      await expect(firstLock.assertHeld()).rejects.toThrow(WriterAuthorityLostError);

      takeoverStore = new Store(databasePath);
      takeoverLease = CoreWriterLease.claim(takeoverStore.db, {
        ownerId: "gateway-b",
        pid: 2_002,
        host: "test-host",
      }, {
        heartbeatIntervalMs: 10,
        leaseMs: 100,
        nowSql: "1200",
        skewMarginMs: 0,
      });
      expect(takeoverLease).not.toBeNull();
      expect(takeoverLease!.authority.fence).toBeGreaterThan(firstLease.authority.fence);

      expect(() => staleGuard.run((db: Database.Database) => db.prepare(`INSERT INTO sessions
        (id,title,created_at,updated_at) VALUES ('stale-write','stale',1,1)`).run()))
        .toThrow(WriterAuthorityLostError);
      const takeoverGuard = new WriterFenceGuard(takeoverStore.db, takeoverLease!.authority, {
        nowSql: "1200",
        skewMarginMs: 0,
      });
      takeoverGuard.run((db: Database.Database) => db.prepare(`INSERT INTO sessions
        (id,title,created_at,updated_at) VALUES ('takeover-write','takeover',2,2)`).run());
      expect(takeoverStore.db.prepare("SELECT id,title FROM sessions WHERE id='takeover-write'").get())
        .toEqual({ id: "takeover-write", title: "takeover" });
      expect(takeoverLease!.snapshot()).toMatchObject({
        ownerId: "gateway-b",
        fence: takeoverLease!.authority.fence,
        releasedAt: null,
      });
      await expect(takeoverLock.assertHeld()).resolves.toBeUndefined();
    } finally {
      takeoverLease?.release();
      takeoverStore?.close();
      firstStore?.close();
      await takeoverLock?.release().catch(() => undefined);
      await firstLock.release().catch(() => undefined);
    }
  });

  it("opens a real v30 SQLite fixture through Store v45 and rolls authority back with replay", () => {
    const directory = temporaryDirectory("tagent-gateway-migration-");
    const databasePath = path.join(directory, "core.sqlite");
    createV30DatabaseFixture(databasePath);

    const firstOpen = new Store(databasePath);
    const firstInventory = schemaInventory(firstOpen);
    expect(firstOpen.db.prepare("SELECT version FROM schema_meta WHERE id=1").get())
      .toEqual({ version: 45 });
    expect(firstInventory.map((entry) => [entry.type, entry.name])).toEqual([
      ["table", "approval_receipts"],
      ["table", "attempts"],
      ["index", "idx_operations_attempt_created"],
      ["index", "idx_runs_operator_session_created"],
      ["index", "idx_runs_operator_session_updated"],
      ["index", "idx_sessions_operator_created"],
      ["table", "integration_consumer_delivery"],
      ["table", "integration_outbox"],
      ["table", "learning_projection_authority_state"],
      ["table", "learning_projection_checkpoint"],
    ]);
    firstOpen.close();

    const store = new Store(databasePath);
    try {
      expect(schemaInventory(store)).toEqual(firstInventory);
      expect(store.db.prepare("SELECT version FROM schema_meta WHERE id=1").get())
        .toEqual({ version: 45 });

      const writer = CoreWriterLease.claim(store.db, {
        ownerId: "gateway-authority-test",
        pid: process.pid,
        host: "test-host",
      })!;
      const adapter = createGuardedLegacyStoreAdapter(
        store,
        new WriterFenceGuard(store.db, writer.authority),
      );
      const session = adapter.sessions.createSession();
      for (let index = 0; index < 2; index += 1) {
        const run = adapter.taskRuns.createRun(session.id, `rollback-${index}`);
        store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", 1);
      }
      const integration = adapter.learningIntegration;
      const shadow = new ShadowLearningProjectionWorker(integration, {
        owner: "shadow",
        leaseMs: 1_000,
      });
      expect(shadow.runOnce(100)).toMatchObject({ kind: "matched", watermark: 1 });

      const priorCompatibleGatewaySource = "legacy" as const;
      const legacy = integration.authority.acquire({
        source: priorCompatibleGatewaySource,
        owner: "gateway-authority",
        leaseMs: 1_000,
        timestamp: 101,
      })!;
      const first = integration.delivery.claimNextActive({
        consumer: "learning-active-v1",
        source: priorCompatibleGatewaySource,
        authority: legacy.fence,
        owner: "prior-gateway",
        leaseMs: 10,
        timestamp: 102,
      })!;
      integration.effects.record({
        logicalConsumer: "learning-active-v1",
        sourceEventId: first.fence.sourceEventId,
        effectHash: "prior-gateway-one",
        timestamp: 103,
      });
      integration.delivery.acknowledgeActive({
        claim: first,
        effectHash: "prior-gateway-one",
        timestamp: 104,
      });

      const switching = integration.authority.prepareCutover({
        fence: legacy.fence,
        switchWatermark: 1,
        timestamp: 105,
      })!;
      const activeIntegration = integration.authority.activateIntegration({
        fence: switching.fence,
        leaseMs: 1_000,
        timestamp: 106,
      })!;
      const unacknowledged = integration.delivery.claimNextActive({
        consumer: "learning-active-v1",
        source: "integration",
        authority: activeIntegration.fence,
        owner: "new-gateway",
        leaseMs: 10,
        timestamp: 107,
      })!;
      expect(unacknowledged.fence.outboxSequence).toBe(2);

      const rollback = integration.authority.prepareRollback({
        fence: activeIntegration.fence,
        timestamp: 118,
      })!;
      const activeLegacy = integration.authority.activateLegacy({
        fence: rollback.fence,
        leaseMs: 1_000,
        timestamp: 119,
      })!;
      expect(integration.delivery.getCheckpoint("learning-active-v1", priorCompatibleGatewaySource)?.watermark)
        .toBe(1);
      const replay = integration.delivery.claimNextActive({
        consumer: "learning-active-v1",
        source: priorCompatibleGatewaySource,
        authority: activeLegacy.fence,
        owner: "prior-gateway",
        leaseMs: 10,
        timestamp: 120,
      })!;
      expect(replay.fence).toMatchObject({
        outboxSequence: 2,
        sourceEventId: unacknowledged.fence.sourceEventId,
      });
      integration.effects.record({
        logicalConsumer: "learning-active-v1",
        sourceEventId: replay.fence.sourceEventId,
        effectHash: "prior-gateway-two",
        timestamp: 121,
      });
      integration.delivery.acknowledgeActive({
        claim: replay,
        effectHash: "prior-gateway-two",
        timestamp: 122,
      });
      expect(integration.delivery.getCheckpoint("learning-active-v1", priorCompatibleGatewaySource)?.watermark)
        .toBe(2);
      expect(integration.authority.getState()).toMatchObject({
        activeSource: priorCompatibleGatewaySource,
        status: "legacy_active",
        rollbackCheckpoint: 1,
        legacyLastAcked: 2,
      });
      expect(store.db.prepare("SELECT version FROM schema_meta WHERE id=1").get())
        .toEqual({ version: 45 });
      writer.release();
    } finally {
      store.close();
    }
  });

  it("executes config, migration, and readiness commands from a representative Core release", async () => {
    const directory = temporaryDirectory("tagent-gateway-release-");
    const releaseDirectory = path.join(directory, "release");
    mkdirSync(releaseDirectory, { recursive: true });
    createCoreReleaseFixture(releaseDirectory);
    const releaseManifestCommand = "scripts/release-manifest.mjs";
    const runtimeShim = path.join(directory, "production-runtime.cjs");
    writeFileSync(runtimeShim, [
      'Object.defineProperty(process.versions, "node", { value: "24.18.1" });',
      'Object.defineProperty(process.versions, "modules", { value: "137" });',
      'Object.defineProperty(process, "platform", { value: "linux" });',
      'Object.defineProperty(process, "arch", { value: "x64" });',
    ].join("\n"));
    const commit = "a".repeat(40);
    const manifestEnvironment = {
      ...process.env,
      RELEASE_ARTIFACT: "core",
      RELEASE_COMMIT: commit,
    };
    const createManifest = spawnSync(
      process.execPath,
      ["--require", runtimeShim, releaseManifestCommand, "create", "."],
      { cwd: releaseDirectory, encoding: "utf8", env: manifestEnvironment },
    );
    expect(createManifest.status, createManifest.stderr).toBe(0);
    const verifyManifest = spawnSync(
      process.execPath,
      ["--require", runtimeShim, releaseManifestCommand, "verify", "."],
      { cwd: releaseDirectory, encoding: "utf8", env: manifestEnvironment },
    );
    expect(verifyManifest.status, verifyManifest.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(releaseDirectory, "RELEASE_MANIFEST.json"), "utf8")))
      .toMatchObject({ artifact: "core", commit, schemaVersion: 2 });
    writeFileSync(path.join(releaseDirectory, "RELEASE_COMMIT"), `${"b".repeat(40)}\n`);
    const rejectedManifest = spawnSync(
      process.execPath,
      ["--require", runtimeShim, releaseManifestCommand, "verify", "."],
      { cwd: releaseDirectory, encoding: "utf8", env: manifestEnvironment },
    );
    expect(rejectedManifest.status).not.toBe(0);
    expect(rejectedManifest.stderr).toContain("commit marker mismatch");

    const serviceToken = "gateway-production-credential";
    const configEnvironment = {
      TAGENT_API_BASE: "https://models.internal/v1",
      TAGENT_MEMORY_ENABLED: "false",
      TAGENT_MODEL: "gpt-5.6-sol",
      TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{
        token: serviceToken,
        scopes: ["events:consume", "runs:read"],
        principal: {
          subjectId: "gateway-production",
          resourceScopes: [{ type: "workspace", id: "production" }],
        },
      }]),
    } as NodeJS.ProcessEnv;
    const configCommand = [
      'import { loadConfig } from "@tagent/core-service/config";',
      "const config=loadConfig(process.env);",
      'const gateway=config.serviceCredentials.find((item)=>item.scopes.includes("events:consume"));',
      'if(!gateway||!gateway.scopes.includes("runs:read")||gateway.principal?.subjectId!=="gateway-production"||gateway.principal.resourceScopes.length!==1||gateway.principal.resourceScopes[0]?.type!=="workspace"||gateway.principal.resourceScopes[0]?.id!=="production") process.exit(1);',
      "process.stdout.write(JSON.stringify({credentialCount:config.serviceCredentials.length,scopes:gateway.scopes,principal:gateway.principal}));",
    ].join("");
    const validConfig = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", configCommand],
      { cwd: releaseDirectory, encoding: "utf8", env: { ...process.env, ...configEnvironment } },
    );
    expect(validConfig.status, validConfig.stderr).toBe(0);
    expect(JSON.parse(validConfig.stdout)).toEqual({
      credentialCount: 1,
      scopes: ["events:consume", "runs:read"],
      principal: {
        subjectId: "gateway-production",
        resourceScopes: [{ type: "workspace", id: "production" }],
      },
    });
    const invalidConfig = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", configCommand],
      {
        cwd: releaseDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          ...configEnvironment,
          TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{
            token: "short",
            scopes: ["events:consume", "runs:read"],
          }]),
        },
      },
    );
    expect(invalidConfig.status).not.toBe(0);
    expect(invalidConfig.stderr).toContain("token must be at least 24 characters");

    const databasePath = path.join(directory, "release-command.sqlite");
    createV30DatabaseFixture(databasePath);
    const schemaCommand = [
      'import { Store } from "@tagent/persistence-sqlite/store";',
      "const store=new Store(process.env.TAGENT_DB);",
      'const schemaVersion=store.db.prepare("SELECT version FROM schema_meta WHERE id=1").get().version;',
      'const objects=store.db.prepare("SELECT name FROM sqlite_master WHERE name IN (\'attempts\',\'approval_receipts\',\'idx_operations_attempt_created\',\'idx_runs_operator_session_created\',\'idx_runs_operator_session_updated\',\'idx_sessions_operator_created\',\'integration_outbox\',\'learning_projection_authority_state\') ORDER BY name").all().map((row)=>row.name);',
      "store.close();",
      "process.stdout.write(JSON.stringify({schemaVersion,objects}));",
    ].join("");
    const firstSchemaOpen = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", schemaCommand],
      {
        cwd: releaseDirectory,
        encoding: "utf8",
        env: { ...process.env, TAGENT_DB: databasePath },
      },
    );
    expect(firstSchemaOpen.status, firstSchemaOpen.stderr).toBe(0);
    const secondSchemaOpen = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", schemaCommand],
      {
        cwd: releaseDirectory,
        encoding: "utf8",
        env: { ...process.env, TAGENT_DB: databasePath },
      },
    );
    expect(secondSchemaOpen.status, secondSchemaOpen.stderr).toBe(0);
    const schemaEvidence = {
      schemaVersion: 45,
      objects: [
        "approval_receipts",
        "attempts",
        "idx_operations_attempt_created",
        "idx_runs_operator_session_created",
        "idx_runs_operator_session_updated",
        "idx_sessions_operator_created",
        "integration_outbox",
        "learning_projection_authority_state",
      ],
    };
    expect(JSON.parse(firstSchemaOpen.stdout)).toEqual(schemaEvidence);
    expect(JSON.parse(secondSchemaOpen.stdout)).toEqual(schemaEvidence);

    const readinessStore = new Store(databasePath);
    const readinessLease = CoreWriterLease.claim(readinessStore.db, {
      ownerId: "health-writer",
      pid: process.pid,
      host: "test-host",
    })!;
    const app = createApp({
      persistence: {} as never,
      service: {} as never,
      logger: false,
      writerReadiness: {
        isWriterReady: () => readinessLease.isCurrent(),
      },
      onClose: async () => undefined,
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;
      const probeEnvironment = {
        ...process.env,
        TAGENT_DB: databasePath,
        TAGENT_GATEWAY_CONSUMER_ID: "gateway-production",
        TAGENT_HEALTH_URL: `http://127.0.0.1:${address.port}/api/v1/health`,
      };
      const readyProbe = await runChild(
        process.execPath,
        ["scripts/gateway-readiness-probe.mjs"],
        { cwd: releaseDirectory, env: probeEnvironment },
      );
      expect(readyProbe.status, readyProbe.stderr).toBe(0);
      const ready = JSON.parse(readyProbe.stdout) as Record<string, unknown>;
      expect({
        probeVersion: ready.probeVersion,
        schemaVersion: ready.schemaVersion,
        migrationOpenIssues: ready.migrationOpenIssues,
        writerReady: ready.writerReady,
        writerFence: ready.writerFence,
        writerLeaseFresh: ready.writerLeaseFresh,
        consumerLag: ready.consumerLag,
        terminalUnacked: ready.terminalUnacked,
        settledUnacked: ready.settledUnacked,
        finalUnacked: ready.finalUnacked,
        authorityReady: ready.authorityReady,
        ready: ready.ready,
        severity: ready.severity,
        reasons: ready.reasons,
        thresholds: ready.thresholds,
      }).toEqual({
        probeVersion: 4,
        schemaVersion: 45,
        migrationOpenIssues: 0,
        writerReady: true,
        writerFence: readinessLease.authority.fence,
        writerLeaseFresh: true,
        consumerLag: 0,
        terminalUnacked: 0,
        settledUnacked: 0,
        finalUnacked: 0,
        authorityReady: true,
        ready: true,
        severity: "ready",
        reasons: [],
        thresholds: {
          consumerLagWarningMin: 1,
          consumerLagCritical: 10_000,
          terminalUnackedWarningMin: 1,
          terminalUnackedCriticalAgeMs: 120_000,
          receiptUncertainCriticalAgeMs: 120_000,
        },
      });
      expect(ready.authority).toEqual({
        activeSource: "legacy",
        status: "legacy_active",
        generation: 0,
        switchWatermark: 0,
        legacyLastAcked: 0,
        legacyResumePosition: 1,
        integrationCheckpoint: 0,
        rollbackCheckpoint: 0,
      });
      expect(ready.watermarks).toEqual([]);

      const receiptSession = readinessStore.createSession("readiness receipt health");
      const receiptRun = readinessStore.createRun(receiptSession.id, "observe in-flight receipts");
      const receiptCursor = readinessStore.claimEventConsumer(receiptRun.id, "gateway-production");
      expect(readinessStore.ackEventConsumer(
        receiptRun.id,
        "gateway-production",
        receiptCursor.generation,
        receiptRun.lastEventSeq,
      )).toBe("accepted");
      readinessStore.claimTaskRunCommand({
        principalId: "gateway-production",
        taskRunId: receiptRun.id,
        commandId: "young-started-command",
        commandType: "task_run.cancel",
        canonicalPayload: JSON.stringify({ type: "task_run.cancel" }),
        targetAttemptId: null,
        requestId: "young-started-request",
      });
      const youngStartedProbe = await runChild(
        process.execPath,
        ["scripts/gateway-readiness-probe.mjs"],
        { cwd: releaseDirectory, env: probeEnvironment },
      );
      expect(youngStartedProbe.status, youngStartedProbe.stderr).toBe(0);
      expect(JSON.parse(youngStartedProbe.stdout)).toMatchObject({
        ready: true,
        reasons: [],
        receipts: { commands: { started: 1, outcomeUnknown: 0 } },
      });

      readinessStore.db.prepare(`UPDATE task_run_command_receipts SET updated_at=?
        WHERE principal_id=? AND task_run_id=? AND command_id=?`).run(
        Date.now() - 120_001,
        "gateway-production",
        receiptRun.id,
        "young-started-command",
      );
      const staleStartedProbe = await runChild(
        process.execPath,
        ["scripts/gateway-readiness-probe.mjs"],
        { cwd: releaseDirectory, env: probeEnvironment },
      );
      expect(staleStartedProbe.status).toBe(1);
      expect(JSON.parse(staleStartedProbe.stdout)).toMatchObject({
        ready: false,
        severity: "critical",
        reasons: ["command_receipts_stale_started"],
      });
      readinessStore.settleTaskRunCommand(
        "gateway-production",
        receiptRun.id,
        "young-started-command",
        "succeeded",
        { accepted: true },
      );

      expect(readinessLease.release()).toBe(true);
      const rejectedProbe = await runChild(
        process.execPath,
        ["scripts/gateway-readiness-probe.mjs"],
        { cwd: releaseDirectory, env: probeEnvironment },
      );
      expect(rejectedProbe.status).toBe(1);
      const rejected = JSON.parse(rejectedProbe.stdout) as Record<string, unknown>;
      expect({
        schemaVersion: rejected.schemaVersion,
        writerReady: rejected.writerReady,
        writerLeaseFresh: rejected.writerLeaseFresh,
        consumerLag: rejected.consumerLag,
        terminalUnacked: rejected.terminalUnacked,
        ready: rejected.ready,
        severity: rejected.severity,
        reasons: rejected.reasons,
      }).toEqual({
        schemaVersion: 45,
        writerReady: false,
        writerLeaseFresh: false,
        consumerLag: 0,
        terminalUnacked: 0,
        ready: false,
        severity: "critical",
        reasons: ["health_writer_not_ready", "writer_lease_not_fresh"],
      });
    } finally {
      await app.close();
      readinessStore.close();
    }
  });
});
