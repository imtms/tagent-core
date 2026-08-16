import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const eslint = new ESLint({ cwd: repoRoot });

interface LintProbe {
  name: string;
  filePath: string;
  source: string;
}

type LintResult = Awaited<ReturnType<ESLint["lintText"]>>[number];

async function lintProbe(probe: LintProbe): Promise<LintResult> {
  const [result] = await eslint.lintText(probe.source, {
    filePath: path.join(repoRoot, probe.filePath),
  });
  return result;
}

function boundaryMessages(result: LintResult) {
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
}

const rejectedProbes: LintProbe[] = [
  {
    name: "Execution cannot reverse-depend on the core-service App",
    filePath: "packages/execution/src/eslint-probe.ts",
    source: 'import "@tagent/core-service";\n',
  },
  {
    name: "Execution cannot import an undeclared domain package",
    filePath: "packages/execution/src/eslint-probe.ts",
    source: 'import "@tagent/admission/domain";\n',
  },
  {
    name: "HTTP cannot reach Memory outside its manifest graph",
    filePath: "adapters/http-fastify/src/eslint-probe.ts",
    source: 'import "@tagent/memory/ports";\n',
  },
  {
    name: "an allowed workspace dependency still cannot expose src",
    filePath: "packages/execution/src/eslint-probe.ts",
    source: 'import "@tagent/governance/src/domain.js";\n',
  },
  {
    name: "Fastify is concrete to the HTTP adapter",
    filePath: "packages/execution/src/eslint-probe.ts",
    source: 'import "fastify";\n',
  },
  {
    name: "SQLite is concrete to the persistence adapter",
    filePath: "packages/execution/src/eslint-probe.ts",
    source: 'import "better-sqlite3";\n',
  },
  {
    name: "pi-agent-core is concrete to the runtime adapter",
    filePath: "packages/execution/src/eslint-probe.ts",
    source: 'import "@earendil-works/pi-agent-core";\n',
  },
  {
    name: "pi-ai is forbidden from core-service composition",
    filePath: "apps/core-service/src/eslint-probe.ts",
    source: 'import "@earendil-works/pi-ai/compat";\n',
  },
  {
    name: "pi-ai is concrete to the runtime adapter",
    filePath: "adapters/http-fastify/src/eslint-probe.ts",
    source: 'import "@earendil-works/pi-ai/compat";\n',
  },
  {
    name: "Web cannot import a backend workspace",
    filePath: "apps/web-console/src/eslint-probe.ts",
    source: 'import "@tagent/execution";\n',
  },
];

const acceptedProbes: LintProbe[] = [
  {
    name: "Execution may import Governance",
    filePath: "packages/execution/src/eslint-probe.ts",
    source: 'import "@tagent/governance/ports";\n',
  },
  {
    name: "HTTP may import ABI and Fastify",
    filePath: "adapters/http-fastify/src/eslint-probe.ts",
    source: 'import "@tagent/abi/channel/v1";\nimport "fastify";\n',
  },
  {
    name: "Core service may import reviewed adapters",
    filePath: "apps/core-service/src/eslint-probe.ts",
    source: [
      'import "@tagent/http-fastify";',
      'import "@tagent/persistence-sqlite";',
      "",
    ].join("\n"),
  },
  {
    name: "Runtime adapter may import pi-agent-core and pi-ai",
    filePath: "adapters/runtime-pi/src/eslint-probe.ts",
    source: 'import "@earendil-works/pi-agent-core";\nimport "@earendil-works/pi-ai";\n',
  },
  {
    name: "Web may import channel ABI and Core client",
    filePath: "apps/web-console/src/eslint-probe.ts",
    source: 'import "@tagent/abi/channel/v1";\nimport "@tagent/core-client";\n',
  },
];

describe("ESLint production import boundaries", () => {
  it("fails closed for reverse, undeclared, deep-source, concrete, and Web imports", async () => {
    const results = await Promise.all(rejectedProbes.map(async (probe) => [probe, await lintProbe(probe)] as const));
    for (const [probe, result] of results) {
      expect(boundaryMessages(result), probe.name).toHaveLength(1);
      expect(result.errorCount, probe.name).toBeGreaterThan(0);
    }
  });

  it("allows every reviewed representative dependency lane", async () => {
    const results = await Promise.all(acceptedProbes.map(async (probe) => [probe, await lintProbe(probe)] as const));
    for (const [probe, result] of results) {
      expect(boundaryMessages(result), probe.name).toEqual([]);
      expect(result.errorCount, probe.name).toBe(0);
    }
  });
});
