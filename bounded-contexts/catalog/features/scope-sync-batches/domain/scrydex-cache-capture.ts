import { z } from "zod";
import { catalogSyncAcceptedScopeMappingFromRow } from "../../source-observations/api/providers/catalog-sync-scope-planner";
import { countCaptureFields } from "./count-capture-plan";

// Hosted, cache-only capture of Scrydex option-cache membership for the One
// Piece and Lorcana Scope Sync Batch preview rows. One signed-in
// browser session reads only: the deployed profile roster, the complete
// active `set` Scope Record inventory, each Scope Record's accepted mappings
// (Scope Coverage `acceptedMappings`) and each declared unit's cached `sets`
// option list through its deployed `queryHref` with `cacheOnly=true`. It never
// refreshes, previews, confirms or contacts TCGplayer. This module owns the
// request fence, the response decoders and the receipt grammar; capture status
// is derived from the evidence, so an incomplete, late, unbound or fenced
// capture is governed unknown and never becomes membership authority.

export const scrydexCacheCaptureSchemaVersion = "scrydex-cache-capture/v1" as const;
export const scrydexCacheCaptureJourneyScope = "scrydex-cache-capture" as const;
export const scrydexCacheCaptureArtifactPath = "artifacts/catalog-scrydex-cache-capture/capture.json" as const;
export const scrydexCacheCaptureOrigin = "https://admin.staging.chasesets.com" as const;
export const scrydexCacheCaptureLandingPath = "/catalog/scopes/sync-batches" as const;
export const scrydexCacheCaptureProfilesPath = "/api/catalog/source-observations/provider-profiles" as const;
// Five One Piece and Lorcana Scope Records with three units each serialize to
// well under 10% of this bound; it caps the artifact, not the evidence.
export const scrydexCacheCaptureMaxBytes = 1_000_000;
// A response must complete this long before the cached row's staleUntil, so
// runner/server clock skew cannot turn a late read into a timely one.
export const scrydexCacheCaptureClockSkewToleranceMs = 60_000;
// integrations-loader-support.ts MAX_SOURCE_OPTION_CONTINUATION_PAGES.
export const scrydexCacheCaptureMaxContinuationPages = 100;
// scope-registry/api/route.ts SCOPE_LIST_MAX_LIMIT.
export const scrydexCacheCaptureScopePageLimit = 200;

export const scrydexCacheCaptureProductDomains = ["one-piece", "lorcana"] as const;
export type ScrydexCacheCaptureProductDomain = (typeof scrydexCacheCaptureProductDomains)[number];

// The participating Scrydex units: One Piece set/card/sealed and Lorcana
// set/card. Lorcana sealed products stay on TCGplayer.
export const scrydexCacheCaptureUnits = [
  { productDomain: "one-piece", unitKey: "scrydex:one-piece:set:reference-data" },
  { productDomain: "one-piece", unitKey: "scrydex:one-piece:single-card:source-observation-import" },
  { productDomain: "one-piece", unitKey: "scrydex:one-piece:sealed-product:source-observation-import" },
  { productDomain: "lorcana", unitKey: "scrydex:lorcana:set:reference-data" },
  { productDomain: "lorcana", unitKey: "scrydex:lorcana:single-card:source-observation-import" },
] as const;
export type ScrydexCacheCaptureUnitKey = (typeof scrydexCacheCaptureUnits)[number]["unitKey"];

const scopeRecordsPath = "/api/catalog/scope-records";
const coveragePrefix = "/api/catalog/provider-scope-mappings/coverage/";
const optionPath = "/api/catalog/source-observations/integration-options";
const originHost = new URL(scrydexCacheCaptureOrigin).host;
// provider-option-query-cache.ts MAX_PAGE_LIMIT; the loader's continuation limit.
const optionPageLimit = 200;
const unitKeys: readonly string[] = scrydexCacheCaptureUnits.map(({ unitKey }) => unitKey);
const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const offsetCursor = /^offset:(0|[1-9]\d{0,6})$/;

// --- Read paths ----------------------------------------------------------------

export function scrydexCacheCaptureScopePagePath(
  productDomain: ScrydexCacheCaptureProductDomain,
  offset: number,
): string {
  const params = new URLSearchParams({
    productDomain,
    scopeKind: "set",
    status: "active",
    limit: String(scrydexCacheCaptureScopePageLimit),
    offset: String(offset),
  });
  return `${scopeRecordsPath}?${params.toString()}`;
}

