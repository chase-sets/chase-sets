import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  NoSuchKey,
  PutObjectCommand,
  type PutObjectCommandOutput,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFilesystemPrivateObjectStore,
  createS3PrivateObjectStore,
  type PrivateListResult,
  type PrivateObjectStore,
} from "./index";

// Synthetic identities only: no real bucket, endpoint, credential or provider traffic.
const BUCKET = "synthetic-private-evidence";
const DEADLINE_MS = 5_000;
const SHORT_DEADLINE_MS = 30;
const RAW_PROVIDER_TEXT = "raw provider text synthetic-secret-token";
const AMBIENT_PROVIDER_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "ASSET_STORAGE_KIND",
] as const;

let tempDirs: string[] = [];

beforeEach(() => {
  for (const name of AMBIENT_PROVIDER_VARIABLES) {
    vi.stubEnv(name, undefined);
  }
  const missingConfig = path.join(os.tmpdir(), "chase-sets-private-store-no-provider-config");
  vi.stubEnv("AWS_CONFIG_FILE", missingConfig);
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", missingConfig);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("private object store: putPrivate (AC-C1)", () => {
  it("sends a private PUT with no ACL and returns no URL", async () => {
    const { client, sent } = recordingClient(async () => putOutput());
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    const result = await store.putPrivate({
      key: "support-evidence/case_1/att_1/abc.png",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      deadlineMs: DEADLINE_MS,
    });

    expect(result).toEqual({ status: "completed", key: "support-evidence/case_1/att_1/abc.png" });
    expect(sent).toHaveLength(1);
    const command = sent[0]?.command;
    expect(command).toBeInstanceOf(PutObjectCommand);
    const input = (command as PutObjectCommand).input;
    expect(input).toMatchObject({
      Bucket: BUCKET,
      Key: "support-evidence/case_1/att_1/abc.png",
      ContentType: "image/png",
      CacheControl: "private, no-store",
    });
    expect(input.Body).toEqual(new Uint8Array([1, 2, 3]));
    // Kills the acl-left-on mutant: the private put must not carry any ACL field.
    expect(input).not.toHaveProperty("ACL");
    expect(result).not.toHaveProperty("publicUrl");
  });

  it.each([
    ["missing", undefined],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["beyond the timer range", 2_147_483_648],
  ])("rejects a %s deadline before any provider or filesystem I/O", async (_label, deadlineMs) => {
    const { client, sent } = recordingClient(async () => putOutput());
    const rootDir = await tempRoot();
    const stores = [
      createS3PrivateObjectStore({ bucket: BUCKET, client }),
      createFilesystemPrivateObjectStore({ rootDir }),
    ];

    for (const store of stores) {
      await expect(
        store.putPrivate({
          key: "support-evidence/case_1/att_1/abc.png",
          body: new Uint8Array([1]),
          contentType: "image/png",
          deadlineMs: deadlineMs as number,
        }),
      ).rejects.toThrow("Private object deadlines must be finite positive milliseconds within the timer range.");
    }
    expect(sent).toHaveLength(0);
    await expect(readdir(rootDir)).resolves.toEqual([]);
  });

  it("rejects non-canonical keys and invalid content types before I/O", async () => {
    const { client, sent } = recordingClient(async () => putOutput());
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    for (const key of ["../escape.png", "support-evidence//double.png", "/leading.png", "a\\b.png", ".hidden", ""]) {
      await expect(
        store.putPrivate({ key, body: new Uint8Array([1]), contentType: "image/png", deadlineMs: DEADLINE_MS }),
      ).rejects.toThrow("Private object keys must be canonical relative paths without traversal.");
    }
    for (const contentType of ["", "image/png\r\nx-amz-acl: public-read"]) {
      await expect(
        store.putPrivate({ key: "support-evidence/a.png", body: new Uint8Array([1]), contentType, deadlineMs: DEADLINE_MS }),
      ).rejects.toThrow("Private object content types must be non-empty header-safe strings.");
    }
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["AccessDenied", 403, "access-denied"],
    ["SlowDown", 503, "throttled"],
    ["InternalError", 500, "provider-error"],
  ] as const)("maps a %s provider error response to bounded failed(%s)", async (name, status, code) => {
    const { client } = recordingClient(async () => {
      throw providerError(name, status);
    });
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    const result = await store.putPrivate({
      key: "support-evidence/a.png",
      body: new Uint8Array([1]),
      contentType: "image/png",
      deadlineMs: DEADLINE_MS,
    });

    expect(result).toEqual({ status: "failed", key: "support-evidence/a.png", code });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-token");
  });

  it("returns ambiguous, never completed or failed, when the provider holds the PUT past its deadline (kills ambiguous-as-failed)", async () => {
    const held = heldResponse<PutObjectCommandOutput>();
    const { client, sent } = recordingClient(() => held.promise);
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    const result = await store.putPrivate({
      key: "support-evidence/a.png",
      body: new Uint8Array([1]),
      contentType: "image/png",
      deadlineMs: SHORT_DEADLINE_MS,
    });

    expect(result).toEqual({ status: "ambiguous", key: "support-evidence/a.png", reason: "deadline-exceeded" });
    expect(sent[0]?.abortSignal?.aborted).toBe(true);
    // The held provider response arriving later cannot rewrite an already-returned outcome.
    held.resolve(putOutput());
    await held.promise;
    expect(result.status).toBe("ambiguous");
  });

  it("keeps ambiguous when the provider error arrives only after the deadline", async () => {
    const held = heldResponse<PutObjectCommandOutput>();
    const { client } = recordingClient(() => held.promise);
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    const pending = store.putPrivate({
      key: "support-evidence/a.png",
      body: new Uint8Array([1]),
      contentType: "image/png",
      deadlineMs: SHORT_DEADLINE_MS,
    });
    const result = await pending;
    held.reject(providerError("AccessDenied", 403));

    expect(result).toMatchObject({ status: "ambiguous", reason: "deadline-exceeded" });
  });

  it("returns ambiguous on transport loss without a provider response (kills transport-as-failed)", async () => {
    const { client } = recordingClient(async () => {
      throw transportError();
    });
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    const result = await store.putPrivate({
      key: "support-evidence/a.png",
      body: new Uint8Array([1]),
      contentType: "image/png",
      deadlineMs: DEADLINE_MS,
    });

    expect(result).toEqual({ status: "ambiguous", key: "support-evidence/a.png", reason: "transport-failed" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-token");
  });

  it("serializes through the real SDK as a PUT without an ACL header and with private, no-store", async () => {
    const requests: SyntheticRequest[] = [];
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: syntheticS3Client(async (request) => {
        requests.push(request);
        return { statusCode: 200, headers: { etag: '"synthetic"' } };
      }),
    });

    await expect(
      store.putPrivate({
        key: "support-evidence/case_1/att_1/abc.png",
        body: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
        deadlineMs: DEADLINE_MS,
      }),
    ).resolves.toEqual({ status: "completed", key: "support-evidence/case_1/att_1/abc.png" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "PUT", path: `/${BUCKET}/support-evidence/case_1/att_1/abc.png` });
    expect(requests[0]?.headers["cache-control"]).toBe("private, no-store");
    expect(requests[0]?.headers["content-type"]).toBe("image/png");
    expect(Object.keys(requests[0]?.headers ?? {}).filter((name) => name.toLowerCase().startsWith("x-amz-acl"))).toEqual(
      [],
    );
  });

  it("maps a real SDK 403 response to failed and an aborted in-flight request to ambiguous", async () => {
    const denied = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: syntheticS3Client(async () => xmlResponse(403, errorXml("AccessDenied"))),
    });
    await expect(
      denied.putPrivate({ key: "support-evidence/a.png", body: new Uint8Array([1]), contentType: "image/png", deadlineMs: DEADLINE_MS }),
    ).resolves.toEqual({ status: "failed", key: "support-evidence/a.png", code: "access-denied" });

    const stalled = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: syntheticS3Client((_request, abortSignal) => rejectOnAbort(abortSignal)),
    });
    await expect(
      stalled.putPrivate({
        key: "support-evidence/a.png",
        body: new Uint8Array([1]),
        contentType: "image/png",
        deadlineMs: SHORT_DEADLINE_MS,
      }),
    ).resolves.toEqual({ status: "ambiguous", key: "support-evidence/a.png", reason: "deadline-exceeded" });
  });

  it("writes filesystem objects by temp-file rename and lets identical concurrent writers both complete without a torn file", async () => {
    const rootDir = await tempRoot();
    const store = createFilesystemPrivateObjectStore({ rootDir });
    const key = "support-evidence/case_1/att_1/abc.bin";
    const body = Uint8Array.from({ length: 512 * 1024 }, (_, index) => index % 251);
    const expected = sha256Hex(body);
    let writing = true;
    const observedReads: string[] = [];
    const reader = (async () => {
      while (writing) {
        const read = await store.readPrivate(key, { maxBytes: body.byteLength, deadlineMs: DEADLINE_MS });
        observedReads.push(read.status === "found" ? `${read.byteSize}:${sha256Hex(read.body)}` : read.status);
      }
    })();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.putPrivate({ key, body, contentType: "application/octet-stream", deadlineMs: DEADLINE_MS }),
      ),
    );
    writing = false;
    await reader;

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ status: "completed", key })));
    expect(sha256Hex(await readFile(path.join(rootDir, ...key.split("/"))))).toBe(expected);
    for (const observed of observedReads) {
      expect(["absent", `${body.byteLength}:${expected}`]).toContain(observed);
    }
    await expect(readdir(path.join(rootDir, ".private-object-store-tmp"))).resolves.toEqual([]);
  });
});

