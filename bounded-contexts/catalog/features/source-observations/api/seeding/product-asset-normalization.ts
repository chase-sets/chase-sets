import {
  sendCatalogProviderRequest,
  currentProviderSendAdmission,
  currentProviderSendBinding,
  ProviderSendStoppedError,
} from "../providers/provider-send-admission";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  PRODUCT_ASSET_VARIANT_SPECS,
  type ProductAssetSet,
  type ProductAssetVariant,
} from "../../../../support/runtime-support/product-assets";
import type { CatalogAssetStorage } from "./asset-storage";
import type { SourceObservationNormalized } from "../../domain/domain";
import { readBoundedHttpObject } from "../providers/bounded-http-object";

const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DISPLAY_NORMALIZATION_VERSION = "trim-alpha-v1";
const ONE_PIECE_IMAGE_EVIDENCE_STALE_AFTER_DAYS = 365;
const LORCANA_IMAGE_EVIDENCE_STALE_AFTER_DAYS = 365;

const LORCANA_APPROVED_IMAGE_PROVIDER_PRECEDENCE = ["lorcanajson", "scrydex", "lorcast", "tcgplayer"] as const;
const PROMOTION_IMAGE_PROVIDERS = {
  magic: ["scryfall"],
  onePiece: ["scrydex"],
  yugiohCardPrint: ["ygoprodeck"],
  yugiohSealedProduct: ["ygojson", "scrydex"],
};
const PROMOTION_IMAGE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  scryfall: ["cards.scryfall.io"],
  scrydex: ["images.scrydex.com", "cdn.scrydex.com"],
  ygojson: ["ms.yugipedia.com"],
  ygoprodeck: ["images.ygoprodeck.com"],
};

export const CATALOG_PRODUCT_IMAGE_RETENTION_POLICY = {
  policyKey: "catalog-product-image-retention-v1",
  retentionKind: "retain-while-referenced",
  previewRetentionDays: 90,
  takedownPath: "catalog-asset-takedown",
  removalSlaDays: 30,
} as const;

export type OnePieceImageEvidenceProviderKey = "scrydex" | "tcgplayer" | "bandai-official" | "comparison-only";

export type LorcanaImageEvidenceProviderKey =
  | "lorcanajson"
  | "lorcast"
  | "scrydex"
  | "tcgplayer"
  | "ravensburger-lorcana-official"
  | "disney-lorcana-official"
  | "comparison-only";

export type OnePieceImageEvidenceResult = Readonly<{
  status: "current" | "stale" | "missing" | "unapproved";
  imageUrls: readonly string[];
  diagnostics: readonly string[];
  retentionPolicy: typeof CATALOG_PRODUCT_IMAGE_RETENTION_POLICY;
}>;

export type LorcanaImageEvidenceCandidate = Readonly<{
  providerKey: LorcanaImageEvidenceProviderKey | string;
  imageUrls: readonly string[] | null | undefined;
  observedAt: string;
  sourceUpdatedAt?: string | null;
}>;

export type LorcanaImageEvidenceResult = Readonly<{
  status: "current" | "stale" | "missing" | "unapproved";
  providerKey: string;
  imageUrls: readonly string[];
  diagnostics: readonly string[];
  retentionPolicy: typeof CATALOG_PRODUCT_IMAGE_RETENTION_POLICY;
}>;

export type CatalogImageProcessor = Readonly<{
  metadata(body: Uint8Array): Promise<{ width: number; height: number }>;
  normalizeDisplaySource(body: Uint8Array): Promise<Uint8Array>;
  resizeToWebp(input: {
    body: Uint8Array;
    width: number;
    quality: number;
  }): Promise<{ body: Uint8Array; width: number; height: number }>;
}>;

export type NormalizeProductAssetInput = Readonly<{
  sourceBody: Uint8Array;
  sourceContentType: string;
  sourceProviderKey?: string;
  sourceUrl?: string | null;
  storageBaseKey: string;
  generatedAt: string;
  assetStorage: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
  preparedSource?: PreparedProductAssetSource;
}>;

