import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const concretePackages = [
  "fastify",
  "better-sqlite3",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
];

function packagePattern(packageName) {
  return `^${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`;
}

function boundaryRestrictions(allowedInternal, allowedConcrete = []) {
  const allowedNames = allowedInternal.map((name) => name.replace("@tagent/", ""));
  const internalPattern = allowedNames.length === 0
    ? "^@tagent/"
    : `^@tagent/(?!(?:${allowedNames.join("|")})(?:/|$))`;
  return [
    {
      regex: "^@tagent/[^/]+/src(?:/|$)",
      message: "Import workspace packages through their exported ABI, never their src tree.",
    },
    {
      regex: internalPattern,
      message: "This layer may only import its declared @tagent workspace dependencies.",
    },
    ...concretePackages
      .filter((packageName) => !allowedConcrete.includes(packageName))
      .map((packageName) => ({
        regex: packagePattern(packageName),
        message: `${packageName} is owned by a concrete adapter or the core-service composition root.`,
      })),
  ];
}

function workspaceBoundary(name, files, allowedInternal, allowedConcrete = []) {
  return {
    name: `tagent/boundaries/${name}`,
    files,
    rules: {
      "no-restricted-imports": ["error", {
        patterns: boundaryRestrictions(allowedInternal, allowedConcrete),
      }],
    },
  };
}

const workspaceBoundaries = [
  workspaceBoundary("abi", ["packages/abi/src/**/*.{ts,tsx}"], []),
  workspaceBoundary("core-client", ["packages/core-client/src/**/*.{ts,tsx}"], ["@tagent/abi"]),
  workspaceBoundary("governance", ["packages/governance/src/**/*.{ts,tsx}"], []),
  workspaceBoundary("execution", ["packages/execution/src/**/*.{ts,tsx}"], ["@tagent/governance"]),
  workspaceBoundary("admission", ["packages/admission/src/**/*.{ts,tsx}"], ["@tagent/execution", "@tagent/governance"]),
  workspaceBoundary("memory", ["packages/memory/src/**/*.{ts,tsx}"], []),
  workspaceBoundary("learning", ["packages/learning/src/**/*.{ts,tsx}"], [
    "@tagent/admission",
    "@tagent/execution",
    "@tagent/governance",
    "@tagent/memory",
  ]),
  workspaceBoundary("runtime-pi", ["adapters/runtime-pi/src/**/*.{ts,tsx}"], ["@tagent/execution"], [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ]),
  workspaceBoundary("persistence-sqlite", ["adapters/persistence-sqlite/src/**/*.{ts,tsx}"], [
    "@tagent/admission",
    "@tagent/execution",
    "@tagent/governance",
    "@tagent/learning",
    "@tagent/memory",
  ], ["better-sqlite3"]),
  workspaceBoundary("workspace-local", ["adapters/workspace-local/src/**/*.{ts,tsx}"], ["@tagent/execution"]),
  workspaceBoundary("http-fastify", ["adapters/http-fastify/src/**/*.{ts,tsx}"], [
    "@tagent/abi",
    "@tagent/admission",
    "@tagent/execution",
    "@tagent/governance",
  ], ["fastify"]),
  workspaceBoundary("core-service", ["apps/core-service/src/**/*.{ts,tsx}"], [
    "@tagent/admission",
    "@tagent/execution",
    "@tagent/governance",
    "@tagent/http-fastify",
    "@tagent/learning",
    "@tagent/memory",
    "@tagent/persistence-sqlite",
    "@tagent/runtime-pi",
    "@tagent/workspace-local",
  ]),
  workspaceBoundary("web", ["apps/web-console/src/**/*.{ts,tsx}"], ["@tagent/abi", "@tagent/core-client"]),
];

export default tseslint.config(
  { ignores: ["**/dist/**", "node_modules/**", "coverage/**", "data/**", "workspace/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "prefer-const": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      "no-undef": "off"
    }
  },
  ...workspaceBoundaries,
);
