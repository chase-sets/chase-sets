import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

// Domain-neutral private storage with explicit, bounded outcomes. Callers own key, manifest and
// lifecycle policy; nothing here grants a Stored fact on its own.

const PRIVATE_OBJECT_CACHE_CONTROL = "private, no-store";
export const MAX_PRIVATE_LIST_KEYS = 1000;
export const MAX_PRIVATE_DELETE_KEYS = 1000;

export type PrivateObjectFailureCode =
  | "deadline-exceeded"
  | "transport-failed"
  | "access-denied"
  | "throttled"
  | "provider-error"
  | "invalid-response"
  | "filesystem-error";

export type PrivatePutInput = Readonly<{
  key: string;
  body: Uint8Array;
  contentType: string;
  deadlineMs: number;
}>;

/**
 * `completed` and `failed` settle only on an actual provider response; neither authorizes a
 * consumer Stored fact, and `failed` does not prove that no bytes exist under the key.
 * `ambiguous` never proves that the remote write stopped.
 */
export type PrivatePutResult =
  | Readonly<{ status: "completed"; key: string }>
  | Readonly<{ status: "failed"; key: string; code: PrivateObjectFailureCode }>
  | Readonly<{ status: "ambiguous"; key: string; reason: "deadline-exceeded" | "transport-failed" | "invalid-response" }>;

export type PrivateReadOptions = Readonly<{ maxBytes: number; deadlineMs: number }>;

export type PrivateReadResult =
  | Readonly<{ status: "found"; body: Uint8Array; byteSize: number; providerContentType: string | null }>
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "too-large" }>
  | Readonly<{ status: "unavailable"; code: PrivateObjectFailureCode }>;

export type PrivateVerifyExpectation = Readonly<{
  sha256: string;
  byteSize: number;
  contentType: string;
  deadlineMs: number;
}>;

/** Detects corruption by reading actual bytes; it is never a compare-and-swap. */
export type PrivateVerifyResult =
  | Readonly<{ status: "match" }>
  | Readonly<{ status: "conflict"; difference: "byte-size" | "sha256" | "content-type" }>
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "unavailable"; code: PrivateObjectFailureCode | "content-type-missing" }>;

export type PrivateListInput = Readonly<{
  prefix: string;
  continuationToken?: string;
  maxKeys: number;
}>;

export type PrivateListEntry = Readonly<{ key: string; byteSize: number }>;

export type PrivateListIncompleteReason =
  | "page-failed"
  | "truncated-without-token"
  | "repeated-token"
  | "out-of-prefix-key"
  | "invalid-page";

export type PrivateListResult =
  | Readonly<{ status: "page"; entries: readonly PrivateListEntry[]; nextContinuationToken: string | null }>
  | Readonly<{ status: "list-incomplete"; reason: PrivateListIncompleteReason; code?: PrivateObjectFailureCode }>;

export type PrivateDeleteOutcome =
  | Readonly<{ key: string; status: "deleted" }>
  | Readonly<{ key: string; status: "absent" }>
  | Readonly<{ key: string; status: "failed"; code: PrivateObjectFailureCode }>;

export type PrivateObjectStore = Readonly<{
  putPrivate(input: PrivatePutInput): Promise<PrivatePutResult>;
  readPrivate(key: string, options: PrivateReadOptions): Promise<PrivateReadResult>;
  verifyPrivate(key: string, expected: PrivateVerifyExpectation): Promise<PrivateVerifyResult>;
  listPrivate(input: PrivateListInput): Promise<PrivateListResult>;
  deleteKeys(keys: readonly string[]): Promise<readonly PrivateDeleteOutcome[]>;
}>;

export type FilesystemPrivateObjectStoreOptions = Readonly<{ rootDir: string }>;

export type S3PrivateObjectStoreOptions = Readonly<{
  bucket: string;
  client: Pick<S3Client, "send">;
}>;

type RawListPage = Readonly<{
  entries: ReadonlyArray<Readonly<{ key: string | undefined; byteSize: number | undefined }>>;
  isTruncated: boolean | undefined;
  nextContinuationToken: string | undefined;
  keyCount: number | undefined;
}>;

