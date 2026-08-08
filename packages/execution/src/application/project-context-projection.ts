import { createHash } from "node:crypto";
import type { ContextManifestItem } from "../domain/task-run.js";
import type { ContextSourcePort, ProjectContextSnapshot } from "../ports/context-source-port.js";
import { estimateContextTokens } from "./context-token-estimate.js";

export function loadProjectContext(source?: ContextSourcePort): ProjectContextSnapshot {
  return source?.load() ?? { snapshotHash: createHash("sha256").update("").digest("hex"), rules: [] };
}

export function projectContextItems(snapshot: ProjectContextSnapshot): ContextManifestItem[] {
  return snapshot.rules.map((rule) => ({
    kind: "project_rule", sourceId: `workspace:${rule.path}`, selected: rule.selected, reason: rule.reason,
    estimatedTokens: estimateContextTokens(rule.content),
    metadata: { path: rule.path, sha256: rule.sha256, precedence: rule.precedence, bytes: rule.bytes, trust: "untrusted_project_policy" },
  }));
}
