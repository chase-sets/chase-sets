import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { openSupportEvidenceCanonicalizer } from "@chase-sets/platform-operations";

import {
  createPlatformBootstrapStoragePorts,
  createSupportEvidenceAttachmentStorage,
  openPlatformSupportEvidenceCanonicalizer,
} from "../src/bootstrap-storage";

vi.mock("@chase-sets/platform-operations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/platform-operations")>();
  return { ...actual, openSupportEvidenceCanonicalizer: vi.fn(actual.openSupportEvidenceCanonicalizer) };
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("platform bootstrap storage ports", () => {
  it("uses the configured local catalog asset route without altering listing storage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-bootstrap-storage-"));
    temporaryRoots.push(root);
    const ports = createPlatformBootstrapStoragePorts({
      catalogAssetStorage: {
        kind: "filesystem",
        rootDir: path.join(root, "catalog"),
        publicBaseUrl: "http://127.0.0.1:4173/catalog-assets",
      },
      listingPhotoStorage: {
        kind: "filesystem",
        rootDir: path.join(root, "listings"),
        publicBaseUrl: "http://127.0.0.1:4173/listing-photos",
      },
    });

    const stored = await ports.catalogAssetStorage.putObject({
      key: "product-assets/sha256/source.png",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    expect(stored.publicUrl).toBe("http://127.0.0.1:4173/catalog-assets/product-assets/sha256/source.png");
    expect(
      new Uint8Array(await readFile(path.join(root, "catalog", "product-assets", "sha256", "source.png"))),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(ports.listingPhotoStorage).not.toBe(ports.catalogAssetStorage);
    const body = new Uint8Array([1, 2, 3]);
    await expect(
      ports.supportEvidenceAttachmentStorage.putPrivate({
        key: "support-evidence/sup_case/test.jpg",
        body,
        contentType: "image/jpeg",
        deadlineMs: 30_000,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      ports.supportEvidenceAttachmentStorage.verifyPrivate("support-evidence/sup_case/test.jpg", {
        sha256: createHash("sha256").update(body).digest("hex"),
        byteSize: 3,
        contentType: "image/jpeg",
        deadlineMs: 30_000,
      }),
    ).resolves.toEqual({ status: "match" });
    expect(
      new Uint8Array(
        await readFile(path.join(root, "listings-private-support-evidence/support-evidence/sup_case/test.jpg")),
      ),
    ).toEqual(body);
    expect("getObject" in ports.supportEvidenceAttachmentStorage).toBe(false);
  });

  it("composes the S3 private-store contract with a synthetic client and no provider traffic", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      .mockResolvedValueOnce({
        Body: Readable.from([Buffer.from([1, 2, 3])], { objectMode: false }),
        ContentType: "image/jpeg",
      });
    const config = {
      kind: "s3" as const,
      bucket: "synthetic",
      region: "synthetic",
      publicBaseUrl: "https://synthetic.invalid",
      client: { send },
    };
    const store = createSupportEvidenceAttachmentStorage(config);
    await expect(
      store.putPrivate({
        key: "test.jpg",
        body: Buffer.from([1, 2, 3]),
        contentType: "image/jpeg",
        deadlineMs: 30_000,
      }),
    ).resolves.toEqual({ status: "completed", key: "test.jpg" });
    await expect(
      store.verifyPrivate("test.jpg", {
        sha256: createHash("sha256")
          .update(Buffer.from([1, 2, 3]))
          .digest("hex"),
        byteSize: 3,
        contentType: "image/jpeg",
        deadlineMs: 30_000,
      }),
    ).resolves.toEqual({ status: "match" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: "synthetic", CacheControl: "private, no-store" });
  });

  it("opens the existing fingerprint gate before composing its bounded queue, including production failure", async () => {
    vi.mocked(openSupportEvidenceCanonicalizer).mockResolvedValueOnce({
      status: "golden-mismatch",
      fingerprint: {
        profile: "support-evidence-raster/v1",
        sharp: "synthetic",
        libvips: "synthetic",
        platform: "synthetic",
        arch: "synthetic",
        libc: "synthetic",
      },
      canonicalize: vi.fn(async () => ({ kind: "rejected" as const, code: "canonicalizer-unavailable" as const })),
    });
    const queue = await openPlatformSupportEvidenceCanonicalizer(true);
    expect(openSupportEvidenceCanonicalizer).toHaveBeenLastCalledWith({ productionLike: true });
    await expect(queue.canonicalize({ body: Buffer.from([1]), declaredContentType: "image/jpeg" })).resolves.toEqual({
      kind: "rejected",
      code: "canonicalizer-unavailable",
    });
    await openPlatformSupportEvidenceCanonicalizer(false);
    expect(openSupportEvidenceCanonicalizer).toHaveBeenLastCalledWith({ productionLike: false });
  });
});