// Internally an oversized read keeps the provider type so verification can refuse a typeless response.
type BackendReadResult =
  | Exclude<PrivateReadResult, Readonly<{ status: "too-large" }>>
  | Readonly<{ status: "too-large"; providerContentType: string | null }>;

type StoreBackend = Readonly<{
  suppliesContentType: boolean;
  put(input: PrivatePutInput, deadline: Deadline): Promise<PrivatePutResult>;
  read(key: string, maxBytes: number, deadline: Deadline): Promise<BackendReadResult>;
  list(input: PrivateListInput): Promise<RawListPage | PrivateListResult>;
  delete(keys: readonly string[]): Promise<readonly PrivateDeleteOutcome[]>;
}>;

const MAX_TIMER_MS = 2_147_483_647;
const MAX_KEY_BYTES = 1024;
const FILESYSTEM_TEMP_DIR = ".private-object-store-tmp";
const FILESYSTEM_TOKEN_PREFIX = "fs1.";
const FILESYSTEM_READ_CHUNK_BYTES = 64 * 1024;

export function createS3PrivateObjectStore(options: S3PrivateObjectStoreOptions): PrivateObjectStore {
  const { bucket, client } = options;

  return createPrivateObjectStore({
    suppliesContentType: true,
    async put(input, deadline) {
      const raced = await deadline.race(
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            Body: input.body,
            ContentType: input.contentType,
            CacheControl: PRIVATE_OBJECT_CACHE_CONTROL,
          }),
          { abortSignal: deadline.signal },
        ),
      );
      if (raced.kind === "value") {
        return { status: "completed", key: input.key };
      }
      if (raced.kind === "deadline" || deadline.isExpired()) {
        return { status: "ambiguous", key: input.key, reason: "deadline-exceeded" };
      }
      const status = providerStatus(raced.error);
      if (status === undefined) {
        return { status: "ambiguous", key: input.key, reason: "transport-failed" };
      }
      // An error thrown around a 2xx status means the provider accepted the request but its reply was unreadable.
      if (status < 300) {
        return { status: "ambiguous", key: input.key, reason: "invalid-response" };
      }
      return { status: "failed", key: input.key, code: providerFailureCode(status, raced.error) };
    },
    async read(key, maxBytes, deadline) {
      const raced = await deadline.race(
        client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: deadline.signal }),
      );
      if (raced.kind === "deadline") {
        return unavailable("deadline-exceeded");
      }
      if (raced.kind === "error") {
        if (deadline.isExpired()) {
          return unavailable("deadline-exceeded");
        }
        const status = providerStatus(raced.error);
        if (status === 404 && errorName(raced.error) !== "NoSuchBucket") {
          return { status: "absent" };
        }
        return unavailable(status === undefined ? "transport-failed" : providerFailureCode(status, raced.error));
      }
      const response = raced.value;
      if (!response.Body || !isAsyncIterable(response.Body)) {
        return unavailable("invalid-response");
      }
      // Missing or empty provider metadata stays null: a key-derived type would certify nothing.
      const providerContentType = response.ContentType || null;
      const bytes = await readBoundedChunks(response.Body, maxBytes, deadline);
      return bytes.status === "unavailable" ? bytes : { ...bytes, providerContentType };
    },
    async list(input) {
      try {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ...(input.prefix ? { Prefix: input.prefix } : {}),
            MaxKeys: input.maxKeys,
            ...(input.continuationToken ? { ContinuationToken: input.continuationToken } : {}),
          }),
        );
        return {
          entries: (response.Contents ?? []).map((entry) => ({ key: entry.Key, byteSize: entry.Size })),
          isTruncated: response.IsTruncated,
          nextContinuationToken: response.NextContinuationToken,
          keyCount: response.KeyCount,
        };
      } catch (error) {
        return { status: "list-incomplete", reason: "page-failed", code: requestFailureCode(error) };
      }
    },
    async delete(keys) {
      let response;
      try {
        response = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: false },
          }),
        );
      } catch (error) {
        const code = requestFailureCode(error);
        return keys.map((key) => ({ key, status: "failed", code }));
      }
      const deleted = new Set((response.Deleted ?? []).map((entry) => entry.Key));
      const errors = new Map((response.Errors ?? []).map((entry) => [entry.Key, entry.Code]));
      // HTTP success alone is not deletion: each key needs exactly one provider report.
      return keys.map((key): PrivateDeleteOutcome => {
        const errorCode = errors.get(key);
        if (errors.has(key) === deleted.has(key)) {
          return { key, status: "failed", code: "invalid-response" };
        }
        if (!errors.has(key)) {
          return { key, status: "deleted" };
        }
        return errorCode === "NoSuchKey"
          ? { key, status: "absent" }
          : { key, status: "failed", code: providerFailureCode(undefined, { name: errorCode }) };
      });
    },
  });
}

