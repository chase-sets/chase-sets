import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
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
  | Readonly<{
      status: "ambiguous";
      key: string;
      reason: "deadline-exceeded" | "transport-failed" | "invalid-response";
    }>;

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

type DeleteReport = Readonly<{ deleted: true } | { deleted: false; code: string | undefined }>;

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
      const raced = await deadline.race(() =>
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
      if (raced.kind === "deadline") {
        return { status: "ambiguous", key: input.key, reason: "deadline-exceeded" };
      }
      if (raced.kind === "value") {
        return { status: "completed", key: input.key };
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
      const raced = await deadline.race(() =>
        client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: deadline.signal }),
      );
      if (raced.kind === "deadline") {
        return unavailable("deadline-exceeded");
      }
      if (raced.kind === "error") {
        const status = providerStatus(raced.error);
        if (status === 404 && errorName(raced.error) !== "NoSuchBucket") {
          return { status: "absent" };
        }
        return unavailable(status === undefined ? "transport-failed" : providerFailureCode(status, raced.error));
      }
      const response = raced.value;
      // Only a byte-mode Node stream lets each read request a size; any other body could hand over unbounded chunks.
      if (!(response.Body instanceof Readable) || response.Body.readableObjectMode) {
        return unavailable("invalid-response");
      }
      // Missing or empty provider metadata stays null: a key-derived type would certify nothing.
      const providerContentType = response.ContentType || null;
      const bytes = await readBoundedStream(response.Body, maxBytes, deadline);
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
      // HTTP success alone is not deletion: each key needs exactly one provider report across Deleted and Errors,
      // so a duplicate can neither hide an error nor repeat a success.
      const reports = new Map<string | undefined, DeleteReport[]>();
      const report = (key: string | undefined, outcome: DeleteReport) =>
        reports.set(key, [...(reports.get(key) ?? []), outcome]);
      for (const entry of response.Deleted ?? []) {
        report(entry.Key, { deleted: true });
      }
      for (const entry of response.Errors ?? []) {
        report(entry.Key, { deleted: false, code: entry.Code });
      }
      return keys.map((key): PrivateDeleteOutcome => {
        const [outcome, ...duplicates] = reports.get(key) ?? [];
        if (outcome === undefined || duplicates.length > 0) {
          return { key, status: "failed", code: "invalid-response" };
        }
        if (outcome.deleted) {
          return { key, status: "deleted" };
        }
        return outcome.code === "NoSuchKey"
          ? { key, status: "absent" }
          : { key, status: "failed", code: providerFailureCode(undefined, { name: outcome.code }) };
      });
    },
  });
}