describe("private object store: readPrivate (AC-C2)", () => {
  it("returns actual bytes, byte size and the provider content type", async () => {
    const { client, sent } = recordingClient(async () => getOutput(new Uint8Array([7, 8, 9]), "image/webp"));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    await expect(
      store.readPrivate("support-evidence/a.webp", { maxBytes: 3, deadlineMs: DEADLINE_MS }),
    ).resolves.toEqual({
      status: "found",
      body: new Uint8Array([7, 8, 9]),
      byteSize: 3,
      providerContentType: "image/webp",
    });
    expect(sent[0]?.command).toBeInstanceOf(GetObjectCommand);
    expect((sent[0]?.command as GetObjectCommand).input).toEqual({ Bucket: BUCKET, Key: "support-evidence/a.webp" });
  });

  it("reports a missing provider type as null, never a key-derived type (kills key-derived-type-fallback)", async () => {
    const { client } = recordingClient(async () => getOutput(new Uint8Array([1]), undefined));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    await expect(
      store.readPrivate("support-evidence/a.webp", { maxBytes: 1, deadlineMs: DEADLINE_MS }),
    ).resolves.toMatchObject({ status: "found", providerContentType: null });
  });

  it("accepts exactly maxBytes and reports maxBytes + 1 as too-large without pulling further (kills buffer-then-check)", async () => {
    const exact = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => getOutput(new Uint8Array(64).fill(1), "application/octet-stream")).client,
    });
    await expect(exact.readPrivate("support-evidence/a.bin", { maxBytes: 64, deadlineMs: DEADLINE_MS })).resolves.toMatchObject({
      status: "found",
      byteSize: 64,
    });

    const over = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => getOutput(new Uint8Array(65).fill(1), "application/octet-stream")).client,
    });
    await expect(over.readPrivate("support-evidence/a.bin", { maxBytes: 64, deadlineMs: DEADLINE_MS })).resolves.toEqual({
      status: "too-large",
    });

    const endless = meteredEndlessBody();
    const metered = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => ({ $metadata: { httpStatusCode: 200 }, Body: endless.body, ContentType: "image/png" })).client,
    });
    await expect(
      metered.readPrivate("support-evidence/a.bin", { maxBytes: 64, deadlineMs: DEADLINE_MS }),
    ).resolves.toEqual({ status: "too-large" });
    // One byte per pull: the store stops at maxBytes + 1 plus at most the stream's single read-ahead byte.
    expect(endless.pulled()).toBeLessThanOrEqual(66);
    expect(endless.stream.destroyed).toBe(true);
  });

  it("returns unavailable at the deadline for a stalled stream and aborts the request", async () => {
    const stalled = stalledBody(new Uint8Array([1, 2]));
    const { client, sent } = recordingClient(async () => ({
      $metadata: { httpStatusCode: 200 },
      Body: stalled.body,
      ContentType: "image/png",
    }));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    await expect(
      store.readPrivate("support-evidence/a.png", { maxBytes: 1024, deadlineMs: SHORT_DEADLINE_MS }),
    ).resolves.toEqual({ status: "unavailable", code: "deadline-exceeded" });
    expect(sent[0]?.abortSignal?.aborted).toBe(true);
    expect(stalled.stream.destroyed).toBe(true);
  });

  it("returns unavailable at the deadline for an endless under-cap stream that never yields to timers (kills timer-only-deadline)", async () => {
    const { client } = recordingClient(async () => ({
      $metadata: { httpStatusCode: 200 },
      Body: endlessEmptyChunkBody(),
      ContentType: "image/png",
    }));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    await expect(
      store.readPrivate("support-evidence/a.png", { maxBytes: 1024, deadlineMs: SHORT_DEADLINE_MS }),
    ).resolves.toEqual({ status: "unavailable", code: "deadline-exceeded" });
  });

  it("returns unavailable at the deadline when response headers never arrive", async () => {
    const { client, sent } = recordingClient(() => new Promise<never>(() => undefined));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    await expect(
      store.readPrivate("support-evidence/a.png", { maxBytes: 1024, deadlineMs: SHORT_DEADLINE_MS }),
    ).resolves.toEqual({ status: "unavailable", code: "deadline-exceeded" });
    expect(sent[0]?.abortSignal?.aborted).toBe(true);
  });

  it("maps 404 to absent but a missing bucket and other errors to bounded unavailable codes", async () => {
    const cases: ReadonlyArray<readonly [unknown, unknown]> = [
      [new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: RAW_PROVIDER_TEXT }), { status: "absent" }],
      [providerError("NoSuchBucket", 404), { status: "unavailable", code: "provider-error" }],
      [providerError("AccessDenied", 403), { status: "unavailable", code: "access-denied" }],
      [providerError("SlowDown", 503), { status: "unavailable", code: "throttled" }],
      [transportError(), { status: "unavailable", code: "transport-failed" }],
    ];
    for (const [error, expected] of cases) {
      const store = createS3PrivateObjectStore({
        bucket: BUCKET,
        client: recordingClient(async () => {
          throw error;
        }).client,
      });
      const result = await store.readPrivate("support-evidence/a.png", { maxBytes: 8, deadlineMs: DEADLINE_MS });
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret-token");
    }
  });

  it("rejects an invalid byte bound before I/O", async () => {
    const { client, sent } = recordingClient(async () => getOutput(new Uint8Array([1]), "image/png"));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    for (const maxBytes of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      await expect(store.readPrivate("support-evidence/a.png", { maxBytes, deadlineMs: DEADLINE_MS })).rejects.toThrow(
        "Private object byte bounds must be non-negative safe integers.",
      );
    }
    await expect(
      store.readPrivate("support-evidence/a.png", { maxBytes: 1, deadlineMs: Number.NaN }),
    ).rejects.toThrow("Private object deadlines must be finite positive milliseconds within the timer range.");
    expect(sent).toHaveLength(0);
  });

  it("maps real SDK responses: present type, missing type as null, 404 NoSuchKey as absent, stalled body as unavailable", async () => {
    const responses = new Map<string, () => Promise<SyntheticResponse>>([
      ["typed", async () => ({ statusCode: 200, headers: { "content-type": "image/png" }, body: Readable.from([Buffer.from([5, 6])]) })],
      ["untyped", async () => ({ statusCode: 200, headers: {}, body: Readable.from([Buffer.from([5, 6])]) })],
      ["missing", async () => xmlResponse(404, errorXml("NoSuchKey"))],
      ["stalled", async () => ({ statusCode: 200, headers: { "content-type": "image/png" }, body: new Readable({ read() {} }) })],
    ]);
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: syntheticS3Client(async (request) => {
        const name = request.path.split("/").at(-1) ?? "";
        const respond = responses.get(name);
        if (!respond) {
          throw new Error(`unexpected synthetic request ${request.path}`);
        }
        return respond();
      }),
    });

    await expect(store.readPrivate("support-evidence/typed", { maxBytes: 2, deadlineMs: DEADLINE_MS })).resolves.toEqual({
      status: "found",
      body: new Uint8Array([5, 6]),
      byteSize: 2,
      providerContentType: "image/png",
    });
    await expect(
      store.readPrivate("support-evidence/untyped", { maxBytes: 2, deadlineMs: DEADLINE_MS }),
    ).resolves.toMatchObject({ status: "found", providerContentType: null });
    await expect(
      store.readPrivate("support-evidence/missing", { maxBytes: 2, deadlineMs: DEADLINE_MS }),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      store.readPrivate("support-evidence/stalled", { maxBytes: 2, deadlineMs: SHORT_DEADLINE_MS }),
    ).resolves.toEqual({ status: "unavailable", code: "deadline-exceeded" });
  });

  it("reads filesystem objects with no MIME metadata under the same byte bound", async () => {
    const rootDir = await tempRoot();
    const store = createFilesystemPrivateObjectStore({ rootDir });
    await store.putPrivate({
      key: "support-evidence/a.webp",
      body: new Uint8Array(16).fill(3),
      contentType: "image/webp",
      deadlineMs: DEADLINE_MS,
    });

    await expect(store.readPrivate("support-evidence/a.webp", { maxBytes: 16, deadlineMs: DEADLINE_MS })).resolves.toEqual({
      status: "found",
      body: new Uint8Array(16).fill(3),
      byteSize: 16,
      providerContentType: null,
    });
    await expect(store.readPrivate("support-evidence/a.webp", { maxBytes: 15, deadlineMs: DEADLINE_MS })).resolves.toEqual({
      status: "too-large",
    });
    await expect(store.readPrivate("support-evidence/missing.webp", { maxBytes: 16, deadlineMs: DEADLINE_MS })).resolves.toEqual(
      { status: "absent" },
    );
    await expect(store.readPrivate("support-evidence", { maxBytes: 16, deadlineMs: DEADLINE_MS })).resolves.toEqual({
      status: "absent",
    });
  });
});