export function createFilesystemPrivateObjectStore(options: FilesystemPrivateObjectStoreOptions): PrivateObjectStore {
  const rootDir = path.resolve(options.rootDir);
  const objectPath = (key: string) => path.join(rootDir, ...key.split("/"));

  return createPrivateObjectStore({
    suppliesContentType: false,
    async put(input, deadline) {
      const raced = await deadline.race(writeFileAtomically(rootDir, objectPath(input.key), input.body));
      if (raced.kind === "deadline") {
        return { status: "ambiguous", key: input.key, reason: "deadline-exceeded" };
      }
      if (raced.kind === "error") {
        return { status: "failed", key: input.key, code: "filesystem-error" };
      }
      return { status: "completed", key: input.key };
    },
    async read(key, maxBytes, deadline) {
      const raced = await deadline.race(readFileBounded(objectPath(key), maxBytes, deadline));
      if (raced.kind === "deadline") {
        return unavailable("deadline-exceeded");
      }
      if (raced.kind === "error") {
        return isMissingPathError(raced.error) ? { status: "absent" } : unavailable("filesystem-error");
      }
      return raced.value;
    },
    async list(input) {
      const after = input.continuationToken === undefined ? null : decodeFilesystemToken(input.continuationToken);
      if (after === undefined || (after !== null && !after.startsWith(input.prefix))) {
        return { status: "list-incomplete", reason: "invalid-page" };
      }
      try {
        const directoryKey = input.prefix.slice(0, input.prefix.lastIndexOf("/") + 1);
        const keys = (await listFileKeys(rootDir, directoryKey))
          .filter((key) => key.startsWith(input.prefix) && (after === null || compareKeys(key, after) > 0))
          .sort(compareKeys);
        const page = keys.slice(0, input.maxKeys);
        const isTruncated = keys.length > page.length;
        const entries = await Promise.all(
          page.map(async (key) => ({ key, byteSize: (await stat(objectPath(key))).size })),
        );
        return {
          entries,
          isTruncated,
          nextContinuationToken: isTruncated ? encodeFilesystemToken(page.at(-1) ?? "") : undefined,
          keyCount: entries.length,
        };
      } catch {
        return { status: "list-incomplete", reason: "page-failed", code: "filesystem-error" };
      }
    },
    async delete(keys) {
      return Promise.all(
        keys.map(async (key): Promise<PrivateDeleteOutcome> => {
          const filePath = objectPath(key);
          try {
            if (!(await lstat(filePath)).isFile()) {
              return { key, status: "absent" };
            }
            await unlink(filePath);
            return { key, status: "deleted" };
          } catch (error) {
            return isMissingPathError(error) ? { key, status: "absent" } : { key, status: "failed", code: "filesystem-error" };
          }
        }),
      );
    },
  });
}