export function scrydexCacheCaptureCoveragePath(scopeRecordId: string): string {
  return `${coveragePrefix}${encodeURIComponent(scopeRecordId)}`;
}

// The Integrations loader's continuation (sourceOptionContinuationQuery): the
// deployed href with the cursor, the continuation limit, cache-only kept and
// any force refresh removed.
export function scrydexCacheCaptureContinuationPath(queryHref: string, cursor: string): string {
  const url = new URL(queryHref, scrydexCacheCaptureOrigin);
  url.searchParams.set("cursor", cursor);
  url.searchParams.set("limit", String(optionPageLimit));
  url.searchParams.set("cacheOnly", "true");
  url.searchParams.delete("forceRefresh");
  return `${url.pathname}?${url.searchParams.toString()}`;
}

// A deployed first-page `queryHref` is admissible only as a same-origin,
// cache-only Scrydex `sets` read for one declared unit.
export function scrydexCacheCaptureQueryHrefUnit(queryHref: string): ScrydexCacheCaptureUnitKey | null {
  let url: URL;
  try {
    url = new URL(queryHref, scrydexCacheCaptureOrigin);
  } catch {
    return null;
  }
  return url.origin === scrydexCacheCaptureOrigin ? cacheOnlyOptionUnit(url, false) : null;
}

const optionParams = new Set([
  "providerKey",
  "queryKind",
  "limit",
  "profileKey",
  "ingestionUnitKey",
  "languageCode",
  "cacheOnly",
  "cursor",
]);

function cacheOnlyOptionUnit(url: URL, allowCursor: boolean): ScrydexCacheCaptureUnitKey | null {
  if (url.pathname !== optionPath || !hasOnlyUniqueParams(url, optionParams)) return null;
  const params = url.searchParams;
  const limit = Number(params.get("limit"));
  const unitKey = params.get("ingestionUnitKey") ?? "";
  const cursor = params.get("cursor");
  const languageCode = params.get("languageCode");
  const admissible =
    params.get("providerKey") === "scrydex" &&
    params.get("queryKind") === "sets" &&
    params.get("cacheOnly") === "true" &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= optionPageLimit &&
    token.test(params.get("profileKey") ?? "") &&
    unitKeys.includes(unitKey) &&
    (languageCode === null || /^[a-z]{2,8}$/.test(languageCode)) &&
    (cursor === null || (allowCursor && offsetCursor.test(cursor)));
  return admissible ? (unitKey as ScrydexCacheCaptureUnitKey) : null;
}

function hasOnlyUniqueParams(url: URL, allowed: ReadonlySet<string>): boolean {
  const keys = [...url.searchParams.keys()];
  return new Set(keys).size === keys.length && keys.every((key) => allowed.has(key));
}

// --- Request fence -------------------------------------------------------------

export type ScrydexCacheCapturePhase = "sign-in" | "capture";
export type ScrydexCacheCaptureRequestClass =
  | "sign-in"
  | "profile-read"
  | "scope-inventory-read"
  | "coverage-read"
  | "cache-option-read"
  | "ambient-read-blocked"
  | "fence-refused";

export type ScrydexCacheCaptureRequestVerdict = Readonly<{
  requestClass: ScrydexCacheCaptureRequestClass;
  allowed: boolean;
  reason: string;
}>;

const refreshShapedParam = /^(_?intent|forceRefresh|refresh|sourceOptionAction)$/i;

