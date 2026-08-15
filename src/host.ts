import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCoreHostFromCli } from "@tagent/core-service/host";

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void runCoreHostFromCli({
    entryPath: process.argv[1]!,
    directGenerationEntry: "node_modules/@tagent/core-service/dist/generation-entry.js",
  }).catch((error) => {
    console.error("TAgent Core Host failed to start", error);
    process.exitCode = 1;
  });
}
