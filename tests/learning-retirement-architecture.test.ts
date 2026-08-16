import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function filesBelow(relativeRoot: string): string[] {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  return readdirSync(absoluteRoot).flatMap((entry) => {
    if (["dist", "node_modules", ".git", ".omx"].includes(entry)) return [];
    const relative = path.join(relativeRoot, entry);
    const absolute = path.join(root, relative);
    return statSync(absolute).isDirectory() ? filesBelow(relative) : [relative];
  });
}

describe("retired Learning architecture", () => {
  it("keeps the archived subsystem out of the current runtime and install graph", () => {
    expect(existsSync(path.join(root, "packages/learning"))).toBe(false);
    expect(existsSync(path.join(root, "apps/web-console/src/LearningCenter.tsx"))).toBe(false);

    const manifests = ["packages", "adapters", "apps"]
      .flatMap(filesBelow)
      .filter((filename) => filename.endsWith("package.json"));
    for (const manifest of manifests) {
      expect(readFileSync(path.join(root, manifest), "utf8"), manifest).not.toContain("@tagent/learning");
    }

    const productionSources = ["packages", "adapters", "apps", "scripts"]
      .flatMap(filesBelow)
      .filter((filename) => /\.(?:ts|tsx|mjs)$/.test(filename));
    for (const filename of productionSources) {
      const source = readFileSync(path.join(root, filename), "utf8");
      expect(source, filename).not.toMatch(/TAGENT_LEARNING|@tagent\/learning|admin\.(?:learning|workflow|autonomy)\.v1/);
      expect(source, filename).not.toMatch(/\/api\/v1\/(?:admin\/(?:learning|workflows|autonomy)|internal\/workflows)/);
      expect(source, filename).not.toMatch(/\b(?:LearningApplication|LearningFeatureState|LearningService|WorkflowLearningService)\b/);
      expect(source, filename).not.toMatch(/\b(?:autonomy_(?:approval_requests|audit_events)|communication_profiles|experience_observations|integration_outbox|learning_events|run_learning_policies|semantic_learning_jobs|workflow_(?:bindings|definitions|distillation_jobs|evaluations|promotions|revisions))\b/);
    }

    expect(readFileSync(path.join(root, ".env.example"), "utf8")).not.toContain("TAGENT_LEARNING");
  });

  it("retains legacy SQLite data only as an explicitly retired immutable baseline", () => {
    const currentSchema = readFileSync(path.join(root, "adapters/persistence-sqlite/src/current-schema.ts"), "utf8");
    expect(currentSchema).toContain('"40-retired-learning.sql"');
    expect(currentSchema).toContain("existing databases keep their data");
    expect(existsSync(path.join(root, "adapters/persistence-sqlite/src/schema/40-retired-learning.sql"))).toBe(true);
  });
});