// Every browser request in the session passes through this fence. Before the
// capture starts only the same-origin sign-in exchange may run: reads outside
// /api, navigations limited to /access and the landing page, and POSTs under
// /access (the bounded authentication exception). After it starts only the
// exact capture GETs may run; any other same-origin read is blocked without
// counting against the capture, and every mutation (sign-in and sign-out
// included), cross-origin, TCGplayer or refresh-shaped request is refused.
export function classifyScrydexCacheCaptureRequest(
  request: Readonly<{ method: string; url: string; phase: ScrydexCacheCapturePhase; navigation: boolean }>,
): ScrydexCacheCaptureRequestVerdict {
  const refuse = (reason: string): ScrydexCacheCaptureRequestVerdict => ({
    requestClass: "fence-refused",
    allowed: false,
    reason,
  });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return refuse("unparseable-url");
  }
  if (/tcgplayer/i.test(url.href)) return refuse("tcgplayer");
  if (url.origin !== scrydexCacheCaptureOrigin) return refuse("cross-origin");
  const method = request.method.toUpperCase();
  const path = url.pathname;
  if (request.phase === "sign-in") {
    if (method === "POST") {
      return path.startsWith("/access/")
        ? { requestClass: "sign-in", allowed: true, reason: "sign-in-exchange" }
        : refuse(`mutation:${method}`);
    }
    if (method !== "GET" && method !== "HEAD") return refuse(`mutation:${method}`);
    if (path.startsWith("/api/")) return refuse("api-before-capture");
    if ([...url.searchParams.keys()].some((key) => refreshShapedParam.test(key))) return refuse("refresh-shaped-read");
    if (request.navigation && !path.startsWith("/access/") && path !== scrydexCacheCaptureLandingPath) {
      return refuse("navigation-outside-sign-in");
    }
    return { requestClass: "sign-in", allowed: true, reason: "sign-in-read" };
  }
  if (method !== "GET") return refuse(`mutation:${method}`);
  const readClass = captureReadClass(url);
  if (readClass) return { requestClass: readClass, allowed: true, reason: readClass };
  if (path.startsWith("/api/")) return refuse("api-read-outside-capture");
  return { requestClass: "ambient-read-blocked", allowed: false, reason: "ambient-read" };
}

const scopePageParams = new Set(["productDomain", "scopeKind", "status", "limit", "offset"]);

function captureReadClass(url: URL): ScrydexCacheCaptureRequestClass | null {
  const params = url.searchParams;
  if (url.pathname === scrydexCacheCaptureProfilesPath) return url.search === "" ? "profile-read" : null;
  if (url.pathname === scopeRecordsPath) {
    return hasOnlyUniqueParams(url, scopePageParams) &&
      scrydexCacheCaptureProductDomains.includes(params.get("productDomain") as ScrydexCacheCaptureProductDomain) &&
      params.get("scopeKind") === "set" &&
      params.get("status") === "active" &&
      params.get("limit") === String(scrydexCacheCaptureScopePageLimit) &&
      /^(0|[1-9]\d{0,6})$/.test(params.get("offset") ?? "")
      ? "scope-inventory-read"
      : null;
  }
  if (url.pathname.startsWith(coveragePrefix)) {
    return url.search === "" && isCanonicalScopeRecordSegment(url.pathname.slice(coveragePrefix.length))
      ? "coverage-read"
      : null;
  }
  return cacheOnlyOptionUnit(url, true) ? "cache-option-read" : null;
}

function isCanonicalScopeRecordSegment(segment: string): boolean {
  try {
    const scopeRecordId = decodeURIComponent(segment);
    return token.test(scopeRecordId) && encodeURIComponent(scopeRecordId) === segment;
  } catch {
    return false;
  }
}

// --- Response decoders -----------------------------------------------------------

const { id, instant, count, hash, sha } = countCaptureFields;
const boundedText = z
  .string()
  .max(300)
  .regex(/^[^\u0000-\u001f\u007f]*$/);
const optionValue = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const cursorValue = z.string().regex(offsetCursor);
const cacheKey = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const reviewStatus = z.enum(["accepted", "auto-accepted"]);

export type ScrydexCacheCaptureDecoded<T> = Readonly<{ ok: true } & T> | Readonly<{ ok: false; reason: string }>;

const profilesShape = z.looseObject({
  items: z.array(
    z.looseObject({
      providerKey: z.string(),
      profileKey: z.string(),
      profileVersion: z.string(),
      ingestionUnitKey: z.string(),
      active: z.boolean(),
    }),
  ),
  total: count,
  count: count,
});

// The deployed provider-profile roster the Integrations loader derives every
// `queryHref` from; additive review fields pass through untouched.
export function decodeScrydexCacheCaptureProfiles(
  body: unknown,
): ScrydexCacheCaptureDecoded<{ profiles: readonly Record<string, unknown>[] }> {
  const parsed = profilesShape.safeParse(body);
  if (!parsed.success || parsed.data.total !== parsed.data.count || parsed.data.count !== parsed.data.items.length) {
    return { ok: false, reason: "profiles-malformed" };
  }
  return { ok: true, profiles: parsed.data.items };
}

