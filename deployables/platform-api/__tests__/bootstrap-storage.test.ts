import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPlatformBootstrapStoragePorts } from "../src/bootstrap-storage";

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
  });
});
