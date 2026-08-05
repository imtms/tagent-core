export interface SseMessage {
  data: string;
  event: string;
  id: string;
  retry?: number;
}

function parseRetry(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const retry = Number(value);
  return Number.isSafeInteger(retry) ? retry : undefined;
}

export async function readSse(response: Response, onMessage: (message: SseMessage) => void | Promise<void>): Promise<void> {
  if (!response.body) throw new Error("TAgent Core SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "message";
  let id = "";
  let retry: number | undefined;

  const dispatch = async (): Promise<void> => {
    if (!data.length) return;
    await onMessage({ data: data.join("\n"), event, id, ...(retry === undefined ? {} : { retry }) });
    data = [];
    event = "message";
    retry = undefined;
  };

  const consumeLine = async (line: string): Promise<void> => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry") retry = parseRetry(value);
  };

  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      await consumeLine(line);
      newline = buffer.indexOf("\n");
    }
    if (chunk.done) break;
  }
  if (buffer) await consumeLine(buffer.replace(/\r$/, ""));
  await dispatch();
}

export function decodeJsonSse<T>(decode: (payload: unknown) => T): (message: SseMessage) => T {
  return (message): T => {
    let payload: unknown;
    try {
      payload = JSON.parse(message.data) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON SSE payload: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return decode(payload);
  };
}
