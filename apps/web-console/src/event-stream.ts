import { decodeAbi, TaskRunEventSchema } from "@tagent/abi";
import { authenticatedCoreFetch, type AuthenticatedCoreRequestOptions } from "./api-transport";
import type { RunEvent } from "./api-types";

function sseData(frame: string): string | undefined {
  const values = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return values.length ? values.join("\n") : undefined;
}

async function consumeEventStream(
  response: Response,
  onEvent: (event: RunEvent) => void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("Core event stream has no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.match(/\r?\n\r?\n/);
      while (boundary?.index !== undefined) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = sseData(frame);
        if (data !== undefined) {
          const event = decodeAbi(TaskRunEventSchema, JSON.parse(data) as unknown);
          await onEvent({
            runId: event.aggregateId,
            seq: event.sequence,
            type: event.type.startsWith("task_run.") ? `run.${event.type.slice(9)}` : event.type,
            data: event.payload,
            createdAt: Date.parse(event.occurredAt),
          });
        }
        boundary = buffer.match(/\r?\n\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!signal.aborted) throw new Error("Core event stream closed unexpectedly");
}

export function subscribe(
  runId: string,
  consumerId: string,
  generation: number,
  after: number,
  onEvent: (event: RunEvent) => void | Promise<void>,
  onError: (error: Error) => void,
  options: AuthenticatedCoreRequestOptions = {},
) {
  const controller = new AbortController();
  const pathname = `/api/v1/task-runs/${encodeURIComponent(runId)}/events?consumerId=${encodeURIComponent(consumerId)}&generation=${generation}&after=${after}`;
  void authenticatedCoreFetch(pathname, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  }, options).then((response) => consumeEventStream(response, onEvent, controller.signal)).catch((cause) => {
    if (!controller.signal.aborted) onError(cause instanceof Error ? cause : new Error(String(cause)));
  });
  return () => controller.abort();
}
