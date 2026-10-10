import { classifyProviderProductionClass } from "../../completion-report/read-model/query";
import { listProviderScopeDiscoveryTargets } from "../../provider-scope-discovery/api/discovery-targets";
import { classifyProviderScopeDiscoveryTarget } from "../../provider-scope-discovery/api/scope-observation-matcher";
import {
  normalizeCatalogScopeProductDomain,
  type CatalogScopeProductDomain,
} from "../../scope-registry/domain/contract";
import { parseCatalogIntegrationUnitKey } from "../../source-observations/api/integration-unit";
import type { CatalogIntegrationUnitKey } from "../../source-observations/api/governance/integration-unit";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../../source-observations/api/providers/profile-types";
import type {
  ScopeSyncBatchBlocker,
  ScopeSyncBatchBudget,
  ScopeSyncBatchPreview,
  ScopeSyncBatchSelection,
} from "./batch";

// Support-safe receipt for the staging Scope Sync Batch preview probe.
// The staging UAT workflow captures six unconfirmed previews through visible
// Admin controls; this module owns the receipt grammar so the capture, the
// workflow's pre-upload validation and the tests share one definition. It never
// holds credentials, raw provider payloads or URLs, and it derives capture
// status from the rows instead of trusting a hand-set flag.

export const scopeSyncBatchPreviewProbeSchemaVersion = "scope-sync-batch-preview-probe/v1";
export const scopeSyncBatchPreviewProbeJourneyScope = "scope-sync-batch-preview-probe";
export const scopeSyncBatchPreviewProbeArtifactPath = "artifacts/catalog-scale-probe/preview.json";
export const scopeSyncBatchPreviewProbeCredentialNames = [
  "CATALOG_ADMIN_E2E_EMAIL",
  "CATALOG_ADMIN_E2E_PASSWORD",
] as const;
// listUnmappedScopeInboxRows default limit (scope-coverage-queries.ts) and the
// matching-scope planner LIMIT (planner.ts): reaching either is a cap, not a total.
export const scopeSyncBatchPreviewProbeInboxRowBound = 1000;
export const scopeSyncBatchPreviewProbeMatchingScopeBound = 5000;
const maxRecordedBlockers = 50;
const maxSupportSafeTextLength = 500;
const maxReceiptBytes = 2_000_000;

export type ScopeSyncBatchPreviewProbeRowKey =
  | "magic"
  | "pokemon-en"
  | "pokemon-ja"
  | "yugioh"
  | "one-piece"
  | "lorcana";

export type ScopeSyncBatchPreviewProbeRowDefinition = Readonly<{
  rowKey: ScopeSyncBatchPreviewProbeRowKey;
  productDomain: CatalogScopeProductDomain;
  scopeKind: "expansion" | "set";
  languageCode: string | null;
}>;

// Pokemon is previewed per language at the expansion grain; every other domain
// at the set grain with language unset.
export const scopeSyncBatchPreviewProbeRows: readonly ScopeSyncBatchPreviewProbeRowDefinition[] = [
  { rowKey: "magic", productDomain: "magic", scopeKind: "set", languageCode: null },
  { rowKey: "pokemon-en", productDomain: "pokemon", scopeKind: "expansion", languageCode: "en" },
  { rowKey: "pokemon-ja", productDomain: "pokemon", scopeKind: "expansion", languageCode: "ja" },
  { rowKey: "yugioh", productDomain: "yugioh", scopeKind: "set", languageCode: null },
  { rowKey: "one-piece", productDomain: "one-piece", scopeKind: "set", languageCode: null },
  { rowKey: "lorcana", productDomain: "lorcana", scopeKind: "set", languageCode: null },
];

// --- Gates -----------------------------------------------------------------

export type ScopeSyncBatchPreviewProbeGate = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

export function scopeSyncBatchPreviewProbeCredentialGate(
  values: Readonly<{ email?: string | null; password?: string | null }>,
): ScopeSyncBatchPreviewProbeGate {
  const missing = [
    values.email?.trim() ? null : scopeSyncBatchPreviewProbeCredentialNames[0],
    values.password?.trim() ? null : scopeSyncBatchPreviewProbeCredentialNames[1],
  ].filter((name): name is (typeof scopeSyncBatchPreviewProbeCredentialNames)[number] => name !== null);
  return missing.length === 0 ? { ok: true } : { ok: false, reason: `admin-credential-missing:${missing.join(",")}` };
}

export function scopeSyncBatchPreviewProbeOriginGate(origin: string): ScopeSyncBatchPreviewProbeGate {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, reason: "origin-unparseable" };
  }
  if (url.protocol !== "https:" || !/(^|\.)staging\.chasesets\.com$/.test(url.hostname) || url.pathname !== "/") {
    return { ok: false, reason: "origin-not-staging-admin" };
  }
  return { ok: true };
}

export type ScopeSyncBatchPreviewProbeRequest = Readonly<{ method: string; url: string; formIntent: string | null }>;

// The only state-changing requests the probe may send after sign-in: a batch
// preview and a provider discovery run-now. Confirm, retry-unit, cancel,
// resume, pause and every other POST are refused, whatever the UI renders.
export function classifyScopeSyncBatchPreviewProbeRequest(
  request: ScopeSyncBatchPreviewProbeRequest,
): Readonly<{ allowed: boolean; reason: string }> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { allowed: true, reason: "read" };
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname.replace(/\.data$/, "").replace(/\/$/, "");
  } catch {
    return { allowed: false, reason: "unparseable-url" };
  }
  // Admin sign-in/session plumbing lives under /access and never reaches Catalog.
  if (pathname.startsWith("/access/")) return { allowed: true, reason: "access-session" };
  if (pathname === "/catalog/scopes/sync-batches" && request.formIntent === "preview") {
    return { allowed: true, reason: "scope-sync-batch-preview" };
  }
  if (/^\/catalog\/providers\/[^/]+$/.test(pathname) && request.formIntent === "run-provider-refresh") {
    return { allowed: true, reason: "provider-discovery-run-now" };
  }
  return { allowed: false, reason: `forbidden-intent:${request.formIntent ?? "none"}` };
}

export function scopeSyncBatchPreviewProbeFormIntent(body: string | null, contentType: string | null): string | null {
  if (!body) return null;
  if ((contentType ?? "").toLowerCase().includes("multipart/form-data")) {
    const match = body.match(/name="_?intent"\r?\n\r?\n([^\r\n]*)/);
    return match?.[1]?.trim() || null;
  }
  const params = new URLSearchParams(body);
  return params.get("intent")?.trim() || params.get("_intent")?.trim() || null;
}

// --- Roster ----------------------------------------------------------------

