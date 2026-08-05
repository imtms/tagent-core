import type { HttpArtifactContentPort } from "./ports/index.js";

export const unavailableArtifactContent: HttpArtifactContentPort = Object.freeze({
  filename: () => "artifact.bin",
  isMarkdown: () => false,
  isText: () => false,
  loadSource: async () => {
    throw Object.assign(new Error("artifact content adapter is unavailable"), {
      code: "ARTIFACT_SOURCE_UNAVAILABLE",
    });
  },
  loadDownload: async () => {
    throw Object.assign(new Error("artifact content adapter is unavailable"), {
      code: "ARTIFACT_SOURCE_UNAVAILABLE",
    });
  },
});
