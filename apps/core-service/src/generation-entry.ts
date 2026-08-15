import { runCoreServiceFromCli } from "./generation-cli.js";

if (process.env.TAGENT_HOST_MANAGED !== "1" || typeof process.send !== "function") {
  console.error("TAgent Core Generation must be started by the Core Host");
  process.exitCode = 1;
} else {
  void runCoreServiceFromCli().catch((error) => {
    console.error("TAgent Core Generation failed to start", error);
    process.exit(1);
  });
}