const scopePageShape = z.looseObject({
  items: z
    .array(
      z.looseObject({
        scopeRecordId: id,
        productDomain: z.string(),
        scopeKind: z.literal("set"),
        lifecycleStatus: z.literal("active"),
      }),
    )
    .max(scrydexCacheCaptureScopePageLimit),
  total: count,
  count: count,
});

export function decodeScrydexCacheCaptureScopePage(
  body: unknown,
  expected: Readonly<{ productDomain: ScrydexCacheCaptureProductDomain }>,
): ScrydexCacheCaptureDecoded<{ total: number; scopeRecordIds: readonly string[] }> {
  const parsed = scopePageShape.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.count !== parsed.data.items.length ||
    parsed.data.items.some((item) => item.productDomain !== expected.productDomain)
  ) {
    return { ok: false, reason: "scope-page-malformed" };
  }
  return { ok: true, total: parsed.data.total, scopeRecordIds: parsed.data.items.map((item) => item.scopeRecordId) };
}

export type ScrydexCacheCaptureAcceptedMapping = Readonly<{
  mappingId: string;
  unitKey: string;
  reviewStatus: z.infer<typeof reviewStatus>;
  version: string;
  setId: string | null;
  setName: string | null;
}>;

const coverageShape = z.looseObject({
  schemaVersion: z.literal("catalog-scope-coverage-v1"),
  scopeRecordId: z.string(),
  productDomain: z.string(),
  providers: z.array(z.looseObject({ providerKey: z.string() })),
});
const acceptedMappingShape = z.looseObject({
  mappingId: id,
  scopeRecordId: z.string(),
  providerKey: z.string(),
  unitKey: id,
  reviewStatus,
  updatedAt: instant,
  coordinates: z.looseObject({ setId: boundedText.nullable(), setName: boundedText.nullable() }),
});

// Scope Coverage keeps one representative `mapping` per provider; only the
// required `acceptedMappings` array carries every accepted unit mapping. A
// deployment without it is refused, never read through the representative.
export function decodeScrydexAcceptedMappings(
  body: unknown,
  expected: Readonly<{ scopeRecordId: string; productDomain: ScrydexCacheCaptureProductDomain }>,
): ScrydexCacheCaptureDecoded<{ mappings: readonly ScrydexCacheCaptureAcceptedMapping[] }> {
  const coverage = coverageShape.safeParse(body);
  if (!coverage.success) return { ok: false, reason: "coverage-malformed" };
  if (
    coverage.data.scopeRecordId !== expected.scopeRecordId ||
    coverage.data.productDomain !== expected.productDomain
  ) {
    return { ok: false, reason: "coverage-scope-mismatch" };
  }
  const providerKeys = coverage.data.providers.map((row) => row.providerKey);
  if (new Set(providerKeys).size !== providerKeys.length) return { ok: false, reason: "coverage-provider-duplicate" };
  const scrydex = coverage.data.providers.find((row) => row.providerKey === "scrydex");
  if (!scrydex) return { ok: true, mappings: [] };
  if (!Array.isArray(scrydex.acceptedMappings)) return { ok: false, reason: "coverage-accepted-mappings-missing" };
  const parsed = z.array(acceptedMappingShape).safeParse(scrydex.acceptedMappings);
  if (
    !parsed.success ||
    parsed.data.some((mapping) => mapping.scopeRecordId !== expected.scopeRecordId || mapping.providerKey !== "scrydex")
  ) {
    return { ok: false, reason: "coverage-mapping-malformed" };
  }
  const mappingIds = parsed.data.map((mapping) => mapping.mappingId);
  const mappedUnits = parsed.data.map((mapping) => mapping.unitKey);
  if (new Set(mappingIds).size !== mappingIds.length || new Set(mappedUnits).size !== mappedUnits.length) {
    return { ok: false, reason: "coverage-mapping-duplicate" };
  }
  return {
    ok: true,
    mappings: parsed.data.map((mapping) => ({
      mappingId: mapping.mappingId,
      unitKey: mapping.unitKey,
      reviewStatus: mapping.reviewStatus,
      version: mapping.updatedAt,
      setId: mapping.coordinates.setId,
      setName: mapping.coordinates.setName,
    })),
  };
}

