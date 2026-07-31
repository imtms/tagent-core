import { createHash } from "node:crypto";
import type { AuditPort } from "../ports.js";
import type { AccessContext, MemoryScope } from "../types.js";
export type GateStage = "source_egress" | "write" | "embedding_egress" | "cold_publish" | "read" | "prompt_injection";
export interface GatePayload { text: string; scope: MemoryScope; labels?: string[] }
export type GateDecision = { action: "allow" | "transform"; payload: GatePayload; labels: string[]; reasonCodes: string[] } | { action: "deny" | "quarantine" | "require_approval"; labels: string[]; reasonCodes: string[] };
export interface PolicyGatePort { evaluate(stage: GateStage, access: AccessContext, payload: GatePayload): Promise<GateDecision> }
const rules: Array<{ code: string; pattern: RegExp }> = [
  { code: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { code: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { code: "api_key", pattern: /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/i },
  { code: "password_assignment", pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s]{6,}/i },
  { code: "database_url", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/i },
  { code: "seed_phrase", pattern: /\b(?:seed phrase|mnemonic)\s*[:=]\s*(?:[a-z]+\s+){11,23}[a-z]+/i },
];
const injection = /(?:ignore|disregard) (?:all |the )?(?:previous|prior|system) instructions|忽略(?:之前|以上|系统)(?:的)?指令/i;
export class DefaultPolicyEngine implements PolicyGatePort {
  readonly version = "memory-policy-v1";
  constructor(private readonly audit?: AuditPort) {}
  async evaluate(stage: GateStage, access: AccessContext, payload: GatePayload): Promise<GateDecision> {
    const allowed = access.scopes.some((scope) => scope.type === payload.scope.type && scope.id === payload.scope.id);
    if (!allowed) return this.finish(stage, access, payload, { action: "deny", labels: ["scope_violation"], reasonCodes: ["scope_not_authorized"] });
    const matches = rules.filter((rule) => rule.pattern.test(payload.text));
    if (matches.length) {
      let text = payload.text;
      for (const match of matches) text = text.replace(new RegExp(match.pattern.source, match.pattern.flags.includes("g") ? match.pattern.flags : `${match.pattern.flags}g`), `[REDACTED:${match.code}]`);
      return this.finish(stage, access, payload, { action: "transform", payload: { ...payload, text }, labels: ["sensitive"], reasonCodes: matches.map((match) => match.code) });
    }
    if ((stage === "write" || stage === "read" || stage === "prompt_injection" || stage === "cold_publish") && injection.test(payload.text)) return this.finish(stage, access, payload, { action: "quarantine", labels: ["untrusted_instruction"], reasonCodes: ["stored_prompt_injection"] });
    return this.finish(stage, access, payload, { action: "allow", payload, labels: payload.labels ?? [], reasonCodes: [] });
  }
  private async finish(stage: GateStage, access: AccessContext, original: GatePayload, decision: GateDecision) {
    await this.audit?.record({ action: stage, subjectId: access.subjectId, scope: original.scope, decision: decision.action, reasonCodes: decision.reasonCodes, payloadHash: createHash("sha256").update(original.text).digest("hex"), policyVersion: this.version, at: Date.now() });
    return decision;
  }
}
