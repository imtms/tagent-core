import type { JobQueuePort, MemorySourceViewPort, OperationsStatePort } from "./ports.js";
import type { AccessContext, MemoryScope } from "./types.js";

const backfillKind = "memory-history-backfill";
const backfillWorkerId = "memory-history-backfill";

export interface MemoryHistoryBackfillPort {
  runOnce(): Promise<boolean>;
}

export class MemoryHistoryBackfill implements MemoryHistoryBackfillPort {
  private readonly scope: MemoryScope;

  constructor(
    private readonly source: MemorySourceViewPort,
    private readonly jobs: JobQueuePort,
    private readonly operations: OperationsStatePort,
    workspaceScopeId: string,
    private readonly batchSize = 100,
  ) {
    this.scope = { type: "workspace", id: workspaceScopeId };
  }

  async runOnce(): Promise<boolean> {
    const state = await this.operations.workerHeartbeat(this.scope, backfillKind);
    if (state?.metadata.complete === true) return false;
    const afterId = numericCursor(state?.metadata.lastMessageId);
    const messages = this.source.listDurableUserMessagesPage(afterId, this.batchSize);
    for (const message of messages) {
      if (!isExplicitProfileCue(message.content)) continue;
      const access = captureAccess(message.principalId, message.sessionId, this.scope.id);
      if (!access) continue;
      await this.jobs.enqueue({
        access,
        sourceRefs: [{ sourceType: "message", sourceId: String(message.id), revision: "user" }],
        content: `user: ${message.content}`,
        idempotencyKey: `user-message:${message.id}`,
        captureSource: { kind: "user_message", role: "user", explicitIntent: true },
      });
    }
    const lastMessageId = messages.at(-1)?.id ?? afterId;
    await this.operations.heartbeat(backfillWorkerId, this.scope, backfillKind, Date.now(), {
      lastMessageId,
      complete: messages.length < this.batchSize,
    });
    return messages.length > 0;
  }
}

function captureAccess(principalId:string|null|undefined,sessionId:string|undefined,workspaceScopeId:string):AccessContext|undefined{
  const subjectId=principalId??(sessionId?`session:${sessionId}`:undefined);
  if(!subjectId)return undefined;
  const scopes:AccessContext["scopes"]=principalId
    ?[{type:"user",id:principalId},{type:"workspace",id:workspaceScopeId},...(sessionId?[{type:"session" as const,id:sessionId}]:[])]
    :[{type:"session",id:sessionId!},{type:"workspace",id:workspaceScopeId}];
  return{subjectId,scopes,purpose:"capture"};
}

function numericCursor(value:unknown){return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:0;}

function isExplicitProfileCue(content:string){return /记住|remember|我叫|我的名字|我的姓名|叫我|称呼我|my name is|call me|(?:我|用户).{0,20}(?:喜欢|偏好|希望|不喜欢|习惯|prefer)/i.test(content)&&!/[?？]/.test(content);}
