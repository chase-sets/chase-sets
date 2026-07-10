export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-lite";
export const DEFAULT_VOYAGE_EMBEDDING_BATCH_SIZE = 128;
export const VOYAGE_EMBEDDING_DIMENSIONS = 1_024;
export const VOYAGE_EMBEDDINGS_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

export type EmbeddingInputType = "query" | "document";

export type EmbeddingProviderResult = Readonly<{
  vectors: readonly (readonly number[])[];
  totalTokens: number;
}>;

export type DiscoveryEmbeddingProvider = Readonly<{
  model: string;
  dimensions: number;
  embed: (
    texts: readonly string[],
    inputType: EmbeddingInputType,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<EmbeddingProviderResult>;
}>;

export type VoyageEmbeddingErrorKind = "authentication" | "rate-limit" | "timeout" | "upstream" | "invalid-response";

export class VoyageEmbeddingProviderError extends Error {
  readonly kind: VoyageEmbeddingErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    input: Readonly<{
      kind: VoyageEmbeddingErrorKind;
      retryable: boolean;
      status?: number | null;
      retryAfterMs?: number | null;
      cause?: unknown;
    }>,
  ) {
    super(message, { cause: input.cause });
    this.name = "VoyageEmbeddingProviderError";
    this.kind = input.kind;
    this.retryable = input.retryable;
    this.status = input.status ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

type VoyageRequestInput = Readonly<{
  apiKey: string;
  model: string;
  endpoint: string;
  texts: readonly string[];
  inputType: EmbeddingInputType;
  timeoutMs: number;
  maxAttempts: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  fetchRequest: typeof fetch;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}>;

export function createVoyageEmbeddingProvider(
  input: Readonly<{
    apiKey: string;
    model?: string;
    endpoint?: string;
    batchSize?: number;
    timeoutMs?: number;
    maxAttempts?: number;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
    fetch?: typeof fetch;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  }>,
): DiscoveryEmbeddingProvider {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("Voyage embedding provider requires a non-empty API key.");
  }

  const model = input.model?.trim() || DEFAULT_VOYAGE_EMBEDDING_MODEL;
  const endpoint = input.endpoint ?? VOYAGE_EMBEDDINGS_ENDPOINT;
  const batchSize = positiveInteger(input.batchSize ?? DEFAULT_VOYAGE_EMBEDDING_BATCH_SIZE, "batchSize");
  const timeoutMs = positiveInteger(input.timeoutMs ?? 15_000, "timeoutMs");
  const maxAttempts = positiveInteger(input.maxAttempts ?? 4, "maxAttempts");
  const retryBackoffBaseMs = positiveInteger(input.retryBackoffBaseMs ?? 500, "retryBackoffBaseMs");
  const retryBackoffMaxMs = positiveInteger(input.retryBackoffMaxMs ?? 10_000, "retryBackoffMaxMs");
  const fetchRequest = input.fetch ?? fetch;
  const sleep = input.sleep ?? sleepWithAbort;

  return {
    model,
    dimensions: VOYAGE_EMBEDDING_DIMENSIONS,
    embed: async (texts, inputType, options = {}) => {
      if (inputType !== "query" && inputType !== "document") {
        throw new Error("Voyage embedding input_type must be query or document.");
      }
      if (texts.length === 0) {
        return { vectors: [], totalTokens: 0 };
      }

      const vectors: number[][] = [];
      let totalTokens = 0;
      for (let index = 0; index < texts.length; index += batchSize) {
        const result = await requestBatchWithRetry({
          apiKey,
          model,
          endpoint,
          texts: texts.slice(index, index + batchSize),
          inputType,
          timeoutMs,
          maxAttempts,
          retryBackoffBaseMs,
          retryBackoffMaxMs,
          fetchRequest,
          sleep,
          signal: options.signal,
        });
        vectors.push(...result.vectors.map(normalizeVector));
        totalTokens += result.totalTokens;
      }

      return { vectors, totalTokens };
    },
  };
}

async function requestBatchWithRetry(input: VoyageRequestInput): Promise<EmbeddingProviderResult> {
  let lastError: VoyageEmbeddingProviderError | null = null;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      return await requestBatch(input);
    } catch (error) {
      const typed = toVoyageError(error);
      lastError = typed;
      if (!typed.retryable || attempt === input.maxAttempts) {
        throw typed;
      }
      const exponential = Math.min(input.retryBackoffMaxMs, input.retryBackoffBaseMs * 2 ** Math.max(0, attempt - 1));
      await input.sleep(Math.max(exponential, typed.retryAfterMs ?? 0), input.signal);
    }
  }
  throw (
    lastError ??
    new VoyageEmbeddingProviderError("Voyage embedding request failed.", {
      kind: "upstream",
      retryable: true,
    })
  );
}

