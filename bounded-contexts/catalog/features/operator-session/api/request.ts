import { validateOperatorSessionInstant, validateOperatorSessionValue } from "../domain/value";
import type { CatalogOperatorSessionStore } from "./store";

export class OperatorSessionRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "OperatorSessionRequestError";
  }
}

async function readBody(request: Request, maximum: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperatorSessionRequestError("request-timeout", 408)), 5000);
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum)
        throw new OperatorSessionRequestError(maximum ? "request-too-large" : "invalid-request", maximum ? 413 : 400);
      chunks.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } catch (error) {
    // A hostile stream may never acknowledge cancellation; it must not retain admission.
    void reader.cancel().catch(() => undefined);
    throw error instanceof OperatorSessionRequestError
      ? error
      : new OperatorSessionRequestError("invalid-request", 400);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function requireEmptyBody(request: Request): Promise<void> {
  await readBody(request, 0);
}

export function readGrantBearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new OperatorSessionRequestError("grant-invalid", 401);
  return match[1]!;
}

export async function readPushRequest(request: Request): Promise<Parameters<CatalogOperatorSessionStore["accept"]>[0]> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new OperatorSessionRequestError("unsupported-media-type", 415);
  const text = await readBody(request, 8192);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OperatorSessionRequestError("invalid-request", 400);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 4 ||
    !("expectedRevision" in body) ||
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 0 ||
    !("value" in body) ||
    typeof body.value !== "string" ||
    !("observedAt" in body) ||
    typeof body.observedAt !== "string" ||
    !("browserExpiresAt" in body) ||
    (body.browserExpiresAt !== null && typeof body.browserExpiresAt !== "string")
  )
    throw new OperatorSessionRequestError("invalid-request", 400);
  try {
    validateOperatorSessionInstant(body.observedAt);
    if (body.browserExpiresAt !== null) validateOperatorSessionInstant(body.browserExpiresAt);
  } catch {
    throw new OperatorSessionRequestError("invalid-request", 400);
  }
  try {
    validateOperatorSessionValue(body.value);
  } catch {
    throw new OperatorSessionRequestError("invalid-session-value", 422);
  }
  return {
    expectedRevision: body.expectedRevision,
    value: body.value,
    observedAt: body.observedAt,
    browserExpiresAt: body.browserExpiresAt,
  };
}
