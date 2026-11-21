import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRepresentativeCatalogAssetPreparation,
  REPRESENTATIVE_CATALOG_ASSET_CONCURRENCY,
} from "./representative-catalog-asset-preparation";

const source = (value: number) => {
  const body = new Uint8Array([value]);
  return {
    body,
    sourceHash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    contentType: "image/webp",
    sourceUrl: null,
  };
};
const normalized = { sourceHash: "hash", displayHash: "display", width: 1, height: 1, variants: [] };

describe("representative Catalog asset preparation", () => {
  it("coalesces simultaneous duplicate sources and returns input order despite completion order", async () => {
    const release: (() => void)[] = [];
    const normalize = vi.fn(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
      return normalized;
    });
    const prepare = createRepresentativeCatalogAssetPreparation(normalize);
    const result = prepare([source(1), source(2), source(1), source(3)]);
    expect(normalize).toHaveBeenCalledTimes(3);
    for (const resolve of release.reverse()) resolve();
    expect([...(await result).keys()]).toEqual([source(1).sourceHash, source(2).sourceHash, source(3).sourceHash]);
  });

  it("settles every started worker before reporting the original preparation failure", async () => {
    const failure = new Error("original preparation failure");
    let release!: () => void;
    let settled = false;
    const prepare = createRepresentativeCatalogAssetPreparation(async (body) => {
      if (body[0] === 1) throw failure;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      settled = true;
      return normalized;
    });
    let returned = false;
    const result = prepare([source(1), source(2)]).catch((error) => {
      returned = true;
      return error;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    release();
    expect(await result).toBe(failure);
    expect(settled).toBe(true);
  });

  it("refuses excessive count or aggregate source bytes without starting work", async () => {
    const normalize = vi.fn(async () => normalized);
    const prepare = createRepresentativeCatalogAssetPreparation(normalize);
    await expect(
      prepare(Array.from({ length: REPRESENTATIVE_CATALOG_ASSET_CONCURRENCY + 1 }, () => source(1))),
    ).rejects.toThrow("exceeds its bound");
    const oversized = {
      ...source(1),
      body: new Uint8Array(REPRESENTATIVE_CATALOG_ASSET_CONCURRENCY * 50 * 1024 * 1024 + 1),
    };
    await expect(prepare([oversized])).rejects.toThrow("exceeds its bound");
    expect(normalize).not.toHaveBeenCalled();
  });

  it("settles all started preparations after abort and never promotes or publishes their result", async () => {
    const abort = new AbortController();
    const release: (() => void)[] = [];
    let settled = 0;
    const normalize = vi.fn(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
      settled += 1;
      return normalized;
    });
    const prepare = createRepresentativeCatalogAssetPreparation(normalize);
    const promote = vi.fn();
    const publish = vi.fn();
    const receipt = vi.fn();
    let returned = false;
    const run = prepare([source(1), source(2), source(3), source(4)], abort.signal)
      .then(promote)
      .then(publish)
      .then(receipt)
      .finally(() => {
        returned = true;
      });
    const rejected = expect(run).rejects.toThrow("cancelled replay");
    abort.abort(new Error("cancelled replay"));
    release[0]!();
    await Promise.resolve();
    expect(returned).toBe(false);
    for (const resolve of release.slice(1)) resolve();
    await rejected;
    expect(settled).toBe(4);
    expect(promote).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
    await expect(prepare([source(5)], abort.signal)).rejects.toThrow("cancelled replay");
    expect(normalize).toHaveBeenCalledTimes(4);
  });
  it("normalizes a source only once across item batches, with a fresh cache for each run", async () => {
    const normalize = vi.fn(async () => normalized);
    const prepare = createRepresentativeCatalogAssetPreparation(normalize);
    const first = await prepare([source(1)]);
    const second = await prepare([source(1)]);
    expect(first.get(source(1).sourceHash)).toBe(second.get(source(1).sourceHash));
    expect(normalize).toHaveBeenCalledTimes(1);
    await createRepresentativeCatalogAssetPreparation(normalize)([source(1)]);
    expect(normalize).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched source hash before normalization", async () => {
    const normalize = vi.fn(async () => normalized);
    const prepare = createRepresentativeCatalogAssetPreparation(normalize);
    await expect(prepare([{ ...source(1), sourceHash: source(2).sourceHash }])).rejects.toThrow("hash mismatch");
    expect(normalize).not.toHaveBeenCalled();
  });
});
