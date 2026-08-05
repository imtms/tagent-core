import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import { PersistenceMemorySourceLoader } from "@tagent/memory/composition";
import type {
  MemoryRuntimeSourcePort,
  MemorySourceViewPort,
} from "@tagent/memory/ports";
import { estimateTextTokens } from "@tagent/memory/domain";
import type { LegacyStoreAdapter } from "@tagent/persistence-sqlite";

const forbiddenDomains = new Set([
  "admission",
  "core",
  "execution",
  "governance",
  "learning",
  "persistence",
  "runtime",
  "store",
]);

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const filename = path.join(root, name);
    return statSync(filename).isDirectory()
      ? sourceFiles(filename)
      : filename.endsWith(".ts") ? [filename] : [];
  });
}

describe("Memory package boundary", () => {
  it("owns source-view contracts that the current persistence composition satisfies structurally", () => {
    expectTypeOf<LegacyStoreAdapter["memory"]>().toMatchTypeOf<MemoryRuntimeSourcePort>();
  });

  it("loads only the message and run source fields required by Memory", async () => {
    const source: MemorySourceViewPort = {
      getMessageSource: (id) => id === 1 ? { role: "user", content: "remember me" } : undefined,
      getRun: (id) => id === "run-1" ? { goal: "verify release" } : undefined,
      listTranscriptView: (id) => id === "run-1" ? [{ kind: "assistant", text: "done" }] : [],
      listDurableUserMessages: () => [{ id: 1, content: "remember me" }],
    };
    const loader = new PersistenceMemorySourceLoader(source);

    await expect(loader.load(
      { subjectId: "memory", scopes: [{ type: "workspace", id: "boundary" }], purpose: "capture" },
      [
        { sourceType: "message", sourceId: "1" },
        { sourceType: "run", sourceId: "run-1" },
      ],
    )).resolves.toBe([
      "user: remember me",
      "goal: verify release",
      JSON.stringify({ kind: "assistant", text: "done" }),
    ].join("\n\n"));
  });

  it("preserves the established text-token estimate", () => {
    expect([
      "",
      "abcd",
      "abcde",
      "中文",
      "a中",
      "🚀",
      "Memory 记忆",
    ].map(estimateTextTokens)).toEqual([0, 1, 2, 3, 2, 2, 5]);
  });

  it("has no source dependency from Memory to surrounding domains", () => {
    const srcRoot = path.join(process.cwd(), "src");
    const memoryRoot = path.join(srcRoot, "memory");
    const violations = sourceFiles(memoryRoot).flatMap((filename) => {
      const imported = ts.preProcessFile(readFileSync(filename, "utf8"), true, true).importedFiles;
      return imported.flatMap((entry) => {
        const specifier = entry.fileName.replaceAll("\\", "/");
        const domain = specifier.startsWith(".")
          ? path.relative(srcRoot, path.resolve(path.dirname(filename), specifier)).split(path.sep)[0]
          : /^(?:src\/|@tagent\/)([^/]+)/.exec(specifier)?.[1];
        return domain !== undefined && forbiddenDomains.has(domain)
          ? [`${path.relative(process.cwd(), filename)} -> ${specifier}`]
          : [];
      });
    });

    expect(violations).toEqual([]);
  });
});
