#!/usr/bin/env node
import { runCoreHostFromCli } from "./host.js";

void runCoreHostFromCli({
  entryPath: process.argv[1]!,
  directGenerationEntry: "dist/generation-entry.js",
}).catch((error) => {
  console.error("TAgent Core Host failed to start", error);
  process.exitCode = 1;
});