export function createFilesystemPrivateObjectStore(options: FilesystemPrivateObjectStoreOptions): PrivateObjectStore {
  const rootDir = path.resolve(options.rootDir);

  return createPrivateObjectStore({
    suppliesContentType: false,
    async put(input, deadline) {
      const raced = await deadline.race(() => writeFileAtomically(rootDir, input.key, input.body, deadline));
      if (raced.kind === "deadline") {
        return { status: "ambiguous", key: input.key, reason: "deadline-exceeded" };
      }
      if (raced.kind === "error") {
        return { status: "failed", key: input.key, code: "filesystem-error" };
      }
      return { status: "completed", key: input.key };
    },
    async read(key, maxBytes, deadline) {
      const raced = await deadline.race(async (): Promise<BackendReadResult> => {
        const object = await containedObject(rootDir, key);
        return object.stats.isFile() ? readFileBounded(object.filePath, maxBytes, deadline) : { status: "absent" };
      });
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
        const files = (await listFiles(rootDir, directoryKey))
          .filter(({ key }) => key.startsWith(input.prefix) && (after === null || compareKeys(key, after) > 0))
          .sort((left, right) => compareKeys(left.key, right.key));
        const page = files.slice(0, input.maxKeys);
        const isTruncated = files.length > page.length;
        const entries = await Promise.all(
          page.map(async ({ key, filePath }) => ({ key, byteSize: (await lstat(filePath)).size })),
        );
        return {
          entries,
          isTruncated,
          nextContinuationToken: isTruncated ? encodeFilesystemToken(page.at(-1)?.key ?? "") : undefined,
          keyCount: entries.length,
        };
      } catch {
        return { status: "list-incomplete", reason: "page-failed", code: "filesystem-error" };
      }
    },
    async delete(keys) {
      return Promise.all(
        keys.map(async (key): Promise<PrivateDeleteOutcome> => {
          try {
            const object = await containedObject(rootDir, key);
            if (!object.stats.isFile()) {
              return { key, status: "absent" };
            }
            await unlink(object.filePath);
            return { key, status: "deleted" };
          } catch (error) {
            return isMissingPathError(error)
              ? { key, status: "absent" }
              : { key, status: "failed", code: "filesystem-error" };
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
      const read = await withDeadline(expected.deadlineMs, (deadline) =>
        backend.read(key, expected.byteSize, deadline),
      );
      return compareRead(read, expected, backend.suppliesContentType);
    },
    async listPrivate(input) {
      requireListPrefix(input.prefix);
      requireMaxKeys(input.maxKeys);
      if (
        input.continuationToken !== undefined &&
        (typeof input.continuationToken !== "string" || input.continuationToken === "")
      ) {
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
  const incomplete = (reason: PrivateListIncompleteReason): PrivateListResult => ({
    status: "list-incomplete",
    reason,
  });
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
  return {
    status: "page",
    entries,
    nextContinuationToken: page.isTruncated ? (page.nextContinuationToken ?? null) : null,
  };
}

type Raced<T> =
  | Readonly<{ kind: "value"; value: T }>
  | Readonly<{ kind: "error"; error: unknown }>
  | Readonly<{ kind: "deadline" }>;

type Deadline = Readonly<{
  signal: AbortSignal;
  /** Also consults the clock, so work that never yields to timers still observes the deadline. */
  isExpired(): boolean;
  /**
   * Starts the work inside the race, so a synchronous throw settles like a rejection, and reports the deadline
   * for anything that settles after the monotonic expiry, even while a starved expiry timer has not yet fired.
   */
  race<T>(start: () => Promise<T>): Promise<Raced<T>>;
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
  const isExpired = () => {
    if (!expired && performance.now() >= expiresAt) {
      expire();
    }
    return expired;
  };
  const timer = setTimeout(expire, deadlineMs);
  try {
    return await run({
      signal: controller.signal,
      isExpired,
      race: async <T>(start: () => Promise<T>): Promise<Raced<T>> => {
        const raced = await Promise.race([
          new Promise<T>((resolve) => resolve(start())).then(
            (value): Raced<T> => ({ kind: "value", value }),
            (error: unknown): Raced<T> => ({ kind: "error", error }),
          ),
          expiry,
        ]);
        return isExpired() ? { kind: "deadline" } : raced;
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

type BoundedRead =
  | Readonly<{ status: "found"; body: Uint8Array; byteSize: number }>
  | Readonly<{ status: "too-large" }>
  | Readonly<{ status: "unavailable"; code: PrivateObjectFailureCode }>;

async function readBoundedStream(stream: Readable, maxBytes: number, deadline: Deadline): Promise<BoundedRead> {
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  let finished = false;
  // The store now owns the body: a stream error settles below and never escapes as an unhandled event.
  stream.on("error", () => undefined);
  try {
    for (;;) {
      // A source can refill synchronously inside read(), so the clock is consulted before every read, not only on waits.
      if (deadline.isExpired()) {
        return unavailable("deadline-exceeded");
      }
      // Take only buffered bytes within the remaining maxBytes + 1 budget, however large the provider's chunks are;
      // read(0) never returns data and only asks the stream to fill or to announce its end.
      const chunk: unknown = stream.read(Math.min(maxBytes + 1 - byteSize, stream.readableLength));
      if (chunk !== null) {
        if (!(chunk instanceof Uint8Array)) {
          return unavailable("invalid-response");
        }
        byteSize += chunk.byteLength;
        if (byteSize > maxBytes) {
          return { status: "too-large" };
        }
        chunks.push(chunk);
        continue;
      }
      if (stream.readableEnded) {
        finished = true;
        return { status: "found", body: concatBytes(chunks, byteSize), byteSize };
      }
      if (stream.errored || stream.destroyed) {
        return unavailable("transport-failed");
      }
      const event = await deadline.race(() => nextStreamEvent(stream));
      if (event.kind === "deadline") {
        return unavailable("deadline-exceeded");
      }
      if (event.kind === "error" || event.value === "failed") {
        return unavailable("transport-failed");
      }
    }
  } finally {
    if (!finished) {
      // Stop pulling without awaiting: a stalled stream may never settle.
      stream.destroy();
    }
  }
}

function nextStreamEvent(stream: Readable): Promise<"readable" | "end" | "failed"> {
  return new Promise((resolve) => {
    const settle = (event: "readable" | "end" | "failed") => () => {
      stream.off("readable", onReadable).off("end", onEnd).off("error", onFailed).off("close", onFailed);
      resolve(event);
    };
    const onReadable = settle("readable");
    const onEnd = settle("end");
    const onFailed = settle("failed");
    stream.once("readable", onReadable).once("end", onEnd).once("error", onFailed).once("close", onFailed);
  });
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

async function writeFileAtomically(rootDir: string, key: string, body: Uint8Array, deadline: Deadline): Promise<void> {
  // The configured root itself is trusted, even when it is a link; containment starts at its real path.
  await mkdir(rootDir, { recursive: true });
  const realRoot = await realpath(rootDir);
  const segments = key.split("/");
  const tempPath = path.join(await containedDirectory(realRoot, [FILESYSTEM_TEMP_DIR], true), randomUUID());
  const targetPath = path.join(await containedDirectory(realRoot, segments.slice(0, -1), true), segments.at(-1) ?? "");
  // Rename replaces an existing entry rather than writing through it, but a linked target is still refused.
  await requireContained(realRoot, targetPath).catch((error: unknown) => {
    if (!isMissingPathError(error)) {
      throw error;
    }
  });
  try {
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameReplacing(tempPath, targetPath, deadline);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function renameReplacing(sourcePath: string, targetPath: string, deadline: Deadline): Promise<void> {
  // Windows refuses to replace a file while another reader or writer holds it, so retry until the caller's deadline.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code) || deadline.isExpired()) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 5, 50)));
    }
  }
}

async function listFiles(rootDir: string, directoryKey: string): Promise<Array<{ key: string; filePath: string }>> {
  const files: Array<{ key: string; filePath: string }> = [];
  let realRoot: string;
  let startDirectory: string;
  try {
    realRoot = await realpath(rootDir);
    startDirectory = await containedDirectory(realRoot, directoryKey.split("/").filter(Boolean), false);
  } catch (error) {
    if (isMissingPathError(error)) {
      return files;
    }
    throw error;
  }
  const walk = async (relativeDir: string, directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const key = `${relativeDir}${entry.name}`;
      const entryPath = path.join(directory, entry.name);
      if (key === FILESYSTEM_TEMP_DIR) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw linkRefused();
      }
      if (entry.isDirectory()) {
        await requireContained(realRoot, entryPath);
        await walk(`${key}/`, entryPath);
      } else if (entry.isFile()) {
        files.push({ key, filePath: entryPath });
      }
    }
  };
  await walk(directoryKey, startDirectory);
  return files;
}

/** Resolves an existing object below the real root; a missing component surfaces as the filesystem's own error. */
async function containedObject(rootDir: string, key: string): Promise<Readonly<{ filePath: string; stats: Stats }>> {
  const realRoot = await realpath(rootDir);
  const segments = key.split("/");
  const filePath = path.join(await containedDirectory(realRoot, segments.slice(0, -1), false), segments.at(-1) ?? "");
  return { filePath, stats: await requireContained(realRoot, filePath) };
}

async function containedDirectory(realRoot: string, segments: readonly string[], create: boolean): Promise<string> {
  let directory = realRoot;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    if (create) {
      await mkdir(directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      });
    }
    // Checked after creation too, so a link planted in place of a new directory is never used.
    await requireContained(realRoot, directory);
  }
  return directory;
}

/**
 * Key spelling never proves containment: each component below the real root must itself be a non-link entry whose
 * real path stays inside the root, so a planted symlink, junction or redirecting reparse point is refused.
 */
async function requireContained(realRoot: string, candidate: string): Promise<Stats> {
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink()) {
    throw linkRefused();
  }
  const relative = path.relative(realRoot, await realpath(candidate));
  if (relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)) {
    throw linkRefused();
  }
  return stats;
}

function linkRefused(): Error {
  return new Error("Filesystem private object paths must not pass through a link or leave the store root.");
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

function unavailable(
  code: PrivateObjectFailureCode,
): Readonly<{ status: "unavailable"; code: PrivateObjectFailureCode }> {
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
  if (
    typeof contentType !== "string" ||
    contentType.length === 0 ||
    contentType.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(contentType)
  ) {
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
