export type BoundedHttpObjectErrorCode =
  | "not-found"
  | "response-invalid"
  | "response-too-large"
  | "deadline-exceeded"
  | "transport-failed";

export class BoundedHttpObjectError extends Error {
  readonly code: BoundedHttpObjectErrorCode;

  constructor(code: BoundedHttpObjectErrorCode) {
    super(code);
    this.name = "BoundedHttpObjectError";
    this.code = code;
  }
}

export async function readBoundedHttpObject(input: {
  fetch: typeof globalThis.fetch;
  url: string;
  maxBytes: number;
  deadlineMs: number;
  accept: string;
}): Promise<Readonly<{ body: Uint8Array; contentType: string }>> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), input.deadlineMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await raceWithAbort(
      input.fetch(input.url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: input.accept },
      }),
      controller.signal,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoundedHttpObjectError("not-found");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoundedHttpObjectError("response-invalid");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
        await response.body.cancel().catch(() => undefined);
        throw new BoundedHttpObjectError("response-invalid");
      }
      if (declaredLength > input.maxBytes) {
        await response.body.cancel().catch(() => undefined);
        throw new BoundedHttpObjectError("response-too-large");
      }
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const result = await raceWithAbort(reader.read(), controller.signal);
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > input.maxBytes) {
        throw new BoundedHttpObjectError("response-too-large");
      }
      chunks.push(result.value);
    }

    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      body,
      contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
    };
  } catch (error) {
    if (error instanceof BoundedHttpObjectError) {
      throw error;
    }
    throw new BoundedHttpObjectError(controller.signal.aborted ? "deadline-exceeded" : "transport-failed");
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => undefined);
    }
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new BoundedHttpObjectError("deadline-exceeded"));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(new BoundedHttpObjectError("deadline-exceeded"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