function createPrivateObjectStore(backend: StoreBackend): PrivateObjectStore {
  return {
    async putPrivate(input) {
      requireCanonicalKey(input.key);
      requireContentType(input.contentType);
      requireDeadline(input.deadlineMs);
      return withDeadline(input.deadlineMs, (deadline) => backend.put(input, deadline));
    },
    async readPrivate(key, options) {
      requireCanonicalKey(key);
      requireByteBound(options.maxBytes);
      requireDeadline(options.deadlineMs);
      const read = await withDeadline(options.deadlineMs, (deadline) => backend.read(key, options.maxBytes, deadline));
      return read.status === "too-large" ? { status: "too-large" } : read;
    },
    async verifyPrivate(key, expected) {
      requireCanonicalKey(key);
      requireSha256(expected.sha256);
      requireByteBound(expected.byteSize);
      requireContentType(expected.contentType);
      requireDeadline(expected.deadlineMs);
      const read = await withDeadline(expected.deadlineMs, (deadline) => backend.read(key, expected.byteSize, deadline));
      return compareRead(read, expected, backend.suppliesContentType);
    },
    async listPrivate(input) {
      requireListPrefix(input.prefix);
      requireMaxKeys(input.maxKeys);
      if (input.continuationToken !== undefined && (typeof input.continuationToken !== "string" || input.continuationToken === "")) {
        throw new Error("Private object continuation tokens must be non-empty strings.");
      }
      const page = await backend.list(input);
      return "status" in page ? page : settleListPage(input, page);
    },
    async deleteKeys(keys) {
      if (keys.length > MAX_PRIVATE_DELETE_KEYS) {
        throw new Error(`Private object deletes accept at most ${MAX_PRIVATE_DELETE_KEYS} keys.`);
      }
      keys.forEach(requireCanonicalKey);
      if (new Set(keys).size !== keys.length) {
        throw new Error("Private object deletes require distinct keys.");
      }
      return keys.length === 0 ? [] : backend.delete(keys);
    },
  };
}

function compareRead(
  read: BackendReadResult,
  expected: PrivateVerifyExpectation,
  suppliesContentType: boolean,
): PrivateVerifyResult {
  if (read.status === "absent" || read.status === "unavailable") {
    return read;
  }
  // A provider that supplies type metadata must actually return it; a missing type can never match.
  if (suppliesContentType && read.providerContentType === null) {
    return { status: "unavailable", code: "content-type-missing" };
  }
  if (read.status === "too-large" || read.byteSize !== expected.byteSize) {
    return { status: "conflict", difference: "byte-size" };
  }
  if (createHash("sha256").update(read.body).digest("hex") !== expected.sha256) {
    return { status: "conflict", difference: "sha256" };
  }
  if (suppliesContentType && read.providerContentType !== expected.contentType) {
    return { status: "conflict", difference: "content-type" };
  }
  return { status: "match" };
}

function settleListPage(input: PrivateListInput, page: RawListPage): PrivateListResult {
  const incomplete = (reason: PrivateListIncompleteReason): PrivateListResult => ({ status: "list-incomplete", reason });
  if (page.isTruncated === undefined || (!page.isTruncated && page.nextContinuationToken !== undefined)) {
    return incomplete("invalid-page");
  }
  if (page.isTruncated && !page.nextContinuationToken) {
    return incomplete("truncated-without-token");
  }
  if (page.isTruncated && page.nextContinuationToken === input.continuationToken) {
    return incomplete("repeated-token");
  }
  if (page.entries.length > input.maxKeys || (page.keyCount !== undefined && page.keyCount !== page.entries.length)) {
    return incomplete("invalid-page");
  }
  const entries: PrivateListEntry[] = [];
  const seen = new Set<string>();
  for (const { key, byteSize } of page.entries) {
    if (key === undefined || byteSize === undefined || !Number.isSafeInteger(byteSize) || byteSize < 0) {
      return incomplete("invalid-page");
    }
    if (!key.startsWith(input.prefix)) {
      return incomplete("out-of-prefix-key");
    }
    if (!isCanonicalKey(key) || seen.has(key)) {
      return incomplete("invalid-page");
    }
    seen.add(key);
    entries.push({ key, byteSize });
  }
  return { status: "page", entries, nextContinuationToken: page.isTruncated ? (page.nextContinuationToken ?? null) : null };
}

type Raced<T> =
  | Readonly<{ kind: "value"; value: T }>
  | Readonly<{ kind: "error"; error: unknown }>
  | Readonly<{ kind: "deadline" }>;