describe("private object store: listPrivate (AC-C3)", () => {
  const prefix = "support-evidence/case_1/";

  it("walks 0 keys, exactly one full page and 1001 keys across pages", async () => {
    const empty = createS3PrivateObjectStore({ bucket: BUCKET, client: pagedListClient([]).client });
    await expect(walkAll(empty, prefix, 1000)).resolves.toEqual({ keys: [], pages: 1 });

    const fullPageKeys = keyRange(1000);
    const fullPage = createS3PrivateObjectStore({ bucket: BUCKET, client: pagedListClient(fullPageKeys).client });
    await expect(walkAll(fullPage, prefix, 1000)).resolves.toEqual({ keys: fullPageKeys, pages: 1 });

    const overCapKeys = keyRange(1001);
    const overCap = pagedListClient(overCapKeys);
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client: overCap.client });
    const walked = await walkAll(store, prefix, 1000);
    // The decisive key sits just beyond the provider's 1000-key page cap.
    expect(walked).toEqual({ keys: overCapKeys, pages: 2 });
    expect(overCap.sent.map((entry) => (entry.command as ListObjectsV2Command).input)).toEqual([
      { Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000 },
      { Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: "token-1000" },
    ]);
  });

  it.each([
    [
      "a truncated page without a token (kills truncated-as-final)",
      { IsTruncated: true, KeyCount: 1, Contents: [{ Key: `${prefix}a.bin`, Size: 1 }] },
      undefined,
      { status: "list-incomplete", reason: "truncated-without-token" },
    ],
    [
      "a repeated token (kills token-loop)",
      { IsTruncated: true, NextContinuationToken: "token-same", KeyCount: 1, Contents: [{ Key: `${prefix}a.bin`, Size: 1 }] },
      "token-same",
      { status: "list-incomplete", reason: "repeated-token" },
    ],
    [
      "an out-of-prefix key (kills prefix-unchecked)",
      { IsTruncated: false, KeyCount: 1, Contents: [{ Key: "support-evidence/case_2/a.bin", Size: 1 }] },
      undefined,
      { status: "list-incomplete", reason: "out-of-prefix-key" },
    ],
    [
      "a key count that disagrees with the entries (kills count-unreconciled)",
      { IsTruncated: false, KeyCount: 2, Contents: [{ Key: `${prefix}a.bin`, Size: 1 }] },
      undefined,
      { status: "list-incomplete", reason: "invalid-page" },
    ],
    [
      "a token on an untruncated page",
      { IsTruncated: false, NextContinuationToken: "token-next", KeyCount: 1, Contents: [{ Key: `${prefix}a.bin`, Size: 1 }] },
      undefined,
      { status: "list-incomplete", reason: "invalid-page" },
    ],
    [
      "an entry without a size",
      { IsTruncated: false, KeyCount: 1, Contents: [{ Key: `${prefix}a.bin` }] },
      undefined,
      { status: "list-incomplete", reason: "invalid-page" },
    ],
    [
      "a non-canonical key",
      { IsTruncated: false, KeyCount: 1, Contents: [{ Key: `${prefix}folder/`, Size: 0 }] },
      undefined,
      { status: "list-incomplete", reason: "invalid-page" },
    ],
    [
      "more entries than requested",
      {
        IsTruncated: false,
        KeyCount: 2,
        Contents: [
          { Key: `${prefix}a.bin`, Size: 1 },
          { Key: `${prefix}b.bin`, Size: 1 },
        ],
      },
      undefined,
      { status: "list-incomplete", reason: "invalid-page" },
    ],
  ] as const)("reports %s as list-incomplete, never partial success", async (_label, page, token, expected) => {
    const output: ListObjectsV2CommandOutput = { $metadata: { httpStatusCode: 200 }, ...page, Contents: [...page.Contents] };
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client: recordingClient(async () => output).client });

    await expect(store.listPrivate({ prefix, continuationToken: token, maxKeys: 1 })).resolves.toEqual(expected);
  });

  it("reports a failed page as list-incomplete with a bounded code", async () => {
    for (const [error, code] of [
      [providerError("InternalError", 500), "provider-error"],
      [transportError(), "transport-failed"],
    ] as const) {
      const store = createS3PrivateObjectStore({
        bucket: BUCKET,
        client: recordingClient(async () => {
          throw error;
        }).client,
      });
      const result = await store.listPrivate({ prefix, maxKeys: 10 });
      expect(result).toEqual({ status: "list-incomplete", reason: "page-failed", code });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret-token");
    }
  });

  it("rejects invalid page sizes, prefixes and tokens before I/O", async () => {
    const { client, sent } = recordingClient(async () => ({ $metadata: {} }));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    for (const maxKeys of [0, 1001, 1.5, Number.NaN]) {
      await expect(store.listPrivate({ prefix, maxKeys })).rejects.toThrow(
        "Private object list pages must request between 1 and 1000 keys.",
      );
    }
    for (const badPrefix of ["../", "/support-evidence/", "support-evidence//", "a\\b/"]) {
      await expect(store.listPrivate({ prefix: badPrefix, maxKeys: 10 })).rejects.toThrow(
        "Private object list prefixes must extend to canonical keys.",
      );
    }
    await expect(store.listPrivate({ prefix, continuationToken: "", maxKeys: 10 })).rejects.toThrow(
      "Private object continuation tokens must be non-empty strings.",
    );
    expect(sent).toHaveLength(0);
  });

  it("maps real SDK ListObjectsV2 XML, including a truncated page without a token", async () => {
    const pages = [
      listXml({ truncated: true, nextToken: "opaque-token", keys: [`${prefix}a.bin`] }),
      listXml({ truncated: true, keys: [`${prefix}b.bin`] }),
    ];
    const queries: SyntheticRequest["query"][] = [];
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: syntheticS3Client(async (request) => {
        queries.push(request.query);
        return xmlResponse(200, pages[queries.length - 1] ?? "");
      }),
    });

    await expect(store.listPrivate({ prefix, maxKeys: 1 })).resolves.toEqual({
      status: "page",
      entries: [{ key: `${prefix}a.bin`, byteSize: 3 }],
      nextContinuationToken: "opaque-token",
    });
    await expect(store.listPrivate({ prefix, continuationToken: "opaque-token", maxKeys: 1 })).resolves.toEqual({
      status: "list-incomplete",
      reason: "truncated-without-token",
    });
    expect(queries[0]).toMatchObject({ "list-type": "2", "max-keys": "1", prefix });
    expect(queries[1]).toMatchObject({ "continuation-token": "opaque-token" });
  });

  it("lists filesystem objects deterministically under the same contract", async () => {
    const rootDir = await tempRoot();
    const store = createFilesystemPrivateObjectStore({ rootDir });
    await expect(walkAll(store, prefix, 1000)).resolves.toEqual({ keys: [], pages: 1 });

    const keys = keyRange(1000);
    await writeFiles(rootDir, keys);
    await writeFiles(rootDir, ["support-evidence/case_10/outside.bin", "support-evidence/case_1.bin"]);
    await expect(walkAll(store, prefix, 1000)).resolves.toEqual({ keys, pages: 1 });

    // The decisive key sits just beyond the 1000-key page cap, written through the private put path.
    await store.putPrivate({ key: `${prefix}zz-put.bin`, body: new Uint8Array([1]), contentType: "image/png", deadlineMs: DEADLINE_MS });
    const expectedKeys = [...keys, `${prefix}zz-put.bin`];
    const first = await walkAll(store, prefix, 1000);
    const second = await walkAll(store, prefix, 1000);
    expect(first).toEqual({ keys: expectedKeys, pages: 2 });
    expect(second).toEqual(first);

    const page = await store.listPrivate({ prefix: `${prefix}zz`, maxKeys: 1 });
    expect(page).toEqual({ status: "page", entries: [{ key: `${prefix}zz-put.bin`, byteSize: 1 }], nextContinuationToken: null });
    await expect(store.listPrivate({ prefix, continuationToken: "not-a-filesystem-token", maxKeys: 1 })).resolves.toEqual({
      status: "list-incomplete",
      reason: "invalid-page",
    });
  });
});