export type ScrydexCacheCaptureOptionPage = Readonly<{
  cursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
  count: number;
  values: readonly string[];
  cache: Readonly<{
    status: "fresh" | "stale";
    cacheKey: string;
    fetchedAt: string;
    expiresAt: string;
    staleUntil: string;
  }>;
}>;

const optionPageShape = z.looseObject({
  items: z
    .array(z.looseObject({ providerKey: z.literal("scrydex"), queryKind: z.literal("sets"), value: optionValue }))
    .max(optionPageLimit),
  total: count,
  count: count,
  page: z.looseObject({
    cursor: cursorValue.nullable(),
    nextCursor: cursorValue.nullable(),
    limit: z.number().int().min(1).max(optionPageLimit),
    hasMore: z.boolean(),
  }),
  cache: z.looseObject({
    status: z.string(),
    source: z.string(),
    cacheKey: z.string(),
    fetchedAt: instant.nullable(),
    expiresAt: instant.nullable(),
    staleUntil: instant.nullable(),
    cacheOnly: z.boolean(),
    forceRefresh: z.boolean(),
  }),
});

// One page of the shipped cache-only option route. A live source, a forced or
// non-cache-only read, and any status but fresh or stale are refused by name:
// they are evidence of provider I/O or of no cached row, never membership.
export function decodeScrydexCacheCaptureOptionPage(
  body: unknown,
  expected: Readonly<{ cursor: string | null }>,
): ScrydexCacheCaptureDecoded<{ page: ScrydexCacheCaptureOptionPage }> {
  const parsed = optionPageShape.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "option-page-malformed" };
  const { items, total, page, cache } = parsed.data;
  if (cache.source === "live") return { ok: false, reason: "option-live-read" };
  if (cache.cacheOnly !== true || cache.forceRefresh !== false) return { ok: false, reason: "option-not-cache-only" };
  if (cache.status !== "fresh" && cache.status !== "stale") return { ok: false, reason: "option-cache-status" };
  const { fetchedAt, expiresAt, staleUntil } = cache;
  if (
    cache.source !== "cache" ||
    !cacheKey.safeParse(cache.cacheKey).success ||
    fetchedAt === null ||
    expiresAt === null ||
    staleUntil === null ||
    !(Date.parse(fetchedAt) <= Date.parse(expiresAt) && Date.parse(expiresAt) <= Date.parse(staleUntil)) ||
    page.cursor !== expected.cursor ||
    parsed.data.count !== items.length ||
    items.length > page.limit ||
    page.hasMore !== (page.nextCursor !== null)
  ) {
    return { ok: false, reason: "option-page-malformed" };
  }
  return {
    ok: true,
    page: {
      cursor: page.cursor,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      total,
      count: items.length,
      values: items.map((item) => item.value),
      cache: { status: cache.status, cacheKey: cache.cacheKey, fetchedAt, expiresAt, staleUntil },
    },
  };
}

// The coordinate the shipped Scrydex planner reads from an accepted mapping:
// the planner's own row normalization, then setId before setName
// (catalog-sync-scope-planner.ts:79-80,689-690; scrydex/adapter.ts set, card and
// sealed planning). No canonical name or representative mapping substitutes.
export function scrydexCacheCaptureCoordinate(
  mapping: ScrydexCacheCaptureAcceptedMapping,
  scopeRecordId: string,
): string | null {
  const accepted = catalogSyncAcceptedScopeMappingFromRow({
    scope_record_id: scopeRecordId,
    provider_key: "scrydex",
    unit_key: mapping.unitKey,
    product_line_id: null,
    series_id: null,
    set_id: mapping.setId,
    set_name: mapping.setName,
    mapping_id: mapping.mappingId,
    review_status: mapping.reviewStatus,
    updated_at: mapping.version,
  });
  return accepted.setId ?? accepted.setName ?? null;
}

// --- Receipt ---------------------------------------------------------------------

const githubId = z.string().regex(/^[1-9]\d{0,19}$/);
const reasonCode = z.string().regex(/^[a-z0-9-]{1,64}(?::[A-Za-z0-9._:-]{1,200})?$/);
const stopCode = z.string().regex(/^[a-z0-9-]{1,64}$/);
const productDomain = z.enum(scrydexCacheCaptureProductDomains);
const readStamp = { completedAt: instant, responseSha256: hash };

