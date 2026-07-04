export async function fetchWithTimeout(fetchImpl, input, init = {}, options = {}) {
  const label = options.label ?? "fetch";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms while fetching ${input}.`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeoutId.unref?.();
  });

  const upstreamSignal = init.signal;
  const abortFromUpstream = () => {
    controller.abort(upstreamSignal.reason);
  };

  if (upstreamSignal?.aborted) {
    clearTimeout(timeoutId);
    throw new Error(`${label} was aborted before fetch started.`);
  }
  upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });

  try {
    return await Promise.race([fetchImpl(input, { ...init, signal: controller.signal }), timeout]);
  } catch (error) {
    if (
      controller.signal.aborted &&
      error?.message !== `${label} timed out after ${timeoutMs}ms while fetching ${input}.`
    ) {
      throw new Error(`${label} timed out after ${timeoutMs}ms while fetching ${input}.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