export type ScopeSyncBatchPreviewProbeProfileInput = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  ingestionUnitKey: string;
  lifecycle: string;
  active: boolean;
  profile: Readonly<{
    capabilities: readonly string[];
    optionQueries: readonly Readonly<{
      queryKind: string;
      scope: string;
      parentScope: string | null;
      parentValue?: Readonly<{ required: boolean }> | null;
    }>[];
  }>;
}>;

export type ScopeSyncBatchPreviewProbeRosterSource = "deployed-admin-profiles" | "registry-at-admitted-sha";

export type ScopeSyncBatchPreviewProbeRosterUnit = Readonly<{
  providerKey: string;
  unitKey: string;
  productDomain: CatalogScopeProductDomain;
  disposition: "discovery-target" | "unsupported";
  reason: string | null;
  discoveryLanguages: readonly string[];
}>;

// A deployed inventory unit whose governing profile could not be read. It stays
// an explicit unknown that keeps its row incomplete, never a silent omission.
export type ScopeSyncBatchPreviewProbeUnresolvedUnit = Readonly<{
  providerKey: string;
  unitKey: string;
  productDomain: CatalogScopeProductDomain;
  reason: string;
}>;

export type ScopeSyncBatchPreviewProbeRoster = Readonly<{
  source: ScopeSyncBatchPreviewProbeRosterSource;
  units: readonly ScopeSyncBatchPreviewProbeRosterUnit[];
  unresolvedUnits: readonly ScopeSyncBatchPreviewProbeUnresolvedUnit[];
  discoveryProviders: readonly string[];
}>;

// Partition every active production-capable unit of the five domains into
// discovery targets and unsupported units, using the same discovery-target
// derivation the run-now runtime executes (runtime.ts groupTargetsByProvider).
export function deriveScopeSyncBatchPreviewProbeRoster(
  profiles: readonly ScopeSyncBatchPreviewProbeProfileInput[],
  source: ScopeSyncBatchPreviewProbeRosterSource,
  unresolvedUnits: readonly ScopeSyncBatchPreviewProbeUnresolvedUnit[] = [],
): ScopeSyncBatchPreviewProbeRoster {
  const versions = profiles.map(
    (profile) =>
      ({
        providerKey: profile.providerKey,
        profileKey: profile.profileKey,
        profileVersion: profile.profileVersion,
        lifecycle: profile.lifecycle,
        active: profile.active,
        profile: profile.profile,
        ingestionUnitIdentity: { unitKey: profile.ingestionUnitKey },
      }) as unknown as CatalogProviderIntegrationProfileVersionRecord,
  );
  const targets = listProviderScopeDiscoveryTargets(versions, classifyProviderScopeDiscoveryTarget);
  const units = new Map<string, ScopeSyncBatchPreviewProbeRosterUnit>();
  for (const profile of profiles) {
    if (classifyProviderProductionClass({ lifecycle: profile.lifecycle, active: profile.active }) !== "production") {
      continue;
    }
    const productDomain = unitProductDomain(profile.ingestionUnitKey);
    if (!productDomain || units.has(profile.ingestionUnitKey)) continue;
    const unitTargets = targets.filter((target) => target.ingestionUnitKey === profile.ingestionUnitKey);
    units.set(profile.ingestionUnitKey, {
      providerKey: profile.providerKey.trim().toLowerCase(),
      unitKey: profile.ingestionUnitKey,
      productDomain,
      disposition: unitTargets.length > 0 ? "discovery-target" : "unsupported",
      reason:
        unitTargets.length > 0
          ? null
          : profile.profile.capabilities.includes("provider-option-query")
            ? "no-scope-discovery-option-query"
            : "no-provider-option-query-capability",
      discoveryLanguages: [...new Set(unitTargets.map((target) => target.languageCode))].sort(),
    });
  }
  const sortedUnits = [...units.values()].sort((left, right) => left.unitKey.localeCompare(right.unitKey));
  return {
    source,
    units: sortedUnits,
    unresolvedUnits: [...unresolvedUnits].sort((left, right) => left.unitKey.localeCompare(right.unitKey)),
    discoveryProviders: [
      ...new Set(sortedUnits.filter((unit) => unit.disposition === "discovery-target").map((unit) => unit.providerKey)),
    ].sort(),
  };
}

// --- Deployed roster -------------------------------------------------------

export type ScopeSyncBatchPreviewProbeInventoryUnit = Readonly<{
  providerKey: string;
  unitKey: string;
  productDomain: CatalogScopeProductDomain;
  profileVersion: string | null;
}>;

export type ScopeSyncBatchPreviewProbeDetailCoordinates = Readonly<{
  providerKey: string;
  unitKey: string;
  profileVersion: string | null;
}>;

type ProviderDetailRead =
  | Readonly<{
      status: "resolved";
      profile: ScopeSyncBatchPreviewProbeProfileInput;
      activeProfileVersion: string | null;
    }>
  | Readonly<{ status: "unresolved"; reason: string; activeProfileVersion: string | null }>;

const probeProductDomains = new Set<string>(scopeSyncBatchPreviewProbeRows.map((row) => row.productDomain));

// The daily Integrations read model (providerScope.providers[].units) lists
// every provider unit with the profile version it currently points at. Returns
// null when the loader data carries no provider scope.
export function readScopeSyncBatchPreviewProbeInventory(
  loaderData: unknown,
): readonly ScopeSyncBatchPreviewProbeInventoryUnit[] | null {
  const readModel = findRecord(
    loaderData,
    (node) =>
      isRecord(node.providerScope) && Array.isArray(node.providerScope.providers) && isRecord(node.routeContext),
  );
  if (!readModel || !isRecord(readModel.providerScope)) return null;
  const units = new Map<string, ScopeSyncBatchPreviewProbeInventoryUnit>();
  for (const provider of arrayOf(readModel.providerScope.providers)) {
    if (!isRecord(provider) || typeof provider.providerKey !== "string") continue;
    for (const unit of arrayOf(provider.units)) {
      if (!isRecord(unit) || typeof unit.unitKey !== "string") continue;
      const productDomain = unitProductDomain(unit.unitKey);
      if (!productDomain || !probeProductDomains.has(productDomain) || units.has(unit.unitKey)) continue;
      const pointer = isRecord(unit.activeProfile) ? unit.activeProfile : null;
      units.set(unit.unitKey, {
        providerKey: provider.providerKey,
        unitKey: unit.unitKey,
        productDomain,
        profileVersion: typeof pointer?.profileVersion === "string" ? pointer.profileVersion : null,
      });
    }
  }
  return [...units.values()];
}