const generationSchema = z
  .object({
    runId: githubId,
    runAttempt: z.number().int().min(1).max(100),
    jobId: githubId,
    jobCompletedAt: instant,
    deployedHead: sha,
    imageDigest: cacheKey,
  })
  .strict();
export type ScrydexCacheCaptureDeployGeneration = z.infer<typeof generationSchema>;

const mappingEvidenceSchema = z
  .object({
    mappingId: id,
    unitKey: id,
    reviewStatus,
    version: instant,
    setId: boundedText.nullable(),
    setName: boundedText.nullable(),
  })
  .strict();
const mappingReceiptSchema = mappingEvidenceSchema
  .extend({ coordinate: boundedText.nullable(), membership: z.enum(["member", "non-member", "unreadable"]) })
  .strict();
const scopeShape = { scopeRecordId: id, productDomain, ...readStamp };

const unitSchema = z
  .object({
    productDomain,
    unitKey: z.enum(unitKeys as [ScrydexCacheCaptureUnitKey, ...ScrydexCacheCaptureUnitKey[]]),
    profileKey: id,
    queryHref: z.string().min(1).max(1000),
    cache: z
      .object({
        status: z.enum(["fresh", "stale"]),
        cacheKey,
        fetchedAt: instant,
        expiresAt: instant,
        staleUntil: instant,
      })
      .strict(),
    pages: z
      .array(
        z
          .object({
            cursor: cursorValue.nullable(),
            nextCursor: cursorValue.nullable(),
            count,
            total: count,
            ...readStamp,
          })
          .strict(),
      )
      .min(1)
      .max(scrydexCacheCaptureMaxContinuationPages + 1),
    values: z.array(optionValue).max((scrydexCacheCaptureMaxContinuationPages + 1) * optionPageLimit),
  })
  .strict();

const evidenceShape = {
  runner: z
    .object({
      sha,
      runId: githubId,
      runAttempt: githubId,
      journeyScope: z.literal(scrydexCacheCaptureJourneyScope),
      origin: z.literal(originHost),
    })
    .strict(),
  deployment: z
    .object({
      before: generationSchema.nullable(),
      after: generationSchema.nullable(),
      beforeStop: stopCode.nullable(),
      afterStop: stopCode.nullable(),
    })
    .strict(),
  startedAt: instant,
  finishedAt: instant,
  // Browser-observed requests by fence class, and the reads the runner issued.
  requests: z
    .object({
      signIn: count,
      profileReads: count,
      scopeInventoryReads: count,
      coverageReads: count,
      cacheOptionReads: count,
      ambientReadsBlocked: count,
      fenceRefusals: count,
    })
    .strict(),
  reads: z
    .object({ profileReads: count, scopeInventoryReads: count, coverageReads: count, cacheOptionReads: count })
    .strict(),
  fence: z
    .array(
      z
        .object({
          method: z.string().regex(/^[A-Z]{1,12}$/),
          path: z.string().regex(/^[\x21-\x7e]{1,300}$/),
          reason: reasonCode,
        })
        .strict(),
    )
    .max(50),
  profileRead: z.object(readStamp).strict().nullable(),
  scopeInventories: z
    .array(
      z
        .object({
          productDomain,
          total: count,
          scopeRecordIds: z.array(id).max(5000),
          pages: z.array(z.object({ offset: count, count, ...readStamp }).strict()).max(50),
        })
        .strict(),
    )
    .max(scrydexCacheCaptureProductDomains.length),
  units: z.array(unitSchema).max(scrydexCacheCaptureUnits.length),
  failures: z.array(reasonCode).max(200),
};

const evidenceSchema = z
  .object({
    ...evidenceShape,
    scopes: z.array(z.object({ ...scopeShape, mappings: z.array(mappingEvidenceSchema).max(50) }).strict()).max(5000),
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal(scrydexCacheCaptureSchemaVersion),
    captureStatus: z.enum(["complete", "governed-unknown"]),
    reasons: z.array(reasonCode).max(1000),
    ...evidenceShape,
    scopes: z.array(z.object({ ...scopeShape, mappings: z.array(mappingReceiptSchema).max(50) }).strict()).max(5000),
  })
  .strict();

export type ScrydexCacheCaptureEvidence = z.infer<typeof evidenceSchema>;
export type ScrydexCacheCaptureReceipt = z.infer<typeof receiptSchema>;
type UnitCapture = ScrydexCacheCaptureEvidence["units"][number];

