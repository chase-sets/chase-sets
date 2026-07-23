import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFilesystemObjectFileStorage,
  createFilesystemObjectStorage,
  createS3ObjectStorage,
  readFilesystemObject,
} from "./index";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("object storage adapters", () => {
  it("stores filesystem objects under safe deterministic keys", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "chase-sets-assets-"));
    tempDirs.push(rootDir);
    const storage = createFilesystemObjectStorage({
      rootDir,
      publicBaseUrl: "http://assets.test/catalog-assets",
    });

    const result = await storage.putObject({
      key: "catalog/items/cat_test/product-image/high.webp",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
    });

    expect(result).toEqual({
      key: "catalog/items/cat_test/product-image/high.webp",
      publicUrl: "http://assets.test/catalog-assets/catalog/items/cat_test/product-image/high.webp",
    });
    await expect(readFilesystemObject(rootDir, "catalog/items/cat_test/product-image/high.webp")).resolves.toEqual({
      body: Buffer.from([1, 2, 3]),
      contentType: "image/webp",
    });
    await expect(storage.getObject("catalog/items/cat_test/product-image/high.webp")).resolves.toEqual({
      body: Buffer.from([1, 2, 3]),
      contentType: "image/webp",
    });
    await storage.deleteObjects(["catalog/items/cat_test/product-image/high.webp"]);
    await expect(storage.getObject("catalog/items/cat_test/product-image/high.webp")).resolves.toBeNull();
  });

  it("rejects filesystem traversal keys", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "chase-sets-assets-"));
    tempDirs.push(rootDir);
    const storage = createFilesystemObjectStorage({
      rootDir,
      publicBaseUrl: "http://assets.test/catalog-assets",
    });

    await expect(
      storage.putObject({
        key: "../escape.webp",
        body: new Uint8Array([1]),
        contentType: "image/webp",
      }),
    ).rejects.toThrow("Object storage keys must be relative paths without traversal.");
  });

  it("streams file-backed objects through the filesystem adapter without buffering the payload contract", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "chase-sets-file-source-"));
    const storageDir = await mkdtemp(path.join(os.tmpdir(), "chase-sets-file-storage-"));
    const downloadDir = await mkdtemp(path.join(os.tmpdir(), "chase-sets-file-download-"));
    tempDirs.push(sourceDir, storageDir, downloadDir);
    const source = path.join(sourceDir, "catalog.dump");
    const downloaded = path.join(downloadDir, "catalog.dump");
    await writeFile(source, Buffer.from("coordinated dump bytes"));
    const storage = createFilesystemObjectFileStorage({
      rootDir: storageDir,
      publicBaseUrl: "https://private.invalid",
    });

    await storage.putFile({
      key: "representative-snapshots/set/catalog.dump",
      filePath: source,
      contentType: "application/octet-stream",
      visibility: "private",
    });
    await expect(storage.getFile("representative-snapshots/set/catalog.dump", downloaded)).resolves.toMatchObject({
      byteCount: 22,
      contentType: "application/octet-stream",
    });
    await expect(readFile(downloaded, "utf8")).resolves.toBe("coordinated dump bytes");
  });

  it("writes S3-compatible objects and returns the public URL", async () => {
    const sent: unknown[] = [];
    const storage = createS3ObjectStorage({
      bucket: "cards",
      region: "nyc3",
      endpoint: "https://nyc3.digitaloceanspaces.com",
      publicBaseUrl: "https://cdn.chasesets.test",
      client: {
        send: async (command) => {
          sent.push(command);
          return {};
        },
      },
    });

    await expect(
      storage.putObject({
        key: "catalog/items/cat_test/product-image/high.webp",
        body: new Uint8Array([1]),
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
      }),
    ).resolves.toEqual({
      key: "catalog/items/cat_test/product-image/high.webp",
      publicUrl: "https://cdn.chasesets.test/catalog/items/cat_test/product-image/high.webp",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      input: {
        ACL: "public-read",
      },
    });
  });

  it("does not grant public-read access to private S3 objects", async () => {
    const sent: unknown[] = [];
    const storage = createS3ObjectStorage({
      bucket: "private-returns",
      region: "nyc3",
      publicBaseUrl: "https://objects.chasesets.test",
      client: {
        send: async (command) => {
          sent.push(command);
          return {};
        },
      },
    });

    await storage.putObject({
      key: "return-intake/fac_east/rie_1/hash.jpg",
      body: new Uint8Array([0xff]),
      contentType: "image/jpeg",
      visibility: "private",
      cacheControl: "private, no-store",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      input: {
        Bucket: "private-returns",
        CacheControl: "private, no-store",
      },
    });
    expect((sent[0] as { input: Record<string, unknown> }).input).not.toHaveProperty("ACL");
  });
});
