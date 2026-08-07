import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/support/clean-test-env.ts"],
  },
});
