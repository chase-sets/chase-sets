import { z } from "zod";
import { scrydexCacheCaptureUnits } from "./scrydex-cache-capture";

/** The five Scrydex units that make up the coordinate proof. */
export const scrydexCoordinatePreviewUnits = scrydexCacheCaptureUnits;
export const scrydexCoordinatePreviewSchemaVersion = "scrydex-coordinate-preview/v1" as const;
export const scrydexCoordinatePreviewJourneyScope = "scrydex-coordinate-preview" as const;
export const scrydexCoordinatePreviewOrigin = "https://admin.staging.chasesets.com" as const;
export const scrydexCoordinatePreviewArtifactPath =
  "artifacts/catalog-scrydex-coordinate-preview/receipt.json" as const;
export const scrydexCoordinatePreviewMaxBytes = 1_000_000;
export const scrydexCoordinatePreviewMaxRows = 5;
const originHost = new URL(scrydexCoordinatePreviewOrigin).host;
const id = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const instant = z.string().datetime({ offset: true });
const safeText = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\u0000-\u001f\u007f]*$/);
const unitKey = z.enum(scrydexCoordinatePreviewUnits.map((u) => u.unitKey) as [string, ...string[]]);

export type ScrydexCoordinatePreviewUnitKey = z.infer<typeof unitKey>;
export type ScrydexCoordinatePreviewRequestClass =
  | "sign-in"
  | "profile-read"
  | "scope-inventory-read"
  | "coverage-read"
  | "cache-option-read"
  | "usage-read"
  | "preview"
  | "ambient-read-blocked"
  | "fence-refused";
export type ScrydexCoordinatePreviewPhase = "sign-in" | "capture" | "pre-confirm";

export type ScrydexCoordinatePreviewRequestVerdict = Readonly<{
  requestClass: ScrydexCoordinatePreviewRequestClass;
  allowed: boolean;
  reason: string;
}>;

const optionPath = "/api/catalog/source-observations/integration-options";
const profilesPath = "/api/catalog/source-observations/provider-profiles";
const scopesPath = "/api/catalog/scope-records";
const coveragePrefix = "/api/catalog/provider-scope-mappings/coverage/";
const previewPath = "/api/catalog/scope-sync-batches/preview";
const usagePath = "/api/catalog/source-observations/integration-control-plane/overview";
const refreshParam = /^(_?intent|forceRefresh|refresh|sourceOptionAction)$/i;
const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

function uniqueParams(url: URL, allowed: ReadonlySet<string>): boolean {
  const keys = [...url.searchParams.keys()];
  return new Set(keys).size === keys.length && keys.every((key) => allowed.has(key));
}

function isOptionRead(url: URL): boolean {
  if (url.pathname !== optionPath || !uniqueParams(url, optionParams)) return false;
  const p = url.searchParams;
  const unit = p.get("ingestionUnitKey") ?? "";
  const limit = Number(p.get("limit"));
  return (
    p.get("providerKey") === "scrydex" &&
    p.get("queryKind") === "sets" &&
    p.get("cacheOnly") === "true" &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= 200 &&
    token.test(p.get("profileKey") ?? "") &&
    scrydexCoordinatePreviewUnits.some((candidate) => candidate.unitKey === unit) &&
    (p.get("cursor") === null || /^offset:(0|[1-9]\d{0,6})$/.test(p.get("cursor") ?? ""))
  );
}

/** Every browser request in the dedicated journey passes through this fence. */
export function classifyScrydexCoordinatePreviewRequest(
  input: Readonly<{
    method: string;
    url: string;
    phase: ScrydexCoordinatePreviewPhase;
    navigation?: boolean;
  }>,
): ScrydexCoordinatePreviewRequestVerdict {
  const refuse = (reason: string): ScrydexCoordinatePreviewRequestVerdict => ({
    requestClass: "fence-refused",
    allowed: false,
    reason,
  });
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return refuse("unparseable-url");
  }
  if (/tcgplayer/i.test(url.href)) return refuse("tcgplayer");
  if (url.origin !== scrydexCoordinatePreviewOrigin) return refuse("cross-origin");
  const method = input.method.toUpperCase();
  if (input.phase === "sign-in") {
    if (method === "POST" && url.pathname.startsWith("/access/"))
      return { requestClass: "sign-in", allowed: true, reason: "sign-in-exchange" };
    if (method !== "GET" && method !== "HEAD") return refuse(`mutation:${method}`);
    if (url.pathname.startsWith("/api/")) return refuse("api-before-capture");
    if ([...url.searchParams.keys()].some((key) => refreshParam.test(key))) return refuse("refresh-shaped-read");
    if (input.navigation && !url.pathname.startsWith("/access/") && url.pathname !== "/catalog/scopes/sync-batches")
      return refuse("navigation-outside-sign-in");
    return { requestClass: "sign-in", allowed: true, reason: "sign-in-read" };
  }
  if (input.phase === "pre-confirm" && method === "POST" && url.pathname === previewPath && url.search === "")
    return { requestClass: "preview", allowed: true, reason: "single-preview" };
  if (method !== "GET") return refuse(`mutation:${method}`);
  if (url.pathname === profilesPath && url.search === "")
    return { requestClass: "profile-read", allowed: true, reason: "profile-read" };
  if (url.pathname === usagePath && url.search === "?audience=daily")
    return { requestClass: "usage-read", allowed: true, reason: "usage-read" };
  if (
    url.pathname === scopesPath &&
    uniqueParams(url, new Set(["productDomain", "scopeKind", "status", "limit", "offset"]))
  )
    return { requestClass: "scope-inventory-read", allowed: true, reason: "scope-inventory-read" };
  if (
    url.pathname.startsWith(coveragePrefix) &&
    url.search === "" &&
    token.test(decodeURIComponent(url.pathname.slice(coveragePrefix.length)))
  )
    return { requestClass: "coverage-read", allowed: true, reason: "coverage-read" };
  if (isOptionRead(url)) return { requestClass: "cache-option-read", allowed: true, reason: "cache-option-read" };
  if (url.pathname.startsWith("/api/")) return refuse("api-read-outside-capture");
  return { requestClass: "ambient-read-blocked", allowed: false, reason: "ambient-read" };
}