type Deadline = Readonly<{
  signal: AbortSignal;
  /** Also consults the clock, so work that never yields to timers still observes the deadline. */
  isExpired(): boolean;
  race<T>(work: Promise<T>): Promise<Raced<T>>;
}>;

async function withDeadline<T>(deadlineMs: number, run: (deadline: Deadline) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const expiresAt = performance.now() + deadlineMs;
  let expired = false;
  let announceExpiry: () => void = () => undefined;
  const expiry = new Promise<Raced<never>>((resolve) => {
    announceExpiry = () => resolve({ kind: "deadline" });
  });
  const expire = () => {
    if (!expired) {
      expired = true;
      announceExpiry();
      controller.abort();
    }
  };
  const timer = setTimeout(expire, deadlineMs);
  try {
    return await run({
      signal: controller.signal,
      isExpired() {
        if (!expired && performance.now() >= expiresAt) {
          expire();
        }
        return expired;
      },
      race: (work) =>
        Promise.race([
          work.then(
            (value) => ({ kind: "value" as const, value }),
            (error: unknown) => ({ kind: "error" as const, error }),
          ),
          expiry,
        ]),
    });
  } finally {
    clearTimeout(timer);
  }
}

type BoundedRead =
  | Readonly<{ status: "found"; body: Uint8Array; byteSize: number }>
  | Readonly<{ status: "too-large" }>
  | Readonly<{ status: "unavailable"; code: PrivateObjectFailureCode }>;

async function readBoundedChunks(body: AsyncIterable<unknown>, maxBytes: number, deadline: Deadline): Promise<BoundedRead> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  let finished = false;
  try {
    for (;;) {
      const next = await deadline.race(iterator.next());
      if (next.kind === "deadline" || deadline.isExpired()) {
        return unavailable("deadline-exceeded");
      }
      if (next.kind === "error") {
        return unavailable("transport-failed");
      }
      if (next.value.done) {
        finished = true;
        return { status: "found", body: concatBytes(chunks, byteSize), byteSize };
      }
      const chunk = next.value.value;
      if (!(chunk instanceof Uint8Array)) {
        return unavailable("invalid-response");
      }
      byteSize += chunk.byteLength;
      if (byteSize > maxBytes) {
        return { status: "too-large" };
      }
      chunks.push(chunk);
    }
  } finally {
    if (!finished) {
      // Stop pulling: never await the iterator here, since a stalled stream may never settle.
      (body as { destroy?: () => void }).destroy?.();
      void iterator.return?.().catch(() => undefined);
    }
  }
}