export type PreparedProductAssetSource = Readonly<{
  sourceHash: string;
  displayHash: string;
  width: number;
  height: number;
  variants: readonly Readonly<{
    body: Uint8Array;
    width: number;
    height: number;
  }>[];
}>;

export type NormalizeLorcanaImageAssetInput = Readonly<{
  providerKey: LorcanaImageEvidenceProviderKey | string;
  imageUrls: readonly string[] | null | undefined;
  sourceUpdatedAt?: string | null;
  observedAt: string;
  storageBaseKey: string;
  fetcher: typeof globalThis.fetch;
  assetStorage: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}>;

/**
 * Fully decodes a retained source image without writing any derived assets.
 * Observation Pack replay calls this for every declared asset before the first
 * aggregate write so truncated or otherwise undecodable images fail closed.
 */
export async function assertDecodableProductAssetSource(body: Uint8Array): Promise<void> {
  if (body.byteLength === 0) {
    throw new Error("Product asset source image is empty.");
  }

  const { info } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height || info.channels < 1) {
    throw new Error("Product asset source image must decode to readable pixels.");
  }
}

export async function prepareProductAssetSource(
  sourceBody: Uint8Array,
  imageProcessor: CatalogImageProcessor = sharpImageProcessor,
): Promise<PreparedProductAssetSource> {
  const sourceHash = hashBytes(sourceBody);
  const displayBody = await imageProcessor.normalizeDisplaySource(sourceBody);
  const displayHash = hashBytes(displayBody);
  const metadata = await imageProcessor.metadata(sourceBody);
  const variants: PreparedProductAssetSource["variants"][number][] = [];
  for (const spec of PRODUCT_ASSET_VARIANT_SPECS) {
    variants.push(await imageProcessor.resizeToWebp({ body: displayBody, width: spec.width, quality: spec.quality }));
  }
  return { sourceHash, displayHash, ...metadata, variants };
}

export async function normalizeProductAssetSet(input: NormalizeProductAssetInput): Promise<ProductAssetSet> {
  const imageProcessor = input.imageProcessor ?? sharpImageProcessor;
  const sourceHash = hashBytes(input.sourceBody);
  const prepared = input.preparedSource ?? (await prepareProductAssetSource(input.sourceBody, imageProcessor));
  if (prepared.sourceHash !== sourceHash || prepared.variants.length !== PRODUCT_ASSET_VARIANT_SPECS.length) {
    throw new Error("Prepared product asset source does not match the source image.");
  }
  const displayHash = prepared.displayHash;
  const source = await storeVariant({
    assetStorage: input.assetStorage,
    storageKey: `${input.storageBaseKey}/source-${sourceHash.slice(0, 12)}.webp`,
    body: input.sourceBody,
    width: prepared.width,
    height: prepared.height,
    role: "source",
    density: null,
    generatedAt: input.generatedAt,
  });
  const variants: ProductAssetVariant[] = [];

  for (const [index, spec] of PRODUCT_ASSET_VARIANT_SPECS.entries()) {
    const resized = prepared.variants[index];
    variants.push(
      await storeVariant({
        assetStorage: input.assetStorage,
        storageKey: `${input.storageBaseKey}/${spec.role}-${spec.width}w-${spec.density}x-${sourceHash.slice(0, 12)}-${DISPLAY_NORMALIZATION_VERSION}-${displayHash.slice(0, 12)}.webp`,
        body: resized.body,
        width: resized.width,
        height: resized.height,
        role: spec.role,
        density: spec.density,
        generatedAt: input.generatedAt,
      }),
    );
  }

  return {
    kind: "product-image",
    sourceHash,
    sourcePolicy: {
      sourceProviderKey: normalizeProviderKey(input.sourceProviderKey ?? "unknown"),
      sourceUrlHost: sourceUrlHost(input.sourceUrl ?? null),
      sourceUrlHash: input.sourceUrl ? hashString(input.sourceUrl) : null,
      sourceContentType: input.sourceContentType,
      approval: "catalog-owned-rehost-approved",
      rehostingBehavior: "store-source-and-webp-display-variants",
      retention: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    },
    source,
    variants,
  };
}