const mappingSchema = z
  .object({
    mappingId: id,
    unitKey,
    version: instant,
    reviewStatus: z.enum(["accepted", "auto-accepted"]),
    setId: safeText.nullable(),
    setName: safeText.nullable(),
    coordinate: safeText.nullable(),
    membership: z.enum(["member", "non-member", "unreadable"]),
  })
  .strict();
const rowSchema = z
  .object({
    scopeRecordId: id,
    productDomain: z.enum(["one-piece", "lorcana"]),
    previewFingerprint: sha,
    resolvedAt: instant,
    previewRevision: safeText,
    unitKey,
    mapping: mappingSchema,
    profileKey: id,
    profileVersion: id,
    setId: safeText.nullable(),
    setName: safeText.nullable(),
    cacheKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    cacheFetchedAt: instant,
    cacheExpiresAt: instant,
    cacheStaleUntil: instant,
  })
  .strict();
const generationSchema = z
  .object({
    runId: z.string().regex(/^[1-9]\d{0,19}$/),
    runAttempt: z.number().int().min(1).max(100),
    jobId: z.string().regex(/^[1-9]\d{0,19}$/),
    jobCompletedAt: instant,
    deployedHead: gitSha,
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal(scrydexCoordinatePreviewSchemaVersion),
    outcome: z.enum(["complete", "governed-unknown"]),
    reasons: z.array(z.string().regex(/^[a-z0-9-]{1,64}(?::[A-Za-z0-9._:-]{1,200})?$/)).max(100),
    runner: z
      .object({
        sha: gitSha,
        runId: z.string().regex(/^[1-9]\d{0,19}$/),
        runAttempt: z.string().regex(/^[1-9]\d{0,19}$/),
        journeyScope: z.literal(scrydexCoordinatePreviewJourneyScope),
        origin: z.literal(originHost),
      })
      .strict(),
    deployment: z.object({ before: generationSchema.nullable(), after: generationSchema.nullable() }).strict(),
    startedAt: instant,
    finishedAt: instant,
    preview: z
      .object({
        fingerprint: sha,
        resolvedAt: instant,
        revision: safeText,
        status: z.enum(["ready", "blocked", "empty"]),
        confirmAllowed: z.boolean(),
        blockers: z
          .array(
            z.object({ code: safeText, scopeRecordId: safeText.nullable(), providerKey: safeText.nullable() }).strict(),
          )
          .max(100),
        samples: z
          .array(
            z
              .object({
                scopeRecordId: id,
                mappingVersions: z
                  .array(z.object({ mappingId: id, version: instant, reviewStatus: z.string() }).strict())
                  .max(50),
                profileVersions: z
                  .array(z.object({ providerKey: safeText, unitKey, profileKey: id, profileVersion: id }).strict())
                  .max(50),
              })
              .strict(),
          )
          .max(50),
      })
      .strict()
      .nullable(),
    rows: z.array(rowSchema).max(scrydexCoordinatePreviewMaxRows),
    phases: z
      .array(z.enum(["deployment-before", "sign-in", "readiness", "preview", "coverage", "cache", "pre-confirm"]))
      .max(20),
    requests: z
      .object({
        signIn: z.number().int().nonnegative(),
        profileReads: z.number().int().nonnegative(),
        scopeInventoryReads: z.number().int().nonnegative(),
        coverageReads: z.number().int().nonnegative(),
        cacheOptionReads: z.number().int().nonnegative(),
        usageReads: z.number().int().nonnegative(),
        previewPosts: z.number().int().nonnegative(),
        forbidden: z.number().int().nonnegative(),
      })
      .strict(),
    forbiddenCalls: z.array(safeText).max(100),
    usageRead: z.object({ count: z.number().int().min(1).max(1), allowed: z.literal(true) }).strict(),
  })
  .strict();
