import { z } from "zod";
import { countCaptureFields } from "./count-capture-plan";
import {
  classifyScrydexCacheCaptureRequest,
  scrydexCacheCaptureCoordinate,
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureUnits,
  type ScrydexCacheCapturePhase,
  type ScrydexCacheCaptureRequestClass,
} from "./scrydex-cache-capture";

// Hosted capture of one ordinary two-ID Scope Sync Batch preview over one One
// Piece and one Lorcana `set` Scope Record, joined to the five accepted Scrydex
// mappings and cache-only option rows it planned against: One Piece set, card
// and sealed, Lorcana set and card. The runner and the staging wrapper produce
// the evidence; this module owns the receipt grammar, its oracle and the
// request classifier. The outcome is derived from the evidence, so an unjoined,
// late, unbound or fenced capture is governed unknown and never becomes
// coordinate proof.

export const scrydexCoordinatePreviewSchemaVersion = "scrydex-coordinate-preview/v1" as const;
export const scrydexCoordinatePreviewJourneyScope = "scrydex-coordinate-preview" as const;
// A same-origin page the wrapper fulfills with a constant script-free body, so
// no Admin app code runs beside the capture reads.
export const scrydexCoordinatePreviewIsolationPath = "/__scrydex-coordinate-preview-isolation" as const;
// Every phase the journey records, in order: sign-in (the isolation document
// included), the readiness reads before the preview, the one preview, and the
// immediate pre-confirm reads that seal the receipt.
export const scrydexCoordinatePreviewPhases = ["sign-in", "readiness", "preview", "pre-confirm"] as const;
export const scrydexCoordinatePreviewMaxTally = 1000;
export const scrydexCoordinatePreviewMaxForbiddenCalls = 100;

// --- Request classifier ----------------------------------------------------------

export type ScrydexCoordinatePreviewRequestClass =
  | ScrydexCacheCaptureRequestClass
  | "isolation-document"
  | "preview-post"
  | "usage-read";
export type ScrydexCoordinatePreviewRequestVerdict = Readonly<{
  requestClass: ScrydexCoordinatePreviewRequestClass;
  allowed: boolean;
  reason: string;
}>;

const isolationDocumentUrl = `${scrydexCacheCaptureOrigin}${scrydexCoordinatePreviewIsolationPath}`;

const scrydexCoordinatePreviewPath = "/api/catalog/scope-sync-batches/preview";
const scrydexCoordinatePreviewUsagePath = "/api/catalog/source-observations/integration-control-plane/overview";

// The cache-capture fence plus three classes: the sign-in GET navigation to
// exactly the isolation document, the one capture-phase preview POST, and the
// one capture-phase usage-readiness GET. Anywhere else those paths are handled
// by the delegated fence and remain refused.
export function classifyScrydexCoordinatePreviewRequest(
  request: Readonly<{ method: string; url: string; phase: ScrydexCacheCapturePhase; navigation: boolean }>,
): ScrydexCoordinatePreviewRequestVerdict {
  if (
    request.phase === "sign-in" &&
    request.navigation &&
    request.method.toUpperCase() === "GET" &&
    request.url === isolationDocumentUrl
  ) {
    return { requestClass: "isolation-document", allowed: true, reason: "isolation-document" };
  }
  if (request.phase === "capture" && !request.navigation) {
    try {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      if (
        url.origin === scrydexCacheCaptureOrigin &&
        method === "POST" &&
        url.pathname === scrydexCoordinatePreviewPath &&
        url.search === ""
      ) {
        return { requestClass: "preview-post", allowed: true, reason: "preview-post" };
      }
      if (
        url.origin === scrydexCacheCaptureOrigin &&
        method === "GET" &&
        url.pathname === scrydexCoordinatePreviewUsagePath &&
        url.search === "?audience=daily"
      ) {
        return { requestClass: "usage-read", allowed: true, reason: "usage-read" };
      }
    } catch {
      // Delegate malformed URLs to the cache-capture fence for its refusal.
    }
  }
  return classifyScrydexCacheCaptureRequest(request);
}

// --- Receipt ---------------------------------------------------------------------

const { id, instant, hash, sha } = countCaptureFields;
const githubId = z.string().regex(/^[1-9]\d{0,19}$/);
const reasonCode = z.string().regex(/^[a-z0-9-]{1,64}(?::[A-Za-z0-9._:-]{1,200})?$/);
const sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const tally = z.number().int().min(0).max(scrydexCoordinatePreviewMaxTally);
const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/);

const generationSchema = z
  .object({
    runId: githubId,
    runAttempt: z.number().int().min(1).max(100),
    jobId: githubId,
    jobCompletedAt: instant,
    deployedHead: sha,
    imageDigest: sha256Digest,
  })
  .strict();