// Reads one unit's governing profile from the visible provider-detail route
// (profileAuthoring.selectedProfile and its provider-options workspace), opened
// with the unit's unitKey and profileVersion coordinates.
export function readScopeSyncBatchPreviewProbeProviderDetail(
  loaderData: unknown,
  coordinates: ScopeSyncBatchPreviewProbeDetailCoordinates,
): ProviderDetailRead {
  const readModel = findRecord(loaderData, (node) => isRecord(node.profileAuthoring) && isRecord(node.routeContext));
  const authoring = isRecord(readModel?.profileAuthoring) ? readModel.profileAuthoring : null;
  const active = isRecord(authoring?.activeProfile) ? authoring.activeProfile : null;
  const activeProfileVersion = typeof active?.profileVersion === "string" ? active.profileVersion : null;
  const unresolved = (reason: string): ProviderDetailRead => ({ status: "unresolved", reason, activeProfileVersion });
  if (!readModel || !authoring) return unresolved("provider-detail-unreadable");
  if (!isRecord(readModel.routeContext) || readModel.routeContext.unitKey !== coordinates.unitKey) {
    return unresolved("provider-detail-unit-mismatch");
  }
  // Without a requested version the route falls back to any profile of the
  // provider, which need not belong to this unit.
  if (!coordinates.profileVersion) return unresolved("profile-pointer-missing");
  if (authoring.status !== "ready") return unresolved(`provider-detail-profile-${String(authoring.status)}`);
  const selected = isRecord(authoring.selectedProfile) ? authoring.selectedProfile : null;
  if (
    !selected ||
    selected.providerKey !== coordinates.providerKey ||
    selected.profileVersion !== coordinates.profileVersion ||
    typeof selected.profileKey !== "string" ||
    typeof selected.lifecycle !== "string" ||
    typeof selected.active !== "boolean"
  ) {
    return unresolved("provider-detail-profile-mismatch");
  }
  // The selected profile carries no unit key, and the route matches a
  // single-unit provider's profile to any of its unit keys. Only the same read
  // model's provider scope, pointing this unit at this version, proves the
  // profile is the unit's own.
  const scopedProvider = arrayOf(isRecord(readModel.providerScope) ? readModel.providerScope.providers : null).find(
    (provider) => isRecord(provider) && provider.providerKey === coordinates.providerKey,
  );
  const scopedUnit = arrayOf(isRecord(scopedProvider) ? scopedProvider.units : null).find(
    (unit) => isRecord(unit) && unit.unitKey === coordinates.unitKey,
  );
  const pointer = isRecord(scopedUnit) && isRecord(scopedUnit.activeProfile) ? scopedUnit.activeProfile : null;
  if (pointer?.profileVersion !== selected.profileVersion) return unresolved("provider-detail-profile-not-on-unit");
  if (!Array.isArray(selected.capabilities) || !selected.capabilities.every((value) => typeof value === "string")) {
    return unresolved("provider-detail-capabilities-unreadable");
  }
  const workspace = arrayOf(authoring.sectionWorkspaces).find(
    (candidate) => isRecord(candidate) && candidate.sectionKey === "provider-options",
  );
  if (!isRecord(workspace) || !Array.isArray(workspace.optionQueries)) {
    return unresolved("provider-options-workspace-missing");
  }
  const optionQueries: ScopeSyncBatchPreviewProbeProfileInput["profile"]["optionQueries"][number][] = [];
  for (const query of workspace.optionQueries) {
    if (
      !isRecord(query) ||
      typeof query.queryKind !== "string" ||
      typeof query.scope !== "string" ||
      !(query.parentScope === null || typeof query.parentScope === "string") ||
      typeof query.parentRequired !== "boolean"
    ) {
      return unresolved("provider-option-query-unreadable");
    }
    optionQueries.push({
      queryKind: query.queryKind,
      scope: query.scope,
      parentScope: query.parentScope,
      parentValue: { required: query.parentRequired },
    });
  }
  return {
    status: "resolved",
    activeProfileVersion,
    profile: {
      providerKey: coordinates.providerKey,
      profileKey: selected.profileKey,
      profileVersion: selected.profileVersion,
      ingestionUnitKey: coordinates.unitKey,
      lifecycle: selected.lifecycle,
      active: selected.active,
      profile: { capabilities: selected.capabilities as string[], optionQueries },
    },
  };
}

// Reconciles every five-domain unit of the deployed inventory against its
// provider detail. A unit whose pointer is not production-capable is re-read at
// the unit's active profile; one that cannot be read stays unresolved. Returns
// null when the inventory is unreadable or yields no unit at all.
export async function readScopeSyncBatchPreviewProbeDeployedRoster(
  dailyLoaderData: unknown,
  readProviderDetail: (coordinates: ScopeSyncBatchPreviewProbeDetailCoordinates) => Promise<unknown>,
): Promise<ScopeSyncBatchPreviewProbeRoster | null> {
  const inventory = readScopeSyncBatchPreviewProbeInventory(dailyLoaderData);
  if (!inventory || inventory.length === 0) return null;
  const profiles: ScopeSyncBatchPreviewProbeProfileInput[] = [];
  const unresolved: ScopeSyncBatchPreviewProbeUnresolvedUnit[] = [];
  const read = async (unit: ScopeSyncBatchPreviewProbeInventoryUnit, profileVersion: string | null) => {
    const coordinates = { providerKey: unit.providerKey, unitKey: unit.unitKey, profileVersion };
    return readScopeSyncBatchPreviewProbeProviderDetail(await readProviderDetail(coordinates), coordinates);
  };
  for (const unit of inventory) {
    let detail = await read(unit, unit.profileVersion);
    const readVersion = detail.status === "resolved" ? detail.profile.profileVersion : null;
    if (
      (detail.status === "unresolved" || !isProductionProfile(detail.profile)) &&
      detail.activeProfileVersion &&
      detail.activeProfileVersion !== readVersion
    ) {
      detail = await read(unit, detail.activeProfileVersion);
    }
    if (detail.status === "unresolved") {
      unresolved.push({
        providerKey: unit.providerKey,
        unitKey: unit.unitKey,
        productDomain: unit.productDomain,
        reason: detail.reason,
      });
    } else if (isProductionProfile(detail.profile)) {
      profiles.push(detail.profile);
    }
  }
  if (profiles.length === 0 && unresolved.length === 0) return null;
  return deriveScopeSyncBatchPreviewProbeRoster(profiles, "deployed-admin-profiles", unresolved);
}

function isProductionProfile(profile: ScopeSyncBatchPreviewProbeProfileInput): boolean {
  return classifyProviderProductionClass({ lifecycle: profile.lifecycle, active: profile.active }) === "production";
}

function unitProductDomain(unitKey: string): CatalogScopeProductDomain | null {
  try {
    return normalizeCatalogScopeProductDomain(
      parseCatalogIntegrationUnitKey(unitKey as CatalogIntegrationUnitKey).productDomain,
    );
  } catch {
    return null;
  }
}

// --- Observations ----------------------------------------------------------

