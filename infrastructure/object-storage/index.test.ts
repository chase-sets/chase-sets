import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  S3Client,
  type DeleteObjectsCommandOutput,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFilesystemObjectFileStorage,
  createFilesystemObjectStorage,
  createS3ObjectStorage,
  createS3PrivateObjectStoreFromOptions,
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

describe("createS3PrivateObjectStoreFromOptions", () => {
  // Synthetic identities only: no real bucket, endpoint, credential or provider traffic.
  const options = {
    bucket: "synthetic-private-evidence",
    region: "synthetic-region-1",
    endpoint: "https://objects.synthetic.invalid",
    publicBaseUrl: "https://cdn.synthetic.invalid",
    accessKeyId: "SYNTHETIC_ACCESS_KEY",
    secretAccessKey: "synthetic-secret",
    forcePathStyle: true,
  } as const;

  it("deletes and confirms absence through the injected client and the selected bucket", async () => {
    const sent: unknown[] = [];
    const store = createS3PrivateObjectStoreFromOptions({
      ...options,
      client: {
        send: async (command: unknown) => {
          sent.push(command);
          if (command instanceof DeleteObjectsCommand)
            return { $metadata: { httpStatusCode: 200 }, Deleted: [{ Key: "support-evidence/a.png" }] };
          throw new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "synthetic absent" });
        },
      } as Pick<S3Client, "send">,
    });

    await expect(store.deleteKeys(["support-evidence/a.png"])).resolves.toEqual([
      { key: "support-evidence/a.png", status: "deleted" },
    ]);
    await expect(
      store.verifyPrivate("support-evidence/a.png", {
        sha256: "a".repeat(64),
        byteSize: 1,
        contentType: "image/png",
        deadlineMs: 5_000,
      }),
    ).resolves.toEqual({ status: "absent" });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeInstanceOf(DeleteObjectsCommand);
    expect(sent[1]).toBeInstanceOf(GetObjectCommand);
    for (const command of sent)
      expect((command as { input: { Bucket?: string } }).input.Bucket).toBe("synthetic-private-evidence");
  });

  it("builds its own client from the shared connection options when none is injected", async () => {
    const promiseSend: { send(command: DeleteObjectsCommand): Promise<DeleteObjectsCommandOutput> } =
      S3Client.prototype;
    const send = vi.spyOn(promiseSend, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      Deleted: [{ Key: "support-evidence/a.png" }],
    });
    try {
      await createS3PrivateObjectStoreFromOptions(options).deleteKeys(["support-evidence/a.png"]);
      expect(send).toHaveBeenCalledTimes(1);
      const client = send.mock.contexts[0] as S3Client;
      expect((send.mock.calls[0]![0] as DeleteObjectsCommand).input.Bucket).toBe("synthetic-private-evidence");
      await expect(client.config.region()).resolves.toBe("synthetic-region-1");
      expect(client.config.forcePathStyle).toBe(true);
      await expect(client.config.credentials()).resolves.toMatchObject({
        accessKeyId: "SYNTHETIC_ACCESS_KEY",
        secretAccessKey: "synthetic-secret",
      });
      expect((await client.config.endpoint!()).hostname).toBe("objects.synthetic.invalid");
    } finally {
      send.mockRestore();
    }
  });
});
