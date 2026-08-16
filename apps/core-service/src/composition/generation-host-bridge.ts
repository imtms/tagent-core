import process from "node:process";
import {
  CORE_HOST_PROTOCOL_VERSION,
  CORE_STATE_PROTOCOL,
  parseHostToGenerationMessage,
  protocolText,
  type CoreHostActivationRequest,
  type CoreHostStatusMessage,
  type HostToGenerationMessage,
} from "../generation-protocol.js";
import type { GenerationActivationResult } from "@tagent/execution/ports";

export { parseHostToGenerationMessage } from "../generation-protocol.js";

export interface CoreGenerationDrainRequest {
  requestId: string;
  deadlineMs: number;
}

export interface GenerationHostBridgeOptions {
  environment?: NodeJS.ProcessEnv;
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  subscribeMessage?: (listener: (message: unknown) => void) => void;
  subscribeDisconnect?: (listener: () => void) => void;
  disconnect?: () => void;
  logger?: Pick<Console, "error">;
}

export class GenerationHostBridge {
  readonly managed: boolean;
  readonly activationAvailable: boolean;
  readonly generationId: string;
  readonly releaseId: string;
  readonly activationRequestId: string | null;
  private drainHandler?: (request: CoreGenerationDrainRequest) => void | Promise<void>;
  private resultHandler?: (result: GenerationActivationResult) => void | Promise<void>;
  private disconnectHandler?: () => void | Promise<void>;
  private readonly sendMessage?: (message: unknown) => boolean;
  private readonly flushMessage?: (message: unknown) => Promise<void>;
  private readonly logger: Pick<Console, "error">;
  private readonly disconnectParent?: () => void;
  private intentionalDisconnect = false;
  private parentDisconnected = false;
  private currentHostStatus: Omit<CoreHostStatusMessage, "type" | "protocolVersion"> | null = null;

  constructor(options: GenerationHostBridgeOptions = {}) {
    const environment = options.environment ?? process.env;
    this.managed = environment.TAGENT_HOST_MANAGED === "1";
    this.activationAvailable = this.managed && environment.TAGENT_RELEASE_MANAGED === "1";
    this.generationId = this.managed ? protocolText(environment.TAGENT_GENERATION_ID, "TAGENT_GENERATION_ID") : "unmanaged";
    this.releaseId = environment.TAGENT_RELEASE_ID?.trim() || "development";
    this.activationRequestId = environment.TAGENT_ACTIVATION_REQUEST_ID?.trim() || null;
    if (this.managed && environment.TAGENT_STATE_PROTOCOL !== CORE_STATE_PROTOCOL) {
      throw new Error(`Managed Generation requires ${CORE_STATE_PROTOCOL}`);
    }
    this.sendMessage = options.send
      ? (message) => options.send!(message)
      : process.send ? (message) => process.send!(message) : undefined;
    this.flushMessage = options.send
      ? (message) => new Promise<void>((resolve, reject) => {
          options.send!(message, (error) => error ? reject(error) : resolve());
        })
      : process.send ? (message) => new Promise<void>((resolve, reject) => {
          const send = process.send as unknown as (
            value: unknown,
            callback: (error: Error | null) => void,
          ) => boolean;
          send.call(process, message, (error) => error ? reject(error) : resolve());
        }) : undefined;
    this.logger = options.logger ?? console;
    this.disconnectParent = options.disconnect ?? (process.disconnect ? () => process.disconnect() : undefined);
    const subscribeMessage = options.subscribeMessage ?? ((listener) => process.on("message", listener));
    const subscribeDisconnect = options.subscribeDisconnect ?? ((listener) => process.once("disconnect", listener));
    if (this.managed) {
      if (!this.sendMessage) throw new Error("Managed Generation requires a parent IPC channel");
      subscribeMessage((raw) => this.receive(raw));
      subscribeDisconnect(() => {
        if (this.intentionalDisconnect) return;
        this.parentDisconnected = true;
        void this.disconnectHandler?.();
      });
    }
  }

  onDrain(handler: (request: CoreGenerationDrainRequest) => void | Promise<void>): void { this.drainHandler = handler; }
  onActivationResult(handler: (result: GenerationActivationResult) => void | Promise<void>): void { this.resultHandler = handler; }
  onParentDisconnect(handler: () => void | Promise<void>): void {
    this.disconnectHandler = handler;
    if (this.parentDisconnected) void handler();
  }

  hostStatus(): Readonly<Omit<CoreHostStatusMessage, "type" | "protocolVersion">> | null {
    return this.currentHostStatus ? Object.freeze({ ...this.currentHostStatus }) : null;
  }

  ready(writerFence: number): void {
    if (!this.managed) return;
    this.send({
      type: "READY",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: this.generationId,
      releaseId: this.releaseId,
      stateProtocol: CORE_STATE_PROTOCOL,
      writerFence,
    });
  }

  heartbeat(writerFence: number, sequence: number): void {
    if (!this.managed) return;
    this.send({
      type: "HEARTBEAT",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: this.generationId,
      releaseId: this.releaseId,
      writerFence,
      sequence,
    });
  }

  activate(request: Omit<CoreHostActivationRequest, "type" | "protocolVersion" | "generationId">): void {
    if (!this.activationAvailable) throw new Error("Core Generation activation requires a managed immutable release");
    this.send({
      type: "ACTIVATE",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: this.generationId,
      requestId: request.requestId,
      runId: request.runId,
      operationId: request.operationId,
      expectedCurrent: request.expectedCurrent,
      targetRelease: request.targetRelease,
    });
  }

  async drained(requestId: string, writerFence: number): Promise<void> {
    if (!this.managed) return;
    if (!this.flushMessage) throw new Error("Core Generation IPC is unavailable");
    await this.flushMessage({
      type: "DRAINED",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: this.generationId,
      requestId,
      writerFence,
    });
    this.intentionalDisconnect = true;
    this.disconnectParent?.();
  }

  private send(message: unknown): void {
    if (!this.sendMessage) throw new Error("Core Generation IPC is unavailable");
    this.sendMessage(message);
  }

  private receive(raw: unknown): void {
    let message: HostToGenerationMessage;
    try { message = parseHostToGenerationMessage(raw); }
    catch (error) { this.logger.error("Core Generation rejected malformed Host IPC", error); return; }
    if (message.type === "DRAIN") {
      if (message.generationId !== this.generationId) {
        this.logger.error("Core Generation rejected a stale DRAIN message");
        return;
      }
      void this.drainHandler?.({ requestId: message.requestId, deadlineMs: message.deadlineMs });
      return;
    }
    if (message.type === "HOST_STATUS") {
      if (message.generationId !== this.generationId) {
        this.logger.error("Core Generation rejected stale Host status");
        return;
      }
      const { type: _type, protocolVersion: _protocolVersion, ...status } = message;
      this.currentHostStatus = status;
      return;
    }
    void this.resultHandler?.({
      requestId: message.requestId,
      status: message.status,
      activeRelease: message.activeRelease,
      ...(message.error ? { error: message.error } : {}),
    });
  }
}