export type ScopeSyncBatchPreviewProbeScheduleState = Readonly<{
  lastRunCompletedAt: string | null;
  lastRunStatus: "succeeded" | "failed" | "skipped-no-targets" | null;
  lastRunError: string | null;
}>;

export type ScopeSyncBatchPreviewProbeRefreshObservation = Readonly<{
  providerKey: string;
  clickedAt: string | null;
  before: ScopeSyncBatchPreviewProbeScheduleState | null;
  after: ScopeSyncBatchPreviewProbeScheduleState | null;
}>;

export type ScopeSyncBatchPreviewProbeRefreshResult = Readonly<{
  providerKey: string;
  status: "refreshed" | "failed" | "skipped-no-targets" | "unknown";
  reason: string | null;
  clickedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunStatus: string | null;
}>;

// Run-now swallows its own errors (provider-detail-action.ts), so the redirect
// proves nothing: the provider counts as refreshed only when the schedule's
// lastRunCompletedAt moved past both the prior value and the click.
export function classifyScopeSyncBatchPreviewProbeRefresh(
  observation: ScopeSyncBatchPreviewProbeRefreshObservation,
  clockSkewToleranceMs: number,
): ScopeSyncBatchPreviewProbeRefreshResult {
  const base = {
    providerKey: observation.providerKey,
    clickedAt: observation.clickedAt,
    lastRunCompletedAt: observation.after?.lastRunCompletedAt ?? null,
    lastRunStatus: observation.after?.lastRunStatus ?? null,
  };
  if (!observation.clickedAt) return { ...base, status: "unknown", reason: "run-now-not-clicked" };
  if (!observation.after) return { ...base, status: "unknown", reason: "schedule-row-unreadable" };
  const after = Date.parse(observation.after.lastRunCompletedAt ?? "");
  const before = Date.parse(observation.before?.lastRunCompletedAt ?? "");
  const clicked = Date.parse(observation.clickedAt);
  if (
    !Number.isFinite(after) ||
    (Number.isFinite(before) && after <= before) ||
    after < clicked - clockSkewToleranceMs
  ) {
    return { ...base, status: "unknown", reason: "last-run-not-after-click" };
  }
  switch (observation.after.lastRunStatus) {
    case "succeeded":
      return { ...base, status: "refreshed", reason: null };
    case "skipped-no-targets":
      return { ...base, status: "skipped-no-targets", reason: "provider-had-no-discovery-targets" };
    case "failed":
      return {
        ...base,
        status: "failed",
        reason: supportSafeText(observation.after.lastRunError ?? "refresh-failed-without-message"),
      };
    default:
      return { ...base, status: "unknown", reason: "last-run-status-missing" };
  }
}

export type ScopeSyncBatchPreviewProbeInboxObservation = Readonly<{
  generatedAt: string;
  counts: Readonly<{ totalGroups: number; totalCandidates: number; highConfidenceCandidates: number }>;
}>;

export type ScopeSyncBatchPreviewProbeInboxResult = Readonly<{
  status: "read" | "unknown";
  reason: string | null;
  scope: "domain-wide-proposed-mappings";
  languageSpecific: false;
  rowBound: number;
  completeness: "within-bound" | "capped" | "unknown";
  generatedAt: string | null;
  groupsRead: number | null;
  candidatesRead: number | null;
  highConfidenceCandidatesRead: number | null;
}>;

export function summarizeScopeSyncBatchPreviewProbeInbox(
  observation: ScopeSyncBatchPreviewProbeInboxObservation | null,
  unreadReason = "inbox-read-model-unreadable",
): ScopeSyncBatchPreviewProbeInboxResult {
  const base = {
    scope: "domain-wide-proposed-mappings" as const,
    languageSpecific: false as const,
    rowBound: scopeSyncBatchPreviewProbeInboxRowBound,
  };
  if (!observation || !isCount(observation.counts?.totalCandidates) || !isCount(observation.counts?.totalGroups)) {
    return {
      ...base,
      status: "unknown",
      reason: unreadReason,
      completeness: "unknown",
      generatedAt: null,
      groupsRead: null,
      candidatesRead: null,
      highConfidenceCandidatesRead: null,
    };
  }
  const capped = observation.counts.totalCandidates >= scopeSyncBatchPreviewProbeInboxRowBound;
  return {
    ...base,
    status: "read",
    reason: capped ? `inbox-capped-at-${scopeSyncBatchPreviewProbeInboxRowBound}-proposals` : null,
    completeness: capped ? "capped" : "within-bound",
    generatedAt: observation.generatedAt,
    groupsRead: observation.counts.totalGroups,
    candidatesRead: observation.counts.totalCandidates,
    highConfidenceCandidatesRead: isCount(observation.counts.highConfidenceCandidates)
      ? observation.counts.highConfidenceCandidates
      : null,
  };
}

export type ScopeSyncBatchPreviewProbePreviewObservation = Readonly<{
  submitted: Readonly<{ productDomain: string; scopeKind: string; languageCode: string | null }>;
  formBudget: Readonly<Record<string, string>>;
  response: ScopeSyncBatchPreview | null;
  error: string | null;
  renderedPlanFingerprint: string | null;
}>;

export type ScopeSyncBatchPreviewProbePreviewResult = Readonly<{
  status: "ready" | "blocked" | "empty" | "refused" | "stale" | "unknown";
  reason: string | null;
  submitted: ScopeSyncBatchPreviewProbePreviewObservation["submitted"] | null;
  formBudget: Readonly<Record<string, string>> | null;
  effectiveBudget: ScopeSyncBatchBudget | null;
  selection: ScopeSyncBatchSelection | null;
  confirmAllowed: boolean | null;
  planFingerprint: string | null;
  resolvedAt: string | null;
  eligibleScopeRecords: Readonly<{
    count: number | null;
    completeness: "complete" | "capped" | "unknown";
    zeroReason: string | null;
  }>;
  readyScopes: number | null;
  blockedScopes: number | null;
  participatingProviderUnits: number | null;
  providerUnitTotals: Readonly<Record<string, number>> | null;
  providerRequestEstimates: Readonly<Record<string, number | null>> | null;
  scrydex: Readonly<{
    participating: boolean | null;
    requestEstimate: number | null;
    creditLimit: number | null;
    refusal: string | null;
  }>;
  blockerCounts: Readonly<Record<string, number>> | null;
  blockers: readonly Readonly<{ code: string; providerKey: string | null; message: string }>[];
  blockersRecorded: number;
  wallClock: Readonly<{ estimate: "unknown"; rate: null; reason: string }>;
}>;

const wallClockUnknown = {
  estimate: "unknown",
  rate: null,
  reason: "no measured provider throughput; concurrency and request budgets are limits, not rates",
} as const;