export function extractApprovedLorcanaImageEvidence(input: LorcanaImageEvidenceCandidate): LorcanaImageEvidenceResult {
  const providerKey = normalizeProviderKey(input.providerKey);
  const approvedProvider = LORCANA_APPROVED_IMAGE_PROVIDER_PRECEDENCE.includes(
    providerKey as (typeof LORCANA_APPROVED_IMAGE_PROVIDER_PRECEDENCE)[number],
  );
  if (!approvedProvider) {
    return {
      status: "unapproved",
      providerKey,
      imageUrls: [],
      diagnostics: [`Provider '${providerKey}' is not approved for retained Lorcana image evidence.`],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  const imageUrls = [...new Set((input.imageUrls ?? []).map((url) => url.trim()).filter(isHttpsUrl))];
  if (imageUrls.length === 0) {
    return {
      status: "missing",
      providerKey,
      imageUrls: [],
      diagnostics: [`${providerKey} did not provide approved Lorcana image URI evidence.`],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  if (isStaleImageEvidence(input.sourceUpdatedAt ?? null, input.observedAt, LORCANA_IMAGE_EVIDENCE_STALE_AFTER_DAYS)) {
    return {
      status: "stale",
      providerKey,
      imageUrls,
      diagnostics: [
        `${providerKey} Lorcana image URI evidence is older than ${LORCANA_IMAGE_EVIDENCE_STALE_AFTER_DAYS} days and must be reviewed before rehosting.`,
      ],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  return {
    status: "current",
    providerKey,
    imageUrls,
    diagnostics: [],
    retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
  };
}

export function selectApprovedLorcanaImageEvidence(
  candidates: readonly LorcanaImageEvidenceCandidate[],
): LorcanaImageEvidenceResult {
  const evaluated = candidates.map(extractApprovedLorcanaImageEvidence);
  const currentByPrecedence = LORCANA_APPROVED_IMAGE_PROVIDER_PRECEDENCE.map((providerKey) =>
    evaluated.find((candidate) => candidate.providerKey === providerKey && candidate.status === "current"),
  ).find((candidate): candidate is LorcanaImageEvidenceResult => Boolean(candidate));
  if (currentByPrecedence) {
    return currentByPrecedence;
  }

  const staleByPrecedence = LORCANA_APPROVED_IMAGE_PROVIDER_PRECEDENCE.map((providerKey) =>
    evaluated.find((candidate) => candidate.providerKey === providerKey && candidate.status === "stale"),
  ).find((candidate): candidate is LorcanaImageEvidenceResult => Boolean(candidate));
  if (staleByPrecedence) {
    return staleByPrecedence;
  }

  return {
    status: "missing",
    providerKey: "none",
    imageUrls: [],
    diagnostics: evaluated.flatMap((candidate) => candidate.diagnostics),
    retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
  };
}

export async function normalizeLorcanaImageAsset(
  input: NormalizeLorcanaImageAssetInput,
): Promise<ProductAssetSet | null> {
  const evidence = extractApprovedLorcanaImageEvidence(input);
  if (evidence.status !== "current") {
    return null;
  }

  const sourceUrl = evidence.imageUrls[0];
  if (!sourceUrl) {
    return null;
  }

  if (currentProviderSendAdmission()?.enabled && currentProviderSendBinding()) {
    const destination = new URL(sourceUrl);
    // Evidence approves retention, not API access or credential-bearing image URLs.
    if (
      destination.protocol !== "https:" ||
      destination.username ||
      destination.password ||
      destination.search ||
      destination.hash ||
      destination.hostname.split(".").includes("api") ||
      /\/(?:api|v\d+)(?:\/|$)/i.test(destination.pathname) ||
      !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(destination.pathname)
    )
      throw new ProviderSendStoppedError("unknown-request");
  }
  const response = await sendCatalogProviderRequest("catalog-mirror", input.fetcher, sourceUrl, undefined, "asset");
  if (!response.ok) {
    throw new Error(`Lorcana image asset request failed with ${response.status} for ${sourceUrl}.`);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Lorcana image asset response must be an image for ${sourceUrl}.`);
  }

  const sourceBody = await sharp(new Uint8Array(await response.arrayBuffer()))
    .webp({ quality: 100 })
    .toBuffer();
  return normalizeProductAssetSet({
    sourceBody: new Uint8Array(sourceBody),
    sourceContentType: "image/webp",
    sourceProviderKey: evidence.providerKey,
    sourceUrl,
    storageBaseKey: input.storageBaseKey,
    generatedAt: input.observedAt,
    assetStorage: input.assetStorage,
    imageProcessor: input.imageProcessor,
  });
}

export function extractApprovedOnePieceImageEvidence(input: {
  providerKey: OnePieceImageEvidenceProviderKey | string;
  imageUrls: readonly string[] | null | undefined;
  observedAt: string;
  sourceUpdatedAt?: string | null;
}): OnePieceImageEvidenceResult {
  const providerKey = normalizeProviderKey(input.providerKey);
  // Retaining a source URI does not authorize fetching it during promotion.
  const approvedProvider = providerKey === "scrydex" || providerKey === "tcgplayer";
  if (!approvedProvider) {
    return {
      status: "unapproved",
      imageUrls: [],
      diagnostics: [`Provider '${providerKey}' is not approved for retained One Piece image evidence.`],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  const imageUrls = [...new Set((input.imageUrls ?? []).map((url) => url.trim()).filter(isHttpsUrl))];
  if (imageUrls.length === 0) {
    return {
      status: "missing",
      imageUrls: [],
      diagnostics: [`${providerKey} did not provide approved One Piece image URI evidence.`],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  if (
    isStaleImageEvidence(input.sourceUpdatedAt ?? null, input.observedAt, ONE_PIECE_IMAGE_EVIDENCE_STALE_AFTER_DAYS)
  ) {
    return {
      status: "stale",
      imageUrls,
      diagnostics: [
        `${providerKey} One Piece image URI evidence is older than ${ONE_PIECE_IMAGE_EVIDENCE_STALE_AFTER_DAYS} days and must be reviewed before rehosting.`,
      ],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  return {
    status: "current",
    imageUrls,
    diagnostics: [],
    retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
  };
}

type PromotionImageEvidenceInput = Readonly<{
  normalized: SourceObservationNormalized;
  providerKey: string;
  observedAt: string;
  sourceUpdatedAt: string | null;
}>;

export function canSupplyCatalogOwnedPromotionImage(providerKey: string): boolean {
  const key = normalizeProviderKey(providerKey);
  return Object.values(PROMOTION_IMAGE_PROVIDERS).some((providers) => providers.includes(key));
}

export function isCatalogOwnedPromotionImageKind(kind: SourceObservationNormalized["kind"]): boolean {
  return (
    kind === "magic-card-print" ||
    kind === "one-piece-card-print" ||
    kind === "one-piece-sealed-product" ||
    kind === "yugioh-card-print" ||
    kind === "yugioh-sealed-product"
  );
}

export function approvedPromotionImageUrls(input: PromotionImageEvidenceInput): readonly string[] {
  const { normalized } = input;
  const providerKey = normalizeProviderKey(input.providerKey);
  switch (normalized.kind) {
    case "magic-card-print":
      return PROMOTION_IMAGE_PROVIDERS.magic.includes(providerKey)
        ? safeImageUrls(providerKey, normalized.imageUrls)
        : [];
    case "one-piece-card-print":
    case "one-piece-sealed-product": {
      if (!PROMOTION_IMAGE_PROVIDERS.onePiece.includes(providerKey)) return [];
      const evidence = extractApprovedOnePieceImageEvidence({ ...input, imageUrls: normalized.imageUrls });
      return evidence.status === "current" ? safeImageUrls(providerKey, evidence.imageUrls) : [];
    }
    case "yugioh-card-print":
      return PROMOTION_IMAGE_PROVIDERS.yugiohCardPrint.includes(providerKey)
        ? safeImageUrls(providerKey, normalized.imageUrls)
        : [];
    case "yugioh-sealed-product":
      return PROMOTION_IMAGE_PROVIDERS.yugiohSealedProduct.includes(providerKey)
        ? safeImageUrls(providerKey, normalized.imageUrls)
        : [];
    default:
      return [];
  }
}

function safeImageUrls(providerKey: string, urls: readonly string[]): string[] {
  const hosts = PROMOTION_IMAGE_HOSTS[providerKey] ?? [];
  return [
    ...new Set(
      urls
        .map((url) => url.trim())
        .filter((url) => {
          const destination = URL.parse(url);
          if (!destination || !hosts.includes(destination.hostname)) return false;
          // Scryfall's public CDN can append a numeric cache-busting timestamp.
          const scryfallTimestamp = providerKey === "scryfall" && /^\?\d+$/.test(destination.search);
          return (
            destination.protocol === "https:" &&
            !destination.username &&
            !destination.password &&
            !destination.port &&
            !destination.hash &&
            (!destination.search || scryfallTimestamp)
          );
        }),
    ),
  ];
}

export async function normalizePromotionImageAsset(input: {
  providerKey: string;
  sourceUrl: string;
  observedAt: string;
  storageBaseKey: string;
  fetcher: typeof globalThis.fetch;
  assetStorage: CatalogAssetStorage;
  findExisting: (sourceHash: string) => ProductAssetSet | null | Promise<ProductAssetSet | null>;
}): Promise<ProductAssetSet> {
  const response = await readBoundedHttpObject({
    fetch: input.fetcher,
    url: input.sourceUrl,
    maxBytes: 10 * 1024 * 1024,
    deadlineMs: 15_000,
    accept: "image/*",
    category: "asset",
  });
  if (!response.contentType.toLowerCase().startsWith("image/")) {
    throw new Error("Catalog promotion image response must be an image.");
  }
  const sourceBody = await sharp(response.body).webp({ quality: 100 }).toBuffer();
  const existing = await input.findExisting(hashBytes(sourceBody));
  return (
    existing ??
    normalizeProductAssetSet({
      sourceBody,
      sourceContentType: "image/webp",
      sourceProviderKey: input.providerKey,
      sourceUrl: input.sourceUrl,
      storageBaseKey: input.storageBaseKey,
      generatedAt: input.observedAt,
      assetStorage: input.assetStorage,
    })
  );
}

async function storeVariant(input: {
  assetStorage: CatalogAssetStorage;
  storageKey: string;
  body: Uint8Array;
  width: number;
  height: number;
  role: ProductAssetVariant["role"];
  density: ProductAssetVariant["density"];
  generatedAt: string;
}): Promise<ProductAssetVariant> {
  const stored = await input.assetStorage.putObject({
    key: input.storageKey,
    body: input.body,
    contentType: "image/webp",
    cacheControl: ASSET_CACHE_CONTROL,
  });

  return {
    role: input.role,
    width: input.width,
    height: input.height,
    density: input.density,
    mediaType: "image/webp",
    storageKey: stored.key,
    publicUrl: stored.publicUrl,
    byteSize: input.body.byteLength,
    generatedAt: input.generatedAt,
  };
}

const sharpImageProcessor: CatalogImageProcessor = {
  async metadata(body) {
    const metadata = await sharp(body).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Product asset source image must have readable dimensions.");
    }

    return {
      width: metadata.width,
      height: metadata.height,
    };
  },
  async normalizeDisplaySource(body) {
    const { data } = await sharp(body)
      .ensureAlpha()
      .trim({
        threshold: 8,
      })
      .webp({ quality: 100, lossless: true })
      .toBuffer({ resolveWithObject: true });

    return new Uint8Array(data);
  },
  async resizeToWebp({ body, width, quality }) {
    const { data, info } = await sharp(body)
      .resize({
        width,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });

    return {
      body: new Uint8Array(data),
      width: info.width,
      height: info.height,
    };
  },
};

function hashBytes(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

function sourceUrlHost(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isStaleImageEvidence(sourceUpdatedAt: string | null, observedAt: string, staleAfterDays: number): boolean {
  if (!sourceUpdatedAt) {
    return false;
  }
  const sourceTime = Date.parse(sourceUpdatedAt);
  const observedTime = Date.parse(observedAt);
  if (!Number.isFinite(sourceTime) || !Number.isFinite(observedTime)) {
    return false;
  }
  const ageMs = observedTime - sourceTime;
  return ageMs > staleAfterDays * 24 * 60 * 60 * 1000;
}