async function requestBatch(input: VoyageRequestInput): Promise<EmbeddingProviderResult> {
  const timeoutController = new AbortController();
  const onAbort = () => timeoutController.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("Voyage embedding request timed out.")),
    input.timeoutMs,
  );

  try {
    const response = await input.fetchRequest(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: input.texts,
        model: input.model,
        input_type: input.inputType,
        output_dimension: VOYAGE_EMBEDDING_DIMENSIONS,
        output_dtype: "float",
      }),
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      if (response.status === 401 || response.status === 403) {
        throw new VoyageEmbeddingProviderError("Voyage rejected the embedding API credentials.", {
          kind: "authentication",
          retryable: false,
          status: response.status,
        });
      }
      if (response.status === 429) {
        throw new VoyageEmbeddingProviderError("Voyage rate-limited the embedding request.", {
          kind: "rate-limit",
          retryable: true,
          status: response.status,
          retryAfterMs,
        });
      }
      throw new VoyageEmbeddingProviderError(`Voyage embedding request failed with status ${response.status}.`, {
        kind: "upstream",
        retryable: response.status === 408 || response.status >= 500,
        status: response.status,
        retryAfterMs,
      });
    }

    return parseVoyageResponse(await response.json(), input.texts.length);
  } catch (error) {
    if (error instanceof VoyageEmbeddingProviderError) {
      throw error;
    }
    if (timeoutController.signal.aborted) {
      throw new VoyageEmbeddingProviderError("Voyage embedding request timed out or was aborted.", {
        kind: "timeout",
        retryable: !input.signal?.aborted,
        cause: error,
      });
    }
    throw new VoyageEmbeddingProviderError("Voyage embedding request failed before receiving a response.", {
      kind: "upstream",
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function parseVoyageResponse(value: unknown, expectedCount: number): EmbeddingProviderResult {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
    throw invalidResponse("Voyage embedding response did not include a data array.");
  }
  const data = (value as { data: unknown[] }).data;
  if (data.length !== expectedCount) {
    throw invalidResponse(`Voyage returned ${data.length} embeddings for ${expectedCount} inputs.`);
  }

  const vectors = data
    .map((entry, responseIndex) => {
      if (!entry || typeof entry !== "object" || !Array.isArray((entry as { embedding?: unknown }).embedding)) {
        throw invalidResponse("Voyage embedding response contained an invalid vector entry.");
      }
      const embedding = (entry as { embedding: unknown[] }).embedding;
      if (
        embedding.length !== VOYAGE_EMBEDDING_DIMENSIONS ||
        embedding.some((component) => typeof component !== "number" || !Number.isFinite(component))
      ) {
        throw invalidResponse(`Voyage embedding vectors must contain ${VOYAGE_EMBEDDING_DIMENSIONS} finite numbers.`);
      }
      const index = (entry as { index?: unknown }).index;
      return {
        index: typeof index === "number" && Number.isInteger(index) ? index : responseIndex,
        embedding: embedding as number[],
      };
    })
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.embedding);

  const usage = (value as { usage?: unknown }).usage;
  const totalTokens =
    usage && typeof usage === "object" && typeof (usage as { total_tokens?: unknown }).total_tokens === "number"
      ? Math.max(0, Math.floor((usage as { total_tokens: number }).total_tokens))
      : 0;
  return { vectors, totalTokens };
}

function normalizeVector(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw invalidResponse("Voyage returned an embedding with zero or invalid magnitude.");
  }
  return vector.map((value) => value / magnitude);
}

function invalidResponse(message: string): VoyageEmbeddingProviderError {
  return new VoyageEmbeddingProviderError(message, { kind: "invalid-response", retryable: false });
}

function toVoyageError(error: unknown): VoyageEmbeddingProviderError {
  return error instanceof VoyageEmbeddingProviderError
    ? error
    : new VoyageEmbeddingProviderError("Voyage embedding request failed.", {
        kind: "upstream",
        retryable: true,
        cause: error,
      });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