export function summarizeScopeSyncBatchPreviewProbePreview(
  observation: ScopeSyncBatchPreviewProbePreviewObservation | null,
  unreadReason = "preview-not-captured",
): ScopeSyncBatchPreviewProbePreviewResult {
  const empty: ScopeSyncBatchPreviewProbePreviewResult = {
    status: "unknown",
    reason: unreadReason,
    submitted: observation?.submitted ?? null,
    formBudget: observation?.formBudget ?? null,
    effectiveBudget: null,
    selection: null,
    confirmAllowed: null,
    planFingerprint: null,
    resolvedAt: null,
    eligibleScopeRecords: { count: null, completeness: "unknown", zeroReason: null },
    readyScopes: null,
    blockedScopes: null,
    participatingProviderUnits: null,
    providerUnitTotals: null,
    providerRequestEstimates: null,
    scrydex: { participating: null, requestEstimate: null, creditLimit: null, refusal: null },
    blockerCounts: null,
    blockers: [],
    blockersRecorded: 0,
    wallClock: wallClockUnknown,
  };
  if (!observation) return empty;
  if (!observation.response) {
    return observation.error
      ? { ...empty, status: "refused", reason: supportSafeText(observation.error) }
      : { ...empty, reason: "preview-response-unreadable" };
  }
  const preview = observation.response;
  if (preview.previewVersion !== "scope-sync-batch-preview-v1") {
    return { ...empty, reason: "preview-response-unrecognized" };
  }
  // A truncated or malformed response is not a capture: its absent metrics stay
  // explicit unknowns instead of being omitted, zero-filled or read as
  // non-participation.
  const missing = missingPreviewFields(preview);
  if (missing.length > 0) return { ...empty, reason: `preview-response-missing:${missing.join(",")}` };
  const blockers = preview.blockers;
  const blockerCounts: Record<string, number> = {};
  for (const blocker of blockers) blockerCounts[blocker.code] = (blockerCounts[blocker.code] ?? 0) + 1;
  const scopeCount = preview.counts.scopes;
  const capped = scopeCount >= scopeSyncBatchPreviewProbeMatchingScopeBound;
  const emptyBlocker = blockers.find((blocker) => blocker.code === "empty-selection");
  const scrydexParticipating = Object.hasOwn(preview.providerRequestEstimates ?? {}, "scrydex");
  const scrydexRefusal = blockers.find(
    (blocker) => blocker.providerKey === "scrydex" && blocker.code.startsWith("credited-provider-"),
  );
  const stale =
    observation.renderedPlanFingerprint === null || observation.renderedPlanFingerprint !== preview.planFingerprint;
  return {
    ...empty,
    status: stale ? "stale" : preview.status,
    reason: stale ? "rendered-plan-fingerprint-mismatch" : null,
    effectiveBudget: preview.budget,
    selection: preview.selection,
    confirmAllowed: preview.confirmAllowed,
    planFingerprint: preview.planFingerprint,
    resolvedAt: preview.resolvedAt,
    eligibleScopeRecords: {
      count: scopeCount,
      completeness: capped ? "capped" : "complete",
      zeroReason:
        scopeCount === 0
          ? supportSafeText(emptyBlocker?.message ?? "no eligible active Scope Records; no blocker reported")
          : null,
    },
    readyScopes: preview.counts.readyScopes,
    blockedScopes: preview.counts.blockedScopes,
    participatingProviderUnits: preview.counts.providerUnits,
    providerUnitTotals: preview.providerUnitTotals,
    providerRequestEstimates: preview.providerRequestEstimates,
    scrydex: {
      participating: scrydexParticipating,
      requestEstimate: scrydexParticipating ? (preview.providerRequestEstimates.scrydex ?? null) : null,
      creditLimit: preview.budget.creditedProviderRequestLimits.scrydex ?? null,
      refusal: scrydexRefusal ? supportSafeText(scrydexRefusal.message) : null,
    },
    blockerCounts,
    blockers: blockers.slice(0, maxRecordedBlockers).map((blocker: ScopeSyncBatchBlocker) => ({
      code: blocker.code,
      providerKey: blocker.providerKey,
      message: supportSafeText(blocker.message),
    })),
    blockersRecorded: Math.min(blockers.length, maxRecordedBlockers),
  };
}

function missingPreviewFields(preview: Readonly<Record<string, unknown>>): string[] {
  const counts = isRecord(preview.counts) ? preview.counts : {};
  const checks: readonly (readonly [string, boolean])[] = [
    ["status", ["ready", "blocked", "empty"].includes(String(preview.status))],
    ["selection", isRecord(preview.selection) && ["matching-scope", "ids"].includes(String(preview.selection.mode))],
    ["budget", isBudget(preview.budget)],
    ["planFingerprint", typeof preview.planFingerprint === "string" && preview.planFingerprint.length > 0],
    ["resolvedAt", isTimestamp(preview.resolvedAt)],
    ["confirmAllowed", typeof preview.confirmAllowed === "boolean"],
    ["counts.scopes", isCount(counts.scopes)],
    ["counts.readyScopes", isCount(counts.readyScopes)],
    ["counts.blockedScopes", isCount(counts.blockedScopes)],
    ["counts.providerUnits", isCount(counts.providerUnits)],
    ["providerUnitTotals", isCountMap(preview.providerUnitTotals)],
    ["providerRequestEstimates", isCountMap(preview.providerRequestEstimates, true)],
    [
      "blockers",
      Array.isArray(preview.blockers) &&
        preview.blockers.every(
          (blocker) =>
            isRecord(blocker) &&
            typeof blocker.code === "string" &&
            typeof blocker.message === "string" &&
            (blocker.providerKey === null || typeof blocker.providerKey === "string"),
        ),
    ],
  ];
  return checks.filter(([, valid]) => !valid).map(([field]) => field);
}

function isBudget(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCount(value.maxScopesPerTurn) &&
    isCount(value.defaultProviderConcurrency) &&
    isCount(value.providerFailureThreshold) &&
    isCountMap(value.providerConcurrency) &&
    isCountMap(value.providerRequestLimits) &&
    isCountMap(value.creditedProviderRequestLimits)
  );
}

// --- Envelope --------------------------------------------------------------

export type ScopeSyncBatchPreviewProbeIdentity = Readonly<{
  sha: string;
  runId: string;
  runAttempt: string;
  retry: number;
  journeyScope: string;
  origin: string;
}>;

export type ScopeSyncBatchPreviewProbeRowCapture = Readonly<{
  rowKey: ScopeSyncBatchPreviewProbeRowKey;
  refresh: readonly ScopeSyncBatchPreviewProbeRefreshResult[];
  inbox: ScopeSyncBatchPreviewProbeInboxResult;
  preview: ScopeSyncBatchPreviewProbePreviewResult;
}>;