// The joined fields of the Scope Sync Batch preview (batch.ts), blockers verbatim.
const previewSchema = z
  .object({
    planFingerprint: hash,
    status: boundedText(64),
    confirmAllowed: z.boolean(),
    resolvedAt: instant,
    selection: z.object({ mode: z.literal("ids"), scopeRecordIds: z.array(id).max(2) }).strict(),
    samples: z
      .array(
        z
          .object({
            scopeRecordId: id,
            mappingVersions: z
              .array(z.object({ mappingId: id, version: boundedText(64), reviewStatus: boundedText(64) }).strict())
              .max(50),
            profileVersions: z
              .array(z.object({ providerKey: id, unitKey: id, profileKey: id, profileVersion: id }).strict())
              .max(50),
          })
          .strict(),
      )
      .max(2),
    blockers: z
      .array(
        z
          .object({
            code: z.string().regex(/^[a-z0-9-]{1,64}$/),
            scopeRecordId: id.nullable(),
            providerKey: id.nullable(),
            message: boundedText(500),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

// One required unit: its accepted mapping with the Admin-recorded coordinates,
// the coordinate whose membership was read, and that cache-only option row.
const rowSchema = z
  .object({
    unitKey: id,
    scopeRecordId: id,
    planFingerprint: hash,
    profileKey: id,
    profileVersion: id,
    mapping: z
      .object({
        mappingId: id,
        version: instant,
        reviewStatus: z.enum(["accepted", "auto-accepted"]),
        setId: boundedText(300).nullable(),
        setName: boundedText(300).nullable(),
      })
      .strict(),
    coordinate: boundedText(300).nullable(),
    cache: z
      .object({
        status: z.enum(["fresh", "stale"]),
        cacheKey: sha256Digest,
        fetchedAt: instant,
        expiresAt: instant,
        staleUntil: instant,
      })
      .strict(),
    membership: z.enum(["member", "non-member"]),
  })
  .strict();

const receiptSchema = z
  .object({
    schemaVersion: z.literal(scrydexCoordinatePreviewSchemaVersion),
    outcome: z.enum(["complete", "governed-unknown"]),
    reasons: z.array(reasonCode).max(100),
    runner: z
      .object({
        sha,
        runId: githubId,
        runAttempt: githubId,
        journeyScope: z.literal(scrydexCoordinatePreviewJourneyScope),
        origin: z.literal(new URL(scrydexCacheCaptureOrigin).host),
      })
      .strict(),
    deployment: z.object({ before: generationSchema.nullable(), after: generationSchema.nullable() }).strict(),
    startedAt: instant,
    finishedAt: instant,
    phases: z.array(z.enum(scrydexCoordinatePreviewPhases)).max(16),
    // Browser requests by fence class: `signIn` counts every allowed sign-in
    // phase request, the isolation document included; `forbidden` every refusal.
    requests: z
      .object({
        signIn: tally,
        profileReads: tally,
        scopeInventoryReads: tally,
        coverageReads: tally,
        cacheOptionReads: tally,
        previewPosts: tally,
        usageReads: tally,
        forbidden: tally,
      })
      .strict(),
    // The pre-existing Scrydex usage-readiness read: its count and admission.
    usageRead: z.object({ count: tally, allowed: z.boolean() }).strict(),
    // The first refusal codes, value-free; `requests.forbidden` keeps the total.
    forbiddenCalls: z.array(reasonCode).max(scrydexCoordinatePreviewMaxForbiddenCalls),
    preview: previewSchema.nullable(),
    rows: z.array(rowSchema).max(scrydexCacheCaptureUnits.length),
  })
  .strict();

export type ScrydexCoordinatePreviewReceipt = z.infer<typeof receiptSchema>;
export type ScrydexCoordinatePreviewEvidence = Omit<
  ScrydexCoordinatePreviewReceipt,
  "schemaVersion" | "outcome" | "reasons"
>;

// Value-free: shape issues name only their path and code. A receipt may carry
// reasons its evidence cannot show (the runner's credential, producer and
// deployment-stop reasons) but never omits a derived one, and it is `complete`
// only when it carries no reason at all.
export function validateScrydexCoordinatePreviewReceipt(value: unknown): readonly string[] {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.code}`);
  }
  const receipt = parsed.data;
  if (
    receipt.forbiddenCalls.length !== Math.min(receipt.requests.forbidden, scrydexCoordinatePreviewMaxForbiddenCalls)
  ) {
    return ["requests.forbidden: tally mismatch"];
  }
  const derived = deriveScrydexCoordinatePreviewReasons(receipt);
  const errors = derived
    .filter((reason) => !receipt.reasons.includes(reason))
    .map((reason) => `reasons: missing ${reason}`);
  const outcome = receipt.reasons.length === 0 && derived.length === 0 ? "complete" : "governed-unknown";
  if (receipt.outcome !== outcome) errors.push("outcome: not derived from evidence");
  return errors;
}

// Every reason the evidence alone shows, sorted. The runner merges these with
// its own credential, producer and deployment-stop reasons.
export function deriveScrydexCoordinatePreviewReasons(evidence: ScrydexCoordinatePreviewEvidence): string[] {
  const reasons = new Set<string>();
  const { runner, deployment, requests, preview, rows } = evidence;
  const { before, after } = deployment;
  if (!before || !after) reasons.add("deployment-unbound");
  else {
    if ([before, after].some((generation) => generation.deployedHead !== runner.sha)) {
      reasons.add("deployment-head-mismatch");
    }
    if (canonicalJson(before) !== canonicalJson(after)) reasons.add("deployment-generation-changed");
  }
  if (requests.forbidden > 0) reasons.add("forbidden-call");
  if (requests.previewPosts !== 1) reasons.add("preview-post-count");
  if (requests.usageReads !== 1) reasons.add("usage-read-count");
  if (evidence.phases.join(",") !== scrydexCoordinatePreviewPhases.join(",")) reasons.add("phases-incomplete");

  // The unit set is compared only once there are exactly five rows.
  if (rows.length !== scrydexCacheCaptureUnits.length) reasons.add("rows-not-exactly-five");
  else {
    const rowUnits = rows.map((row) => row.unitKey);
    if (new Set(rowUnits).size !== rowUnits.length) reasons.add("rows-duplicate");
    if (scrydexCacheCaptureUnits.some(({ unitKey }) => !rowUnits.includes(unitKey))) {
      reasons.add("rows-unit-membership");
    }
  }

  const startedAt = Date.parse(evidence.startedAt);
  const finishedAt = Date.parse(evidence.finishedAt);
  // The preview's time is compared only within a well-ordered run.
  const wellOrdered = startedAt <= finishedAt;
  if (!wellOrdered) reasons.add("finished-before-started");
  for (const { unitKey, scopeRecordId, mapping, coordinate, cache, membership } of rows) {
    const plannerCoordinate = scrydexCacheCaptureCoordinate({ ...mapping, unitKey }, scopeRecordId);
    if (plannerCoordinate === null) reasons.add(`coordinate-missing:${unitKey}`);
    if (coordinate !== plannerCoordinate) reasons.add(`coordinate-mismatch:${unitKey}`);
    if (membership !== "member") reasons.add(`cache-membership:${unitKey}`);
    if (Date.parse(cache.expiresAt) < Date.parse(cache.fetchedAt)) reasons.add(`cache-interval:${unitKey}`);
    if (Date.parse(cache.staleUntil) <= finishedAt) reasons.add(`cache-stale:${unitKey}`);
  }

  if (!preview) {
    reasons.add("preview-missing");
    return [...reasons].sort();
  }
  const resolvedAt = Date.parse(preview.resolvedAt);
  if (wellOrdered && (resolvedAt < startedAt || resolvedAt > finishedAt)) reasons.add("preview-time-out-of-range");
  if (preview.status !== "ready" && preview.status !== "blocked") reasons.add("preview-not-confirmable");
  const selected: readonly string[] = preview.selection.scopeRecordIds;
  if (
    preview.blockers.some(
      (blocker) =>
        blocker.code === "scope-planning-blocked" &&
        blocker.providerKey === "scrydex" &&
        (blocker.scopeRecordId === null || selected.includes(blocker.scopeRecordId)),
    )
  ) {
    reasons.add("scrydex-scope-planning-blocked");
  }
  for (const row of rows) {
    const sample = preview.samples.find((candidate) => candidate.scopeRecordId === row.scopeRecordId);
    const { mappingId, version, reviewStatus } = row.mapping;
    const mappingVersion = canonicalJson({ mappingId, version, reviewStatus });
    const profileVersion = canonicalJson({
      providerKey: "scrydex",
      unitKey: row.unitKey,
      profileKey: row.profileKey,
      profileVersion: row.profileVersion,
    });
    if (row.planFingerprint !== preview.planFingerprint) reasons.add("preview-join-mismatch");
    if (!sample?.mappingVersions.some((entry) => canonicalJson(entry) === mappingVersion)) {
      reasons.add(`mapping-sample-missing:${row.unitKey}`);
    }
    if (!sample?.profileVersions.some((entry) => canonicalJson(entry) === profileVersion)) {
      reasons.add(`profile-sample-missing:${row.unitKey}`);
    }
    if (Date.parse(row.cache.fetchedAt) > resolvedAt) reasons.add(`cache-fetched-after-preview:${row.unitKey}`);
  }
  return [...reasons].sort();
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
