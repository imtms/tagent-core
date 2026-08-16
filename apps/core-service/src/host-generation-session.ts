import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  CORE_STATE_PROTOCOL,
  parseGenerationToHostMessage,
  type CoreHostActivationRequest,
  type CoreHostDrainedMessage,
  type CoreHostReadyMessage,
  type GenerationToHostMessage,
  type HostToGenerationMessage,
} from "./generation-protocol.js";
import type { CoreReleaseIdentity } from "./host-release-registry.js";

export interface GenerationExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface CoreHostLogger {
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, error?: unknown, details?: Readonly<Record<string, unknown>>): void;
}

/** Owns one child process and validates every message crossing its IPC boundary. */
export class GenerationSession {
  readonly child: ChildProcess;
  readonly generationId = randomUUID();
  readonly exited: Promise<GenerationExitResult>;
  managedExit = false;
  readyMessage?: CoreHostReadyMessage;
  heartbeatSequence = 0;
  lastHeartbeatAt: number | null = null;
  private resolveReady!: (message: CoreHostReadyMessage) => void;
  private rejectReady!: (error: unknown) => void;
  private resolveExit!: (value: GenerationExitResult) => void;
  private readonly drained = new Map<string, { promise: Promise<CoreHostDrainedMessage>; resolve: (message: CoreHostDrainedMessage) => void }>();
  private readonly exitObservers = new Set<(result: GenerationExitResult) => void>();
  private exitedValue?: GenerationExitResult;
  private unexpectedExitReported = false;
  readonly ready: Promise<CoreHostReadyMessage>;

  constructor(
    readonly release: CoreReleaseIdentity,
    workingDirectory: string,
    spawn: typeof fork,
    private readonly onActivation: (session: GenerationSession, request: CoreHostActivationRequest) => void,
    private readonly onUnexpectedExit: (session: GenerationSession, result: GenerationExitResult) => void,
    private readonly onHeartbeat: (session: GenerationSession) => void,
    env: NodeJS.ProcessEnv,
    private readonly logger: CoreHostLogger,
    private readonly clock: () => number,
    activationRequestId?: string,
  ) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
    this.child = spawn(release.generationEntry, [], {
      // Application-relative state belongs to the stable installation, not
      // to an immutable code generation. This keeps the default database and
      // workspace paths identical across release activation and rollback.
      cwd: workingDirectory,
      env: {
        ...env,
        TAGENT_HOST_MANAGED: "1",
        TAGENT_GENERATION_ID: this.generationId,
        TAGENT_RELEASE_ID: release.id,
        TAGENT_RELEASE_MANAGED: release.managed ? "1" : "0",
        TAGENT_STATE_PROTOCOL: CORE_STATE_PROTOCOL,
        ...(activationRequestId ? { TAGENT_ACTIVATION_REQUEST_ID: activationRequestId } : {}),
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    this.child.on("message", (raw) => this.receive(raw));
    this.child.once("error", (error) => this.rejectReady(error));
    const finishExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exitedValue) return;
      const result = { code, signal };
      this.exitedValue = result;
      this.resolveExit(result);
      for (const observer of this.exitObservers) observer(result);
      this.exitObservers.clear();
      if (!this.readyMessage) this.rejectReady(new Error(`Generation ${this.generationId} exited before READY`));
      this.reportUnexpectedExitIfNeeded();
    };
    // Node may omit `exit` when spawning fails, but always closes the child
    // stdio/IPC resources. Treat the first exit/close signal as terminal.
    this.child.once("exit", finishExit);
    this.child.once("close", finishExit);
  }

  get hasExited(): boolean { return this.exitedValue !== undefined; }

  allowUnexpectedExitRecovery(): void {
    this.managedExit = false;
    this.reportUnexpectedExitIfNeeded();
  }

  send(message: HostToGenerationMessage): void {
    if (!this.child.connected || this.hasExited) throw new Error(`Generation ${this.generationId} IPC is unavailable`);
    this.child.send(message);
  }

  waitForDrained(requestId: string): Promise<CoreHostDrainedMessage> {
    const existing = this.drained.get(requestId);
    if (existing) return existing.promise;
    let resolve!: (message: CoreHostDrainedMessage) => void;
    const promise = new Promise<CoreHostDrainedMessage>((done) => { resolve = done; });
    this.drained.set(requestId, { promise, resolve });
    return promise;
  }

  observeExit(observer: (result: GenerationExitResult) => void): () => void {
    if (this.exitedValue) {
      observer(this.exitedValue);
      return () => undefined;
    }
    this.exitObservers.add(observer);
    return () => { this.exitObservers.delete(observer); };
  }

  private receive(raw: unknown): void {
    let message: GenerationToHostMessage;
    try {
      message = parseGenerationToHostMessage(raw);
    } catch (error) {
      this.logger.error("Core Host rejected malformed Generation IPC", error, { generationId: this.generationId });
      return;
    }
    if (message.generationId !== this.generationId) {
      this.logger.error("Core Host rejected stale Generation IPC", undefined, {
        expectedGenerationId: this.generationId,
        receivedGenerationId: message.generationId,
      });
      return;
    }
    if (message.type === "READY") {
      if (this.readyMessage) return;
      if (message.releaseId !== this.release.id) {
        this.rejectReady(new Error(`Generation release mismatch: expected ${this.release.id}, got ${message.releaseId}`));
        return;
      }
      this.readyMessage = message;
      this.lastHeartbeatAt = this.clock();
      this.resolveReady(message);
      return;
    }
    if (message.type === "HEARTBEAT") {
      if (!this.readyMessage
        || message.releaseId !== this.release.id
        || message.writerFence !== this.readyMessage.writerFence
        || message.sequence <= this.heartbeatSequence) {
        this.logger.error("Core Host rejected stale or inconsistent Generation heartbeat", undefined, {
          generationId: this.generationId,
          sequence: message.sequence,
        });
        return;
      }
      this.heartbeatSequence = message.sequence;
      this.lastHeartbeatAt = this.clock();
      this.onHeartbeat(this);
      return;
    }
    if (message.type === "DRAINED") {
      if (!this.readyMessage || message.writerFence !== this.readyMessage.writerFence) {
        this.logger.error("Core Host rejected DRAINED with a stale writer fence", undefined, {
          generationId: this.generationId,
          receivedWriterFence: message.writerFence,
          expectedWriterFence: this.readyMessage?.writerFence,
        });
        return;
      }
      this.drained.get(message.requestId)?.resolve(message);
      return;
    }
    if (!this.readyMessage) {
      this.logger.error("Core Host rejected activation before Generation readiness", undefined, { generationId: this.generationId });
      return;
    }
    this.onActivation(this, message);
  }

  private reportUnexpectedExitIfNeeded(): void {
    if (this.managedExit || !this.exitedValue || this.unexpectedExitReported) return;
    this.unexpectedExitReported = true;
    this.onUnexpectedExit(this, this.exitedValue);
  }
}
