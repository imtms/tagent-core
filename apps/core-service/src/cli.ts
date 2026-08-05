#!/usr/bin/env node
import { runCoreServiceFromCli } from "./server.js";

void runCoreServiceFromCli().catch((error) => {
  console.error("TAgent Core failed to start", error);
  process.exitCode = 1;
});