async function readFileBounded(filePath: string, maxBytes: number, deadline: Deadline): Promise<BackendReadResult> {
  const handle = await open(filePath, "r");
  try {
    const chunks: Uint8Array[] = [];
    let byteSize = 0;
    for (;;) {
      if (deadline.isExpired()) {
        return unavailable("deadline-exceeded");
      }
      const buffer = Buffer.alloc(Math.min(FILESYSTEM_READ_CHUNK_BYTES, maxBytes + 1 - byteSize));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        return { status: "found", body: concatBytes(chunks, byteSize), byteSize, providerContentType: null };
      }
      byteSize += bytesRead;
      if (byteSize > maxBytes) {
        return { status: "too-large", providerContentType: null };
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

async function writeFileAtomically(rootDir: string, targetPath: string, body: Uint8Array): Promise<void> {
  const tempDir = path.join(rootDir, FILESYSTEM_TEMP_DIR);
  const tempPath = path.join(tempDir, randomUUID());
  await mkdir(tempDir, { recursive: true });
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameReplacing(tempPath, targetPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function renameReplacing(sourcePath: string, targetPath: string): Promise<void> {
  // Windows refuses to replace a file another handle holds open; a concurrent identical writer or reader clears quickly.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 5));
    }
  }
}

async function listFileKeys(rootDir: string, directoryKey: string): Promise<string[]> {
  const keys: string[] = [];
  const walk = async (relativeDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(rootDir, ...relativeDir.split("/").filter(Boolean)), { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const key = `${relativeDir}${entry.name}`;
      if (key === FILESYSTEM_TEMP_DIR) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(`${key}/`);
      } else if (entry.isFile()) {
        keys.push(key);
      }
    }
  };
  await walk(directoryKey);
  return keys;
}

function concatBytes(chunks: readonly Uint8Array[], byteSize: number): Uint8Array {
  const bytes = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function encodeFilesystemToken(lastKey: string): string {
  return `${FILESYSTEM_TOKEN_PREFIX}${Buffer.from(lastKey, "utf8").toString("base64url")}`;
}

/** Returns undefined for a token this store did not issue. */
function decodeFilesystemToken(token: string): string | undefined {
  if (!token.startsWith(FILESYSTEM_TOKEN_PREFIX)) {
    return undefined;
  }
  const key = Buffer.from(token.slice(FILESYSTEM_TOKEN_PREFIX.length), "base64url").toString("utf8");
  return isCanonicalKey(key) && encodeFilesystemToken(key) === token ? key : undefined;
}

/** Provider key order: UTF-8 byte order rather than UTF-16 code units. */
function compareKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function isMissingPathError(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function providerStatus(error: unknown): number | undefined {
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | undefined)?.$metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function errorName(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? name : undefined;
}

/** Bounded codes only: provider messages and raw codes never leave this module. */
function providerFailureCode(status: number | undefined, error: unknown): PrivateObjectFailureCode {
  const name = errorName(error);
  if (status === 403 || name === "AccessDenied") {
    return "access-denied";
  }
  if (status === 429 || status === 503 || name === "SlowDown" || name === "ServiceUnavailable") {
    return "throttled";
  }
  return "provider-error";
}

function requestFailureCode(error: unknown): PrivateObjectFailureCode {
  const status = providerStatus(error);
  if (status === undefined) {
    return "transport-failed";
  }
  return status < 300 ? "invalid-response" : providerFailureCode(status, error);
}

function unavailable(code: PrivateObjectFailureCode): Readonly<{ status: "unavailable"; code: PrivateObjectFailureCode }> {
  return { status: "unavailable", code };
}

/** Canonical keys are exactly what `normalizeObjectKey` would return, so one object never has two spellings. */
function isCanonicalKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    Buffer.byteLength(key, "utf8") <= MAX_KEY_BYTES &&
    !/[\u0000-\u001f\u007f\\]/.test(key) &&
    key.split("/").every((segment) => segment.length > 0) &&
    !key.startsWith(".") &&
    !key.includes("../") &&
    !key.includes("/..")
  );
}

function requireCanonicalKey(key: string): void {
  if (!isCanonicalKey(key)) {
    throw new Error("Private object keys must be canonical relative paths without traversal.");
  }
}

function requireListPrefix(prefix: string): void {
  // A prefix is valid when some canonical key can extend it; the empty prefix lists the whole store.
  if (typeof prefix !== "string" || (prefix !== "" && !isCanonicalKey(`${prefix}_`))) {
    throw new Error("Private object list prefixes must extend to canonical keys.");
  }
}

function requireContentType(contentType: string): void {
  if (typeof contentType !== "string" || contentType.length === 0 || contentType.length > 255 || /[\u0000-\u001f\u007f]/.test(contentType)) {
    throw new Error("Private object content types must be non-empty header-safe strings.");
  }
}

function requireDeadline(deadlineMs: number): void {
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_TIMER_MS) {
    throw new Error("Private object deadlines must be finite positive milliseconds within the timer range.");
  }
}

function requireByteBound(bytes: number): void {
  // maxBytes + 1 must stay exact, so the bound itself stays below the largest safe integer.
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Private object byte bounds must be non-negative safe integers.");
  }
}

function requireSha256(sha256: string): void {
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("Private object SHA-256 digests must be 64 lowercase hex characters.");
  }
}

function requireMaxKeys(maxKeys: number): void {
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_PRIVATE_LIST_KEYS) {
    throw new Error(`Private object list pages must request between 1 and ${MAX_PRIVATE_LIST_KEYS} keys.`);
  }
}