describe("private object store: deleteKeys (AC-C4)", () => {
  it("marks per-key Errors inside HTTP success as failed for exactly those keys (kills per-key-errors-ignored)", async () => {
    const output: DeleteObjectsCommandOutput = {
      $metadata: { httpStatusCode: 200 },
      Deleted: [{ Key: "support-evidence/a.bin" }],
      Errors: [
        { Key: "support-evidence/b.bin", Code: "AccessDenied", Message: RAW_PROVIDER_TEXT },
        { Key: "support-evidence/c.bin", Code: "NoSuchKey", Message: RAW_PROVIDER_TEXT },
        { Key: "support-evidence/d.bin", Code: "InternalError", Message: RAW_PROVIDER_TEXT },
      ],
    };
    const { client, sent } = recordingClient(async () => output);
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    const outcomes = await store.deleteKeys([
      "support-evidence/a.bin",
      "support-evidence/b.bin",
      "support-evidence/c.bin",
      "support-evidence/d.bin",
    ]);

    expect(outcomes).toEqual([
      { key: "support-evidence/a.bin", status: "deleted" },
      { key: "support-evidence/b.bin", status: "failed", code: "access-denied" },
      { key: "support-evidence/c.bin", status: "absent" },
      { key: "support-evidence/d.bin", status: "failed", code: "provider-error" },
    ]);
    expect(JSON.stringify(outcomes)).not.toContain("synthetic-secret-token");
    expect(sent[0]?.command).toBeInstanceOf(DeleteObjectsCommand);
    expect((sent[0]?.command as DeleteObjectsCommand).input).toEqual({
      Bucket: BUCKET,
      Delete: {
        Objects: [
          { Key: "support-evidence/a.bin" },
          { Key: "support-evidence/b.bin" },
          { Key: "support-evidence/c.bin" },
          { Key: "support-evidence/d.bin" },
        ],
        Quiet: false,
      },
    });
  });

  it("fails a key the provider did not account for (kills unreported-as-deleted)", async () => {
    const output: DeleteObjectsCommandOutput = { $metadata: { httpStatusCode: 200 }, Deleted: [{ Key: "support-evidence/a.bin" }] };
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client: recordingClient(async () => output).client });

    await expect(store.deleteKeys(["support-evidence/a.bin", "support-evidence/b.bin"])).resolves.toEqual([
      { key: "support-evidence/a.bin", status: "deleted" },
      { key: "support-evidence/b.bin", status: "failed", code: "invalid-response" },
    ]);
  });

  it("fails every key when the batch request fails", async () => {
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => {
        throw providerError("SlowDown", 503);
      }).client,
    });

    await expect(store.deleteKeys(["support-evidence/a.bin", "support-evidence/b.bin"])).resolves.toEqual([
      { key: "support-evidence/a.bin", status: "failed", code: "throttled" },
      { key: "support-evidence/b.bin", status: "failed", code: "throttled" },
    ]);
  });

  it("rejects more than 1000 or duplicate keys before I/O and sends nothing for an empty batch", async () => {
    const { client, sent } = recordingClient(async () => ({ $metadata: { httpStatusCode: 200 }, Deleted: [] }));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    await expect(store.deleteKeys(keyRange(1001))).rejects.toThrow("Private object deletes accept at most 1000 keys.");
    await expect(store.deleteKeys(["support-evidence/a.bin", "support-evidence/a.bin"])).rejects.toThrow(
      "Private object deletes require distinct keys.",
    );
    await expect(store.deleteKeys([])).resolves.toEqual([]);
    expect(sent).toHaveLength(0);

    await store.deleteKeys(keyRange(1000));
    expect(sent).toHaveLength(1);
  });

  it("maps real SDK DeleteObjects XML with Error entries inside HTTP 200", async () => {
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: syntheticS3Client(async () =>
        xmlResponse(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<Deleted><Key>support-evidence/a.bin</Key></Deleted>` +
            `<Error><Key>support-evidence/b.bin</Key><Code>AccessDenied</Code><Message>${RAW_PROVIDER_TEXT}</Message></Error>` +
            `<Error><Key>support-evidence/c.bin</Key><Code>NoSuchKey</Code><Message>${RAW_PROVIDER_TEXT}</Message></Error>` +
            `</DeleteResult>`,
        ),
      ),
    });

    await expect(
      store.deleteKeys(["support-evidence/a.bin", "support-evidence/b.bin", "support-evidence/c.bin"]),
    ).resolves.toEqual([
      { key: "support-evidence/a.bin", status: "deleted" },
      { key: "support-evidence/b.bin", status: "failed", code: "access-denied" },
      { key: "support-evidence/c.bin", status: "absent" },
    ]);
  });

  it("keeps filesystem parity: deleted, absent, and directories are not objects", async () => {
    const rootDir = await tempRoot();
    const store = createFilesystemPrivateObjectStore({ rootDir });
    await writeFiles(rootDir, ["support-evidence/a.bin", "support-evidence/dir/b.bin"]);

    await expect(
      store.deleteKeys(["support-evidence/a.bin", "support-evidence/missing.bin", "support-evidence/dir"]),
    ).resolves.toEqual([
      { key: "support-evidence/a.bin", status: "deleted" },
      { key: "support-evidence/missing.bin", status: "absent" },
      { key: "support-evidence/dir", status: "absent" },
    ]);
    await expect(store.readPrivate("support-evidence/a.bin", { maxBytes: 8, deadlineMs: DEADLINE_MS })).resolves.toEqual({
      status: "absent",
    });
    await expect(store.deleteKeys(keyRange(1001))).rejects.toThrow("Private object deletes accept at most 1000 keys.");
  });
});

describe("private object store: verifyPrivate (AC-C6)", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const expected = { sha256: sha256Hex(bytes), byteSize: 4, contentType: "image/png", deadlineMs: DEADLINE_MS };

  it("matches only equal bytes, SHA-256, size and provider type", async () => {
    const { client, sent } = recordingClient(async () => getOutput(bytes, "image/png"));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    await expect(store.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({ status: "match" });
    expect((sent[0]?.command as GetObjectCommand).input).toEqual({ Bucket: BUCKET, Key: "support-evidence/a.png" });
  });

  it.each([
    ["different bytes of the same size", new Uint8Array([1, 2, 3, 5]), "image/png", "sha256"],
    ["a shorter object", new Uint8Array([1, 2, 3]), "image/png", "byte-size"],
    ["a longer object", new Uint8Array([1, 2, 3, 4, 5]), "image/png", "byte-size"],
    ["a different provider type", bytes, "image/jpeg", "content-type"],
  ] as const)("reports %s as conflict", async (_label, body, contentType, difference) => {
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => getOutput(body, contentType)).client,
    });

    await expect(store.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({ status: "conflict", difference });
  });

  it("reads at most byteSize + 1 bytes of an oversized object", async () => {
    const endless = meteredEndlessBody();
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => ({ $metadata: { httpStatusCode: 200 }, Body: endless.body, ContentType: "image/png" })).client,
    });

    await expect(store.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({
      status: "conflict",
      difference: "byte-size",
    });
    expect(endless.pulled()).toBeLessThanOrEqual(6);
  });

  it("treats a response without Content-Type as unavailable, never match (kills null-type-match)", async () => {
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => getOutput(bytes, undefined)).client,
    });

    await expect(store.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({
      status: "unavailable",
      code: "content-type-missing",
    });

    const oversizedUntyped = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => getOutput(new Uint8Array([1, 2, 3, 4, 5]), undefined)).client,
    });
    await expect(oversizedUntyped.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({
      status: "unavailable",
      code: "content-type-missing",
    });
  });

  it("maps 404 to absent and deadline, stall or error to unavailable", async () => {
    const absent = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => {
        throw new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: RAW_PROVIDER_TEXT });
      }).client,
    });
    await expect(absent.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({ status: "absent" });

    const stalled = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => ({
        $metadata: { httpStatusCode: 200 },
        Body: stalledBody(new Uint8Array([1, 2])).body,
        ContentType: "image/png",
      })).client,
    });
    await expect(
      stalled.verifyPrivate("support-evidence/a.png", { ...expected, deadlineMs: SHORT_DEADLINE_MS }),
    ).resolves.toEqual({ status: "unavailable", code: "deadline-exceeded" });

    const failing = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: recordingClient(async () => {
        throw providerError("InternalError", 500);
      }).client,
    });
    await expect(failing.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({
      status: "unavailable",
      code: "provider-error",
    });
  });

  it("rejects malformed expectations before I/O", async () => {
    const { client, sent } = recordingClient(async () => getOutput(bytes, "image/png"));
    const store = createS3PrivateObjectStore({ bucket: BUCKET, client });

    await expect(store.verifyPrivate("support-evidence/a.png", { ...expected, sha256: "ABC" })).rejects.toThrow(
      "Private object SHA-256 digests must be 64 lowercase hex characters.",
    );
    await expect(store.verifyPrivate("support-evidence/a.png", { ...expected, byteSize: -1 })).rejects.toThrow(
      "Private object byte bounds must be non-negative safe integers.",
    );
    await expect(store.verifyPrivate("support-evidence/a.png", { ...expected, deadlineMs: 0 })).rejects.toThrow(
      "Private object deadlines must be finite positive milliseconds within the timer range.",
    );
    expect(sent).toHaveLength(0);
  });

  it("maps a real SDK GET without a Content-Type header to unavailable", async () => {
    const store = createS3PrivateObjectStore({
      bucket: BUCKET,
      client: syntheticS3Client(async () => ({ statusCode: 200, headers: {}, body: Readable.from([Buffer.from(bytes)]) })),
    });

    await expect(store.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({
      status: "unavailable",
      code: "content-type-missing",
    });
  });

  it("compares bytes only on the filesystem store", async () => {
    const rootDir = await tempRoot();
    const store = createFilesystemPrivateObjectStore({ rootDir });
    await store.putPrivate({ key: "support-evidence/a.png", body: bytes, contentType: "image/png", deadlineMs: DEADLINE_MS });

    await expect(store.verifyPrivate("support-evidence/a.png", expected)).resolves.toEqual({ status: "match" });
    await expect(
      store.verifyPrivate("support-evidence/a.png", { ...expected, contentType: "application/octet-stream" }),
    ).resolves.toEqual({ status: "match" });
    await expect(
      store.verifyPrivate("support-evidence/a.png", { ...expected, sha256: sha256Hex(new Uint8Array([9, 9, 9, 9])) }),
    ).resolves.toEqual({ status: "conflict", difference: "sha256" });
    await expect(store.verifyPrivate("support-evidence/a.png", { ...expected, byteSize: 3 })).resolves.toEqual({
      status: "conflict",
      difference: "byte-size",
    });
    await expect(store.verifyPrivate("support-evidence/missing.png", expected)).resolves.toEqual({ status: "absent" });
  });
});

type SentCommand = Readonly<{ command: unknown; abortSignal: AbortSignal | undefined }>;

function recordingClient(respond: (command: unknown, abortSignal: AbortSignal | undefined) => Promise<unknown>) {
  const sent: SentCommand[] = [];
  const client: Pick<S3Client, "send"> = {
    send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      sent.push({ command, abortSignal: options?.abortSignal });
      return respond(command, options?.abortSignal);
    },
  } as Pick<S3Client, "send">;
  return { client, sent };
}

function pagedListClient(keys: readonly string[]) {
  return recordingClient(async (command) => {
    const input = (command as ListObjectsV2Command).input;
    const start = input.ContinuationToken ? Number(input.ContinuationToken.slice("token-".length)) : 0;
    const maxKeys = input.MaxKeys ?? 1000;
    const page = keys.slice(start, start + maxKeys);
    const next = start + maxKeys < keys.length ? `token-${start + maxKeys}` : undefined;
    const output: ListObjectsV2CommandOutput = {
      $metadata: { httpStatusCode: 200 },
      IsTruncated: next !== undefined,
      NextContinuationToken: next,
      KeyCount: page.length,
      MaxKeys: maxKeys,
      Prefix: input.Prefix,
      Contents: page.map((Key) => ({ Key, Size: 7 })),
    };
    return output;
  });
}

async function walkAll(store: PrivateObjectStore, prefix: string, maxKeys: number) {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  for (let pages = 1; pages <= 5; pages += 1) {
    const result: PrivateListResult = await store.listPrivate({ prefix, continuationToken, maxKeys });
    if (result.status !== "page") {
      return result;
    }
    keys.push(...result.entries.map((entry) => entry.key));
    if (result.nextContinuationToken === null) {
      return { keys, pages };
    }
    continuationToken = result.nextContinuationToken;
  }
  throw new Error("Listing did not finish within the test page bound.");
}

function keyRange(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `support-evidence/case_1/${String(index).padStart(4, "0")}.bin`);
}

async function writeFiles(rootDir: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const filePath = path.join(rootDir, ...key.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from("payload"));
  }
}

function putOutput(): PutObjectCommandOutput {
  return { $metadata: { httpStatusCode: 200 }, ETag: '"synthetic"' };
}

function getOutput(bytes: Uint8Array, contentType: string | undefined): GetObjectCommandOutput {
  return {
    $metadata: { httpStatusCode: 200 },
    Body: sdkBody(Readable.from([Buffer.from(bytes)])),
    ContentType: contentType,
    ContentLength: bytes.byteLength,
  };
}

function sdkBody(stream: Readable): NonNullable<GetObjectCommandOutput["Body"]> {
  // The private store must stream with a byte bound; the SDK's unbounded collectors fail loudly here.
  return Object.assign(stream, {
    transformToByteArray: () => Promise.reject(new Error("unbounded transformToByteArray used")),
    transformToString: () => Promise.reject(new Error("unbounded transformToString used")),
    transformToWebStream: () => {
      throw new Error("transformToWebStream used");
    },
  });
}

function meteredEndlessBody() {
  let pulled = 0;
  const stream = new Readable({
    highWaterMark: 1,
    read() {
      pulled += 1;
      this.push(Buffer.from([0x61]));
    },
  });
  return { body: sdkBody(stream), stream, pulled: () => pulled };
}

function stalledBody(prefix: Uint8Array) {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(prefix));
  return { body: sdkBody(stream), stream };
}

function endlessEmptyChunkBody() {
  function* emptyChunks() {
    for (;;) {
      yield new Uint8Array(0);
    }
  }
  return sdkBody(Readable.from(emptyChunks()));
}

function heldResponse<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function providerError(name: string, httpStatusCode: number): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: httpStatusCode >= 500 ? "server" : "client",
    $metadata: { httpStatusCode },
    message: RAW_PROVIDER_TEXT,
  });
}

function transportError(): Error {
  return Object.assign(new Error(`socket hang up ${RAW_PROVIDER_TEXT}`), {
    code: "ECONNRESET",
    $metadata: { attempts: 1, totalRetryDelay: 0 },
  });
}

type SyntheticRequest = Readonly<{
  method: string;
  path: string;
  query: Record<string, string | string[] | null>;
  headers: Record<string, string>;
}>;

type SyntheticResponse = Readonly<{ statusCode: number; headers: Record<string, string>; body?: Readable }>;

// Drives the real SDK serializers and deserializers through an in-process handler; nothing leaves the process.
function syntheticS3Client(
  respond: (request: SyntheticRequest, abortSignal: AbortSignal | undefined) => Promise<SyntheticResponse>,
): S3Client {
  return new S3Client({
    region: "us-east-1",
    endpoint: "https://object-store.synthetic.invalid",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: "SYNTHETICACCESSKEY", secretAccessKey: "synthetic-secret-key" },
    requestHandler: {
      handle: async (request: SyntheticRequest, options?: { abortSignal?: AbortSignal }) => {
        const response = await respond(request, options?.abortSignal);
        return { response: { ...response, body: response.body ?? Readable.from([]) } };
      },
      updateHttpClientConfig: () => undefined,
      httpHandlerConfigs: () => ({}),
    },
  });
}

function rejectOnAbort(abortSignal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
}

function xmlResponse(statusCode: number, xml: string): SyntheticResponse {
  return { statusCode, headers: { "content-type": "application/xml" }, body: Readable.from([Buffer.from(xml)]) };
}

function errorXml(code: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${RAW_PROVIDER_TEXT}</Message></Error>`;
}

function listXml(page: Readonly<{ truncated: boolean; nextToken?: string; keys: readonly string[] }>): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>${BUCKET}</Name><KeyCount>${page.keys.length}</KeyCount><MaxKeys>1</MaxKeys>` +
    `<IsTruncated>${page.truncated}</IsTruncated>` +
    (page.nextToken ? `<NextContinuationToken>${page.nextToken}</NextContinuationToken>` : "") +
    page.keys.map((key) => `<Contents><Key>${key}</Key><Size>3</Size></Contents>`).join("") +
    `</ListBucketResult>`
  );
}

async function tempRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "chase-sets-private-store-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
