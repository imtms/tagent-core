import type { ProviderStreams, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";

const DISABLED_SDK_TIMEOUT_MS = 2_147_483_647;

export class ProviderIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`Provider stream was idle for ${idleTimeoutMs}ms`);
    this.name = "ProviderIdleTimeoutError";
  }
}

function withIdleTimeout(baseFetch: typeof fetch, idleTimeoutMs: number): typeof fetch {
  return async (input, init) => {
    const timeoutController = new AbortController();
    const signals = [timeoutController.signal, init?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort(new ProviderIdleTimeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
      timer.unref?.();
    };
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    armTimer();
    let response: Response;
    try {
      response = await baseFetch(input, { ...init, signal });
    } catch (error) {
      if (timedOut) throw new ProviderIdleTimeoutError(idleTimeoutMs);
      throw error;
    } finally {
      clearTimer();
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    let readerReleased = false;
    const releaseReader = () => {
      if (readerReleased) return;
      readerReleased = true;
      reader.releaseLock();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        armTimer();
        try {
          const chunk = await reader.read();
          clearTimer();
          if (timedOut) {
            const error = new ProviderIdleTimeoutError(idleTimeoutMs);
            await reader.cancel(error).catch(() => undefined);
            releaseReader();
            controller.error(error);
            return;
          }
          if (chunk.done) {
            releaseReader();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          clearTimer();
          releaseReader();
          controller.error(timedOut ? new ProviderIdleTimeoutError(idleTimeoutMs) : error);
        }
      },
      async cancel(reason) {
        clearTimer();
        timeoutController.abort(reason);
        await reader.cancel(reason).catch(() => undefined);
        releaseReader();
      },
    });
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

export function withProviderIdleTimeout(streams: ProviderStreams, idleTimeoutMs: number | undefined, lifetimeSignal?: AbortSignal): ProviderStreams {
  if (idleTimeoutMs === undefined && !lifetimeSignal) return streams;
  const hasTimeoutSetting = idleTimeoutMs !== undefined;
  const idleFetch = idleTimeoutMs !== undefined && idleTimeoutMs > 0
    ? withIdleTimeout(globalThis.fetch, idleTimeoutMs)
    : undefined;
  const streamOptions = <T extends StreamOptions | SimpleStreamOptions>(options: T | undefined): T => ({
    ...options,
    ...(hasTimeoutSetting ? {
      ...(idleFetch ? { fetch: idleFetch } : {}),
      // SDK timeouts are absolute deadlines. The transport wrapper above enforces
      // the intended header/body inactivity timeout and refreshes it on every chunk.
      // A configured value of zero disables the idle watchdog, matching the
      // previous coding-agent transport contract.
      timeoutMs: DISABLED_SDK_TIMEOUT_MS,
    } : {}),
    ...(lifetimeSignal ? {
      signal: options?.signal ? AbortSignal.any([options.signal, lifetimeSignal]) : lifetimeSignal,
    } : {}),
  }) as T;
  return {
    stream: (model, context, options) => streams.stream(model, context, streamOptions(options)),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, streamOptions(options)),
  };
}
