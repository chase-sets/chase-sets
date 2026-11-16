import { createHash } from "node:crypto";
import type { RepresentativeCatalogProductAssetSource } from "../source-observation-runtime-contracts";
import { prepareProductAssetSource, type PreparedProductAssetSource } from "./product-asset-normalization";

export const REPRESENTATIVE_CATALOG_ASSET_CONCURRENCY = 4;
const MAX_BATCH_SOURCE_BYTES = REPRESENTATIVE_CATALOG_ASSET_CONCURRENCY * 50 * 1024 * 1024;

export function createRepresentativeCatalogAssetPreparation(prepareSource = prepareProductAssetSource) {
  const sources = new Map<string, Promise<PreparedProductAssetSource>>();
  return async (batch: readonly RepresentativeCatalogProductAssetSource[]) => {
    if (
      batch.length > REPRESENTATIVE_CATALOG_ASSET_CONCURRENCY ||
      batch.reduce((bytes, source) => bytes + source.body.byteLength, 0) > MAX_BATCH_SOURCE_BYTES
    ) {
      throw new Error("Representative Catalog asset preparation batch exceeds its bound.");
    }
    const settled = await Promise.allSettled(
      batch.map(async (source) => {
        const hash = `sha256:${createHash("sha256").update(source.body).digest("hex")}`;
        if (hash !== source.sourceHash) throw new Error("Representative Catalog asset source hash mismatch.");
        let prepared = sources.get(hash);
        if (!prepared) {
          prepared = prepareSource(source.body);
          sources.set(hash, prepared);
        }
        return [hash, await prepared] as const;
      }),
    );
    const prepared = new Map<string, PreparedProductAssetSource>();
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      prepared.set(...result.value);
    }
    return prepared;
  };
}