export function buildScrydexCacheCaptureReceipt(evidence: ScrydexCacheCaptureEvidence): ScrydexCacheCaptureReceipt {
  const reasons = deriveReasons(evidence);
  const readable = new Map(
    evidence.units
      .filter((unit) => unitCaptureReasons(unit, evidence).length === 0)
      .map((unit) => [unit.unitKey as string, new Set(unit.values)]),
  );
  return {
    schemaVersion: scrydexCacheCaptureSchemaVersion,
    captureStatus: reasons.length === 0 ? "complete" : "governed-unknown",
    reasons,
    ...evidence,
    scopes: evidence.scopes.map((scope) => ({
      ...scope,
      mappings: scope.mappings.map((mapping) => {
        const coordinate = scrydexCacheCaptureCoordinate(mapping, scope.scopeRecordId);
        const values = readable.get(mapping.unitKey);
        return {
          ...mapping,
          coordinate,
          membership: !values ? "unreadable" : coordinate !== null && values.has(coordinate) ? "member" : "non-member",
        };
      }),
    })),
  };
}

// Value-free: shape issues name only their path and code, and every derived
// field (reasons, status, coordinate, membership) is rebuilt from the evidence
// rather than trusted.
export function validateScrydexCacheCaptureReceipt(value: unknown): readonly string[] {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.code}`);
  }
  const { schemaVersion: _schemaVersion, captureStatus, reasons, scopes, ...rest } = parsed.data;
  const errors: string[] = [];
  const { before, after, beforeStop, afterStop } = rest.deployment;
  if ((before === null) !== (beforeStop !== null)) errors.push("deployment.beforeStop: inconsistent");
  if ((after === null) !== (afterStop !== null)) errors.push("deployment.afterStop: inconsistent");
  if (Date.parse(rest.startedAt) > Date.parse(rest.finishedAt)) errors.push("finishedAt: precedes startedAt");
  const rebuilt = buildScrydexCacheCaptureReceipt({
    ...rest,
    scopes: scopes.map((scope) => ({
      ...scope,
      mappings: scope.mappings.map(({ coordinate: _coordinate, membership: _membership, ...mapping }) => mapping),
    })),
  });
  if (canonicalJson(rebuilt.reasons) !== canonicalJson(reasons)) errors.push("reasons: differ from the evidence");
  if (rebuilt.captureStatus !== captureStatus) errors.push("captureStatus: differs from the evidence");
  if (canonicalJson(rebuilt.scopes) !== canonicalJson(scopes)) {
    errors.push("scopes: coordinate or membership differs from the evidence");
  }
  return errors;
}

function deriveReasons(evidence: ScrydexCacheCaptureEvidence): string[] {
  const reasons = new Set<string>(evidence.failures);
  const { before, after, beforeStop, afterStop } = evidence.deployment;
  if (!before) reasons.add(`deployment-unbound:before${beforeStop ? `:${beforeStop}` : ""}`);
  if (!after) reasons.add(`deployment-unbound:after${afterStop ? `:${afterStop}` : ""}`);
  if (before && after && canonicalJson(before) !== canonicalJson(after)) reasons.add("deployment-changed");
  if (before && Date.parse(before.jobCompletedAt) > Date.parse(evidence.startedAt))
    reasons.add("deployment-not-settled");
  if (evidence.requests.fenceRefusals > 0 || evidence.fence.length > 0) reasons.add("fence-refused");
  for (const [key, requestClass] of [
    ["profileReads", "profile-read"],
    ["scopeInventoryReads", "scope-inventory-read"],
    ["coverageReads", "coverage-read"],
    ["cacheOptionReads", "cache-option-read"],
  ] as const) {
    if (evidence.requests[key] !== evidence.reads[key]) reasons.add(`request-accounting-mismatch:${requestClass}`);
  }
  if (!evidence.profileRead) reasons.add("profile-read-missing");

  for (const domain of scrydexCacheCaptureProductDomains) {
    const inventories = evidence.scopeInventories.filter((inventory) => inventory.productDomain === domain);
    const inventoried = inventories[0]?.scopeRecordIds ?? [];
    if (
      inventories.length !== 1 ||
      new Set(inventoried).size !== inventoried.length ||
      inventoried.length !== inventories[0]!.total
    ) {
      reasons.add(`scope-inventory-incomplete:${domain}`);
    }
    const covered = evidence.scopes
      .filter((scope) => scope.productDomain === domain)
      .map((scope) => scope.scopeRecordId);
    if (
      inventories.length !== 1 ||
      covered.length !== inventoried.length ||
      new Set(covered).size !== covered.length ||
      covered.some((scopeRecordId) => !inventoried.includes(scopeRecordId))
    ) {
      reasons.add(`coverage-incomplete:${domain}`);
    }
  }

  const mappingIds = new Set<string>();
  const mappedUnits = new Set<string>();
  for (const scope of evidence.scopes) {
    const scopeUnits = new Set<string>();
    for (const mapping of scope.mappings) {
      const declared = scrydexCacheCaptureUnits.find((unit) => unit.unitKey === mapping.unitKey);
      if (!declared || declared.productDomain !== scope.productDomain)
        reasons.add(`undeclared-unit:${mapping.unitKey}`);
      else mappedUnits.add(mapping.unitKey);
      if (scopeUnits.has(mapping.unitKey) || mappingIds.has(mapping.mappingId)) {
        reasons.add(`mapping-duplicate:${scope.scopeRecordId}`);
      }
      scopeUnits.add(mapping.unitKey);
      mappingIds.add(mapping.mappingId);
    }
  }

  for (const { unitKey } of scrydexCacheCaptureUnits) {
    if (!mappedUnits.has(unitKey)) reasons.add(`required-unit-unmapped:${unitKey}`);
    const captures = evidence.units.filter((unit) => unit.unitKey === unitKey);
    if (captures.length === 0) reasons.add(`option-list-missing:${unitKey}`);
    else if (captures.length > 1) reasons.add(`option-list-duplicate:${unitKey}`);
    else for (const reason of unitCaptureReasons(captures[0]!, evidence)) reasons.add(reason);
  }
  return [...reasons].sort();
}

function unitCaptureReasons(unit: UnitCapture, evidence: ScrydexCacheCaptureEvidence): string[] {
  const reasons: string[] = [];
  const declared = scrydexCacheCaptureUnits.find((candidate) => candidate.unitKey === unit.unitKey);
  const hrefProfileKey = new URL(unit.queryHref, scrydexCacheCaptureOrigin).searchParams.get("profileKey");
  if (
    declared?.productDomain !== unit.productDomain ||
    scrydexCacheCaptureQueryHrefUnit(unit.queryHref) !== unit.unitKey ||
    hrefProfileKey !== unit.profileKey
  ) {
    reasons.push(`option-href-mismatch:${unit.unitKey}`);
  }
  const { fetchedAt, expiresAt, staleUntil } = unit.cache;
  if (
    !(Date.parse(fetchedAt) <= Date.parse(expiresAt) && Date.parse(expiresAt) <= Date.parse(staleUntil)) ||
    !optionListComplete(unit)
  ) {
    reasons.push(`option-list-incomplete:${unit.unitKey}`);
  }
  const deadline = Date.parse(staleUntil) - scrydexCacheCaptureClockSkewToleranceMs;
  if (unit.pages.some((page) => Date.parse(page.completedAt) >= deadline))
    reasons.push(`option-list-late:${unit.unitKey}`);
  if (
    unit.pages.some(
      (page) =>
        Date.parse(page.completedAt) < Date.parse(evidence.startedAt) ||
        Date.parse(page.completedAt) > Date.parse(evidence.finishedAt),
    )
  ) {
    reasons.push(`option-list-unbound:${unit.unitKey}`);
  }
  return reasons;
}

// Total-closed continuation: the first page has no cursor, each next cursor is
// the offset already collected, the last page has none, the total never moves
// and every value up to it was collected.
function optionListComplete(unit: UnitCapture): boolean {
  const total = unit.pages[0]!.total;
  let collected = 0;
  let cursor: string | null = null;
  for (const [index, page] of unit.pages.entries()) {
    if (page.cursor !== cursor || page.total !== total) return false;
    collected += page.count;
    const last = index === unit.pages.length - 1;
    if (last ? page.nextCursor !== null : page.nextCursor !== `offset:${collected}`) return false;
    cursor = page.nextCursor;
  }
  return collected === total && unit.values.length === total;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
