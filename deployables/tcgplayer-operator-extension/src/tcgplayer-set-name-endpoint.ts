export const TCGPLAYER_SET_NAMES_URL = "https://mpapi.tcgplayer.com/v2/Catalog/SetNames";
export const TCGPLAYER_SET_NAMES_TIMEOUT_MS = 15_000;
export const TCGPLAYER_SET_NAMES_BODY_CAP_BYTES = 4 * 1024 * 1024;

export type TcgplayerSetNameEndpointResult = Readonly<{
  ok: boolean;
  status: number | null;
  contentClass: "json" | "non-json" | "unknown";
  bytes: number;
  body: unknown;
  code?:
    | "invalid-product-line-id"
    | "http-not-success"
    | "non-json"
    | "body-cap-exceeded"
    | "timeout"
    | "network-error";
}>;

const jsonContentType = (value: string | null) =>
  value?.toLowerCase().split(";", 1)[0].trim().endsWith("json") ?? false;

export async function fetchTcgplayerSetNames(
  productLineId: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<TcgplayerSetNameEndpointResult> {
  if (!/^\d+$/.test(productLineId)) {
    return { ok: false, status: null, contentClass: "unknown", bytes: 0, body: null, code: "invalid-product-line-id" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TCGPLAYER_SET_NAMES_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(`${TCGPLAYER_SET_NAMES_URL}?categoryId=${encodeURIComponent(productLineId)}`, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      return {
        ok: false,
        status: null,
        contentClass: "unknown",
        bytes: 0,
        body: null,
        code: controller.signal.aborted ? "timeout" : "network-error",
      };
    }
    const contentClass = jsonContentType(response.headers.get("content-type")) ? "json" : "non-json";
    const consumed = await readBody(response, controller.signal);
    if (!consumed.ok) {
      return {
        ok: false,
        status: response.status,
        contentClass,
        bytes: consumed.bytes,
        body: null,
        code: consumed.code,
      };
    }
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: response.status,
        contentClass,
        bytes: consumed.bytes,
        body: null,
        code: "timeout",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        contentClass,
        bytes: consumed.bytes,
        body: null,
        code: "http-not-success",
      };
    }
    if (contentClass !== "json") {
      return { ok: false, status: response.status, contentClass, bytes: consumed.bytes, body: null, code: "non-json" };
    }
    try {
      return {
        ok: true,
        status: response.status,
        contentClass,
        bytes: consumed.bytes,
        body: JSON.parse(consumed.text),
      };
    } catch {
      return { ok: false, status: response.status, contentClass, bytes: consumed.bytes, body: null, code: "non-json" };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<
  | { ok: true; bytes: number; text: string }
  | { ok: false; bytes: number; code: "body-cap-exceeded" | "timeout" | "network-error" }
> {
  if (!response.body) {
    try {
      const text = await response.text();
      const bytes = new TextEncoder().encode(text).byteLength;
      return bytes > TCGPLAYER_SET_NAMES_BODY_CAP_BYTES
        ? { ok: false, bytes, code: "body-cap-exceeded" }
        : { ok: true, bytes, text };
    } catch {
      return { ok: false, bytes: 0, code: signal.aborted ? "timeout" : "network-error" };
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancelOnAbort = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > TCGPLAYER_SET_NAMES_BODY_CAP_BYTES) {
        await reader.cancel();
        return { ok: false, bytes, code: "body-cap-exceeded" };
      }
      chunks.push(next.value);
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes, text: new TextDecoder().decode(merged) };
  } catch {
    return { ok: false, bytes, code: signal.aborted ? "timeout" : "network-error" };
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
  }
}