export type ScopeSyncBatchPreviewProbeRow = ScopeSyncBatchPreviewProbeRowDefinition &
  Readonly<{
    roster: Readonly<{
      source: ScopeSyncBatchPreviewProbeRosterSource | null;
      units: readonly ScopeSyncBatchPreviewProbeRosterUnit[];
      unresolvedUnits: readonly ScopeSyncBatchPreviewProbeUnresolvedUnit[];
      discoveryProviders: readonly string[];
      languageCoverage: Readonly<{ requested: string | null; discoveryLanguages: readonly string[]; gap: boolean }>;
    }>;
    refresh: readonly ScopeSyncBatchPreviewProbeRefreshResult[];
    inbox: ScopeSyncBatchPreviewProbeInboxResult;
    preview: ScopeSyncBatchPreviewProbePreviewResult;
    scopeRecordSet: Readonly<{ sharedWith: ScopeSyncBatchPreviewProbeRowKey | null; reason: string | null }>;
    gaps: readonly string[];
  }>;

export type ScopeSyncBatchPreviewProbeReceipt = Readonly<{
  schemaVersion: typeof scopeSyncBatchPreviewProbeSchemaVersion;
  identity: ScopeSyncBatchPreviewProbeIdentity;
  startedAt: string;
  finishedAt: string;
  captureStatus: "complete" | "incomplete";
  incompleteReasons: readonly string[];
  spendDisclosure: Readonly<{
    discoveryRunNowClicks: number;
    providersClicked: readonly string[];
    scrydexRefreshClicked: boolean;
    scrydexLiveCallCount: "unknown";
    note: string;
  }>;
  fence: Readonly<{ violations: readonly Readonly<{ method: string; path: string; reason: string }>[] }>;
  rows: readonly ScopeSyncBatchPreviewProbeRow[];
}>;

export function buildScopeSyncBatchPreviewProbeReceipt(
  input: Readonly<{
    identity: ScopeSyncBatchPreviewProbeIdentity;
    startedAt: string;
    finishedAt: string;
    roster: ScopeSyncBatchPreviewProbeRoster | null;
    captures: readonly ScopeSyncBatchPreviewProbeRowCapture[];
    providersClicked: readonly string[];
    fenceViolations: readonly Readonly<{ method: string; path: string; reason: string }>[];
    refusal: string | null;
  }>,
): ScopeSyncBatchPreviewProbeReceipt {
  const rows = scopeSyncBatchPreviewProbeRows.map((definition): ScopeSyncBatchPreviewProbeRow => {
    const capture = input.captures.find((candidate) => candidate.rowKey === definition.rowKey);
    const units = input.roster?.units.filter((unit) => unit.productDomain === definition.productDomain) ?? [];
    const unresolvedUnits =
      input.roster?.unresolvedUnits.filter((unit) => unit.productDomain === definition.productDomain) ?? [];
    const discoveryProviders = [
      ...new Set(units.filter((unit) => unit.disposition === "discovery-target").map((unit) => unit.providerKey)),
    ].sort();
    const discoveryLanguages = [...new Set(units.flatMap((unit) => unit.discoveryLanguages))].sort();
    const languageGap = definition.languageCode !== null && !discoveryLanguages.includes(definition.languageCode);
    const unreached = input.refusal ?? "row-not-reached";
    const refresh =
      capture?.refresh ??
      discoveryProviders.map((providerKey) => ({
        providerKey,
        status: "unknown" as const,
        reason: unreached,
        clickedAt: null,
        lastRunCompletedAt: null,
        lastRunStatus: null,
      }));
    const inbox = capture?.inbox ?? summarizeScopeSyncBatchPreviewProbeInbox(null, unreached);
    const preview = capture?.preview ?? summarizeScopeSyncBatchPreviewProbePreview(null, unreached);
    const sharedWith =
      definition.rowKey === "pokemon-en" ? "pokemon-ja" : definition.rowKey === "pokemon-ja" ? "pokemon-en" : null;
    const gaps = [
      ...(input.roster ? [] : ["roster-unknown"]),
      ...(input.roster?.source === "registry-at-admitted-sha" ? ["roster-not-read-from-deployed-admin"] : []),
      ...unresolvedUnits.map((unit) => `roster-unresolved:${unit.unitKey}`),
      ...(input.roster && units.length === 0 && unresolvedUnits.length === 0 ? ["roster-no-units"] : []),
      ...(languageGap ? [`discovery-language-gap:${definition.languageCode}`] : []),
      ...units.filter((unit) => unit.disposition === "unsupported").map((unit) => `unsupported-unit:${unit.unitKey}`),
      ...refresh
        .filter((result) => result.status !== "refreshed")
        .map((result) => `refresh-${result.status}:${result.providerKey}`),
      ...discoveryProviders
        .filter((providerKey) => !refresh.some((result) => result.providerKey === providerKey))
        .map((providerKey) => `refresh-missing:${providerKey}`),
      ...(inbox.completeness === "within-bound" ? [] : [`inbox-${inbox.completeness}`]),
      ...(preview.eligibleScopeRecords.completeness === "complete"
        ? []
        : [`scope-records-${preview.eligibleScopeRecords.completeness}`]),
      ...(["ready", "blocked", "empty"].includes(preview.status) ? [] : [`preview-${preview.status}`]),
      "wall-clock-unknown",
    ];
    return {
      ...definition,
      roster: {
        source: input.roster?.source ?? null,
        units,
        unresolvedUnits,
        discoveryProviders,
        languageCoverage: { requested: definition.languageCode, discoveryLanguages, gap: languageGap },
      },
      refresh,
      inbox,
      preview,
      scopeRecordSet: {
        sharedWith,
        reason: sharedWith
          ? "matching-scope selection ignores languageCode; EN and JA rows resolve one Scope Record set"
          : null,
      },
      gaps,
    };
  });
  const incompleteReasons = [
    ...(input.refusal ? [input.refusal] : []),
    ...(input.identity.retry === 0 ? [] : ["retry-attempt-no-capture"]),
    ...(input.fenceViolations.length === 0 ? [] : ["request-fence-violation"]),
    ...rows.flatMap((row) => captureIncompleteReasons(row).map((reason) => `${row.rowKey}:${reason}`)),
  ];
  const providersClicked = [...new Set(input.providersClicked)].sort();
  return {
    schemaVersion: scopeSyncBatchPreviewProbeSchemaVersion,
    identity: input.identity,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    captureStatus: incompleteReasons.length === 0 ? "complete" : "incomplete",
    incompleteReasons,
    spendDisclosure: {
      discoveryRunNowClicks: input.providersClicked.length,
      providersClicked,
      scrydexRefreshClicked: providersClicked.includes("scrydex"),
      scrydexLiveCallCount: "unknown",
      note: "Run-now discovery may call live and credited providers (Scrydex included); the preview credit limit does not bound discovery calls, so no call count is inferred.",
    },
    fence: { violations: input.fenceViolations },
    rows,
  };
}

