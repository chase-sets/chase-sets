import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
      key: "catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
    });

    expect(result).toEqual({
      key: "catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
      publicUrl:
        "http://assets.test/catalog-assets/catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
    });
    await expect(
      readFilesystemObject(
        rootDir,
        "catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
      ),
    ).resolves.toEqual({
      body: Buffer.from([1, 2, 3]),
      contentType: "image/webp",
    });
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
        key: "catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
        body: new Uint8Array([1]),
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
      }),
    ).resolves.toEqual({
      key: "catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
      publicUrl:
        "https://cdn.chasesets.test/catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
    });
    expect(sent).toHaveLength(1);
  });
});
