import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCoreServiceFromCli } from "@tagent/core-service";

export * from "@tagent/core-service";

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void runCoreServiceFromCli().catch((error) => {
    console.error("TAgent Core failed to start", error);
    process.exitCode = 1;
  });
}