export type ScrydexCoordinatePreviewReceipt = z.infer<typeof receiptSchema>;
export type ScrydexCoordinatePreviewRow = z.infer<typeof rowSchema>;

export function buildScrydexCoordinatePreviewReceipt(
  input: ScrydexCoordinatePreviewReceipt,
): ScrydexCoordinatePreviewReceipt {
  const reasons = new Set(input.reasons);
  if (input.deployment.before === null || input.deployment.after === null) reasons.add("deployment-unbound");
  if (
    input.deployment.before &&
    input.deployment.after &&
    input.deployment.before.deployedHead !== input.deployment.after.deployedHead
  )
    reasons.add("deployment-mismatch");
  if (input.rows.length !== scrydexCoordinatePreviewMaxRows) reasons.add("rows-not-exactly-five");
  if (!input.preview || input.preview.status !== "ready" || !input.preview.confirmAllowed)
    reasons.add("preview-not-confirmable");
  if (input.forbiddenCalls.length > 0 || input.requests.forbidden > 0) reasons.add("forbidden-call");
  const outcome = reasons.size === 0 ? "complete" : "governed-unknown";
  return { ...input, outcome, reasons: [...reasons].sort() };
}

export function validateScrydexCoordinatePreviewReceipt(value: unknown): readonly string[] {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.slice(0, 30).map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.code}`);
  const receipt = parsed.data;
  const errors: string[] = [];
  if (Date.parse(receipt.startedAt) > Date.parse(receipt.finishedAt)) errors.push("finishedAt: precedes startedAt");
  if (receipt.rows.length !== 5) errors.push("rows: expected exactly five");
  if (new Set(receipt.rows.map((row) => `${row.scopeRecordId}:${row.unitKey}`)).size !== receipt.rows.length)
    errors.push("rows: duplicate join");
  const expected = new Set<string>(scrydexCoordinatePreviewUnits.map((unit) => unit.unitKey));
  if (
    new Set(receipt.rows.map((row) => row.unitKey)).size !== expected.size ||
    receipt.rows.some((row) => !expected.has(row.unitKey))
  )
    errors.push("rows: unit membership mismatch");
  const byDomain = new Map<string, Set<string>>();
  for (const row of receipt.rows) {
    const units = byDomain.get(row.productDomain) ?? new Set<string>();
    units.add(row.unitKey);
    byDomain.set(row.productDomain, units);
  }
  if (byDomain.get("one-piece")?.size !== 3 || byDomain.get("lorcana")?.size !== 2)
    errors.push("rows: product-domain membership mismatch");
  for (const row of receipt.rows) {
    if (row.mapping.membership !== "member") errors.push(`rows.${row.unitKey}: cache membership`);
    if (
      row.mapping.coordinate !== null &&
      row.mapping.coordinate !== row.setId &&
      row.mapping.coordinate !== row.setName
    )
      errors.push(`rows.${row.unitKey}: coordinate mismatch`);
    if (
      Date.parse(row.cacheFetchedAt) > Date.parse(row.cacheExpiresAt) ||
      Date.parse(row.cacheExpiresAt) > Date.parse(row.cacheStaleUntil)
    )
      errors.push(`rows.${row.unitKey}: cache interval`);
    if (row.mapping.setId !== row.setId || row.mapping.setName !== row.setName)
      errors.push(`rows.${row.unitKey}: mapping coordinate mismatch`);
    const sample = receipt.preview?.samples.find((candidate) => candidate.scopeRecordId === row.scopeRecordId);
    if (
      !sample ||
      !sample.mappingVersions.some(
        (candidate) => candidate.mappingId === row.mapping.mappingId && candidate.version === row.mapping.version,
      )
    )
      errors.push(`rows.${row.unitKey}: mapping absent from preview sample`);
    if (
      !sample ||
      !sample.profileVersions.some(
        (candidate) =>
          candidate.unitKey === row.unitKey &&
          candidate.profileKey === row.profileKey &&
          candidate.profileVersion === row.profileVersion,
      )
    )
      errors.push(`rows.${row.unitKey}: profile absent from preview sample`);
  }
  const expectedOutcome = receipt.reasons.length === 0 ? "complete" : "governed-unknown";
  if (receipt.outcome !== expectedOutcome) errors.push("outcome: not derived from reasons");
  if (receipt.requests.previewPosts > 1) errors.push("requests.previewPosts: more than one");
  if (receipt.requests.forbidden !== receipt.forbiddenCalls.length) errors.push("requests.forbidden: tally mismatch");
  if (
    receipt.preview &&
    receipt.rows.some(
      (row) =>
        row.previewFingerprint !== receipt.preview?.fingerprint ||
        row.resolvedAt !== receipt.preview?.resolvedAt ||
        row.previewRevision !== receipt.preview?.revision,
    )
  )
    errors.push("rows: preview join mismatch");
  return errors;
}