// Capture completeness: every source of the row was read with a determinate
// outcome. Data gaps (caps, language gaps, failed refreshes) stay in row.gaps
// and never masquerade as totals; only unread sources make the capture incomplete.
function captureIncompleteReasons(row: ScopeSyncBatchPreviewProbeRow): string[] {
  return [
    ...(row.roster.source === "deployed-admin-profiles" ? [] : ["roster-not-from-deployed-admin"]),
    ...row.roster.unresolvedUnits.map((unit) => `roster-unresolved:${unit.unitKey}`),
    ...(row.roster.source !== null && row.roster.units.length === 0 && row.roster.unresolvedUnits.length === 0
      ? ["roster-no-units"]
      : []),
    ...row.refresh
      .filter((result) => result.status === "unknown")
      .map((result) => `refresh-unknown:${result.providerKey}`),
    ...row.roster.discoveryProviders
      .filter((providerKey) => !row.refresh.some((result) => result.providerKey === providerKey))
      .map((providerKey) => `refresh-missing:${providerKey}`),
    ...(row.inbox.status === "read" ? [] : ["inbox-unread"]),
    ...(["ready", "blocked", "empty"].includes(row.preview.status) ? [] : [`preview-${row.preview.status}`]),
  ];
}

// --- Validation ------------------------------------------------------------

const previewMetricFields = [
  "effectiveBudget",
  "selection",
  "confirmAllowed",
  "planFingerprint",
  "resolvedAt",
  "readyScopes",
  "blockedScopes",
  "participatingProviderUnits",
  "providerUnitTotals",
  "providerRequestEstimates",
  "blockerCounts",
] as const satisfies readonly (keyof ScopeSyncBatchPreviewProbePreviewResult)[];

const previewResultFields = [
  ...previewMetricFields,
  "status",
  "reason",
  "submitted",
  "formBudget",
  "eligibleScopeRecords",
  "scrydex",
  "blockers",
  "blockersRecorded",
  "wallClock",
] as const satisfies readonly (keyof ScopeSyncBatchPreviewProbePreviewResult)[];

export function validateScopeSyncBatchPreviewProbeReceipt(
  value: unknown,
  expected: Readonly<{ sha?: string; runId?: string; runAttempt?: string; forbiddenValues?: readonly string[] }> = {},
): Readonly<{ ok: boolean; errors: readonly string[] }> {
  const errors: string[] = [];
  if (JSON.stringify(value ?? null).length > maxReceiptBytes) errors.push("receipt exceeds the size bound");
  // Credential values are compared with the decoded keys and values, never with
  // encoded JSON, where escaped quotes, backslashes and control characters would
  // hide them. Every nonblank supplied value is checked, however short.
  const decoded = decodedReceiptText(value);
  const forbiddenValues = (expected.forbiddenValues ?? [])
    .flatMap((forbidden) => [forbidden, forbidden.trim()])
    .filter((candidate) => candidate.trim().length > 0);
  const containsForbidden = (text: string) => forbiddenValues.some((candidate) => text.includes(candidate));
  if (decoded.texts.some(containsForbidden)) errors.push("receipt contains a forbidden value");
  for (const key of decoded.keys) {
    if (/password|cookie|authorization|secret|token|session|rawpayload|credential/i.test(key)) {
      errors.push(
        containsForbidden(key) ? "receipt contains a forbidden key" : `receipt contains forbidden key '${key}'`,
      );
    }
  }
  if (!isRecord(value)) return { ok: false, errors: [...errors, "receipt is not an object"] };
  if (value.schemaVersion !== scopeSyncBatchPreviewProbeSchemaVersion) errors.push("schemaVersion mismatch");
  const identity = isRecord(value.identity) ? value.identity : {};
  if (!/^[0-9a-f]{40}$/.test(String(identity.sha ?? ""))) errors.push("identity.sha must be a 40-character SHA");
  if (!/^\d+$/.test(String(identity.runId ?? ""))) errors.push("identity.runId is missing");
  if (!/^\d+$/.test(String(identity.runAttempt ?? ""))) errors.push("identity.runAttempt is missing");
  if (!Number.isInteger(identity.retry) || (identity.retry as number) < 0) errors.push("identity.retry is missing");
  if (identity.journeyScope !== scopeSyncBatchPreviewProbeJourneyScope) errors.push("identity.journeyScope mismatch");
  if (typeof identity.origin !== "string" || !identity.origin) errors.push("identity.origin is missing");
  if (expected.sha && identity.sha !== expected.sha.toLowerCase()) errors.push("identity.sha is not the admitted SHA");
  if (expected.runId && identity.runId !== expected.runId) errors.push("identity.runId is not this run");
  if (expected.runAttempt && identity.runAttempt !== expected.runAttempt) {
    errors.push("identity.runAttempt is not this attempt");
  }
  if (!isTimestamp(value.startedAt) || !isTimestamp(value.finishedAt)) errors.push("startedAt/finishedAt missing");
  const rows = Array.isArray(value.rows) ? value.rows.filter(isRecord) : [];
  const rowKeys = rows.map((row) => row.rowKey);
  if (rows.length !== scopeSyncBatchPreviewProbeRows.length || new Set(rowKeys).size !== rows.length) {
    errors.push("rows must be the six unique probe rows");
  }
  for (const definition of scopeSyncBatchPreviewProbeRows) {
    const row = rows.find((candidate) => candidate.rowKey === definition.rowKey);
    if (!row) {
      errors.push(`row ${definition.rowKey} is missing`);
      continue;
    }
    errors.push(...validateRow(definition, row));
  }
  const spend = isRecord(value.spendDisclosure) ? value.spendDisclosure : {};
  if (spend.scrydexLiveCallCount !== "unknown") errors.push("scrydexLiveCallCount must stay unknown");
  const fence = isRecord(value.fence) && Array.isArray(value.fence.violations) ? value.fence.violations : null;
  if (!fence) errors.push("fence.violations is missing");
  const reasons = Array.isArray(value.incompleteReasons) ? value.incompleteReasons : null;
  if (!reasons) errors.push("incompleteReasons is missing");
  if (value.captureStatus === "complete") {
    if ((reasons?.length ?? 1) > 0) errors.push("complete capture lists incomplete reasons");
    if ((fence?.length ?? 1) > 0) errors.push("complete capture has fence violations");
    if (identity.retry !== 0) errors.push("complete capture must come from the first attempt");
    for (const row of rows) {
      let unread: readonly string[];
      try {
        unread = captureIncompleteReasons(row as unknown as ScopeSyncBatchPreviewProbeRow);
      } catch {
        unread = ["malformed-row"];
      }
      const rowKey = scopeSyncBatchPreviewProbeRows.some((definition) => definition.rowKey === row.rowKey)
        ? String(row.rowKey)
        : "unknown";
      if (unread.length > 0) errors.push(`complete capture has an unread source in row ${rowKey}`);
    }
  } else if (value.captureStatus !== "incomplete") {
    errors.push("captureStatus must be complete or incomplete");
  } else if ((reasons?.length ?? 0) === 0) {
    errors.push("incomplete capture needs at least one reason");
  }
  return { ok: errors.length === 0, errors };
}

