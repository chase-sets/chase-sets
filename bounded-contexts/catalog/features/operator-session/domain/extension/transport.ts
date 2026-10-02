import { closed, isGrant, isInstant, operatorOrigins, safeInteger, type OperatorEnvironment } from "./protocol";

export type OperatorPush = {
  expectedRevision: number;
  value: string;
  observedAt: string;
  browserExpiresAt: string | null;
};
export type OperatorResult =
  | { outcome: "stored" | "unchanged" | "stale-revision"; revision: number }
  | { outcome: "revoked" }
  | { outcome: "grant-invalid" | "unavailable" | "refused" | "invalid-response" }
  | { outcome: "rate-limited"; retryAfterMs: number };
// Largest authoritative envelope is 56 UTF-8 bytes at MAX_SAFE_INTEGER.
// 512 allows whitespace headroom, not additional fields or provider payloads.
export const operatorResponseByteLimit = 512;
export const operatorRequestDeadlineMs = 10_000;
const errors: Readonly<Record<number, readonly string[]>> = {
  400: ["invalid-request"],
  408: ["request-timeout"],
  413: ["request-too-large"],
  415: ["unsupported-media-type"],
  422: ["invalid-session-value"],
  429: ["rate-limited"],
  503: ["custody-unavailable", "revision-exhausted"],
};

export function createOperatorTransport(fetcher: typeof fetch) {
  async function request(
    environment: OperatorEnvironment,
    grant: string,
    push?: OperatorPush,
  ): Promise<OperatorResult> {
    if (!isGrant(grant) || !Object.hasOwn(operatorOrigins, environment)) return { outcome: "refused" };
    if (
      push &&
      (!safeInteger(push.expectedRevision) ||
        !isInstant(push.observedAt) ||
        (push.browserExpiresAt !== null && !isInstant(push.browserExpiresAt)) ||
        typeof push.value !== "string" ||
        !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(push.value))
    )
      return { outcome: "refused" };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let received = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("deadline"));
      }, operatorRequestDeadlineMs);
    });
    try {
      const response = await Promise.race([
        fetcher(`${operatorOrigins[environment]}/api/public/catalog/operator-session/${push ? "tcgplayer" : "grant"}`, {
          method: push ? "PUT" : "DELETE",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          headers: { Authorization: `Bearer ${grant}`, ...(push ? { "Content-Type": "application/json" } : {}) },
          ...(push
            ? {
                body: JSON.stringify({
                  expectedRevision: push.expectedRevision,
                  value: push.value,
                  observedAt: push.observedAt,
                  browserExpiresAt: push.browserExpiresAt,
                }),
              }
            : {}),
          signal: abort.signal,
        }),
        deadline,
      ]);
      received = true;
      if (response.redirected) return { outcome: "invalid-response" };
      // Denial removes authority even if its body is malformed or never finishes.
      // No body, revision or success is adopted from this status-only refusal.
      if (response.status === 401) return { outcome: "grant-invalid" };
      if (!response.body) return { outcome: "invalid-response" };
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let text = "";
      await Promise.race([
        response.body.pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              bytes += chunk.byteLength;
              if (bytes > operatorResponseByteLimit) throw new Error("response-limit");
              text += decoder.decode(chunk, { stream: true });
            },
          }),
          { signal: abort.signal },
        ),
        deadline,
      ]);
      text += decoder.decode();
      const body: unknown = JSON.parse(text);
      if (push && closed(body, ["outcome", "revision"]) && safeInteger(body.revision)) {
        if (response.status === 200 && (body.outcome === "stored" || body.outcome === "unchanged"))
          return { outcome: body.outcome, revision: body.revision };
        if (response.status === 409 && body.outcome === "stale-revision")
          return { outcome: body.outcome, revision: body.revision };
      }
      if (!push && response.status === 200 && closed(body, ["outcome"]) && body.outcome === "revoked")
        return { outcome: "revoked" };
      if (!closed(body, ["code"]) || !errors[response.status]?.some((code) => code === body.code))
        return { outcome: "invalid-response" };
      if (response.status === 429) {
        const header = response.headers.get("Retry-After") ?? "";
        const seconds = /^\d{1,5}$/.test(header) ? Number(header) : 300;
        return { outcome: "rate-limited", retryAfterMs: Math.max(60_000, Math.min(3_600_000, seconds * 1000)) };
      }
      return { outcome: response.status >= 500 ? "unavailable" : "refused" };
    } catch {
      return { outcome: abort.signal.aborted || !received ? "unavailable" : "invalid-response" };
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
  return {
    push: (environment: OperatorEnvironment, grant: string, body: OperatorPush) => request(environment, grant, body),
    revoke: (environment: OperatorEnvironment, grant: string) => request(environment, grant),
  };
}