function validateRow(definition: ScopeSyncBatchPreviewProbeRowDefinition, row: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const key = definition.rowKey;
  if (
    row.productDomain !== definition.productDomain ||
    row.scopeKind !== definition.scopeKind ||
    row.languageCode !== definition.languageCode
  ) {
    errors.push(`row ${key} coordinates do not match the probe definition`);
  }
  const roster = isRecord(row.roster) ? row.roster : null;
  if (
    !roster ||
    !Array.isArray(roster.units) ||
    !Array.isArray(roster.unresolvedUnits) ||
    !Array.isArray(roster.discoveryProviders)
  ) {
    errors.push(`row ${key} roster is missing`);
  }
  if (!Array.isArray(row.refresh)) errors.push(`row ${key} refresh is missing`);
  const inbox = isRecord(row.inbox) ? row.inbox : null;
  if (!inbox) errors.push(`row ${key} inbox is missing`);
  else {
    if (inbox.languageSpecific !== false) errors.push(`row ${key} inbox must be domain-wide`);
    if (isCount(inbox.candidatesRead) && inbox.candidatesRead >= scopeSyncBatchPreviewProbeInboxRowBound) {
      if (inbox.completeness !== "capped") errors.push(`row ${key} inbox at the row bound must be capped`);
    }
    if (inbox.status !== "read" && inbox.candidatesRead !== null) errors.push(`row ${key} unread inbox reports counts`);
  }
  const preview = isRecord(row.preview) ? row.preview : null;
  if (!preview) {
    errors.push(`row ${key} preview is missing`);
    return errors;
  }
  const eligible = isRecord(preview.eligibleScopeRecords) ? preview.eligibleScopeRecords : {};
  if (isCount(eligible.count) && eligible.count >= scopeSyncBatchPreviewProbeMatchingScopeBound) {
    if (eligible.completeness !== "capped") errors.push(`row ${key} matching-scope count at the bound must be capped`);
  }
  if (eligible.count === 0 && !eligible.zeroReason) errors.push(`row ${key} zero Scope Records needs a reason`);
  if (eligible.count === null && eligible.completeness !== "unknown") {
    errors.push(`row ${key} missing Scope Record count must be unknown`);
  }
  // Every metric is written explicitly; an absent field is truncation, not an unknown.
  const absent = previewResultFields.filter((field) => !Object.hasOwn(preview, field));
  if (absent.length > 0) errors.push(`row ${key} preview omits ${absent.join(",")}`);
  if (["ready", "blocked", "empty", "stale"].includes(String(preview.status))) {
    if (!preview.planFingerprint || !isTimestamp(preview.resolvedAt)) {
      errors.push(`row ${key} captured preview needs planFingerprint and resolvedAt`);
    }
    const scrydex = isRecord(preview.scrydex) ? preview.scrydex : {};
    const invalid = [
      ...(isCount(eligible.count) ? [] : ["eligibleScopeRecords.count"]),
      ...(isCount(preview.readyScopes) ? [] : ["readyScopes"]),
      ...(isCount(preview.blockedScopes) ? [] : ["blockedScopes"]),
      ...(isCount(preview.participatingProviderUnits) ? [] : ["participatingProviderUnits"]),
      ...(isCountMap(preview.providerUnitTotals) ? [] : ["providerUnitTotals"]),
      ...(isCountMap(preview.providerRequestEstimates, true) ? [] : ["providerRequestEstimates"]),
      ...(isBudget(preview.effectiveBudget) ? [] : ["effectiveBudget"]),
      ...(isRecord(preview.selection) ? [] : ["selection"]),
      ...(typeof preview.confirmAllowed === "boolean" ? [] : ["confirmAllowed"]),
      ...(typeof scrydex.participating === "boolean" ? [] : ["scrydex.participating"]),
      ...(isCountMap(preview.blockerCounts) ? [] : ["blockerCounts"]),
    ];
    if (invalid.length > 0) errors.push(`row ${key} captured preview lacks ${invalid.join(",")}`);
  } else {
    if (eligible.count !== null) errors.push(`row ${key} uncaptured preview reports a Scope Record count`);
    const reported = previewMetricFields.filter((field) => preview[field] !== null && preview[field] !== undefined);
    if (reported.length > 0) errors.push(`row ${key} uncaptured preview reports ${reported.join(",")}`);
  }
  const wallClock = isRecord(preview.wallClock) ? preview.wallClock : {};
  if (wallClock.estimate !== "unknown" && !isRecord(wallClock.rate)) {
    errors.push(`row ${key} wall-clock estimate needs a measured rate`);
  }
  const shared = isRecord(row.scopeRecordSet) ? row.scopeRecordSet.sharedWith : undefined;
  const expectedShared = key === "pokemon-en" ? "pokemon-ja" : key === "pokemon-ja" ? "pokemon-en" : null;
  if (shared !== expectedShared) errors.push(`row ${key} must declare its shared Scope Record set`);
  if (!Array.isArray(row.gaps)) errors.push(`row ${key} gaps are missing`);
  return errors;
}

// --- Support-safe text -----------------------------------------------------

export function supportSafeText(value: string, maxLength = maxSupportSafeTextLength): string {
  const redacted = value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b(?:bearer|basic)\s+\S+/gi, "[credential]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

// Breadth-first, so a route's top-level read model wins over nested look-alikes.
function findRecord(
  root: unknown,
  predicate: (node: Record<string, unknown>) => boolean,
  maxDepth = 8,
): Record<string, unknown> | null {
  let level: unknown[] = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!node || typeof node !== "object") continue;
      if (isRecord(node) && predicate(node)) return node;
      for (const child of Object.values(node)) next.push(child);
    }
    level = next;
  }
  return null;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCountMap(value: unknown, allowNull = false): boolean {
  return isRecord(value) && Object.values(value).every((entry) => isCount(entry) || (allowNull && entry === null));
}

// Every object key and every string or number value at any depth, decoded.
// Iterative, so a deeply nested receipt cannot hide a value past a depth cap.
function decodedReceiptText(value: unknown): Readonly<{ keys: readonly string[]; texts: readonly string[] }> {
  const keys: string[] = [];
  const texts: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") texts.push(current);
    else if (typeof current === "number" || typeof current === "bigint") texts.push(String(current));
    else if (Array.isArray(current)) for (const child of current) pending.push(child);
    else if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        keys.push(key);
        texts.push(key);
        pending.push(child);
      }
    }
  }
  return { keys, texts };
}
