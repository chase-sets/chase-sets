import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import {
  getActiveCatalogProviderIntegrationProfileVersion,
  catalogProviderProfileVersionIngestionUnitKey,
  catalogProviderIntegrationProfileVersions,
} from "../../../../bounded-contexts/catalog/features/source-observations/api/providers/registry";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../../../../bounded-contexts/catalog/features/source-observations/api/providers/profile-types";
import {
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "../../../../bounded-contexts/catalog/features/source-observations/api/promotion/provider-source-observation-normalizer";
import {
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionResolvedCatalogMapping,
} from "../../../../bounded-contexts/catalog/features/source-observations/api/promotion/provider-promotion-command-planner";
import type { CatalogIntegrationUnitKey } from "../../../../bounded-contexts/catalog/features/source-observations/api/integration-unit";
import type { CatalogItemId, ReferenceRecordId } from "../../../../bounded-contexts/catalog/ids";
import type { SourceObservationNormalized } from "../../../../bounded-contexts/catalog/features/source-observations/domain/domain";
import type { JsonValue } from "@chase-sets/primitives/json";

export type RepresentativeCoordinate = Readonly<{
  id: string;
  group: string;
  providerKey: string;
  unitKey: string;
  language: string;
  target: string;
}>;
export class EvidenceUnknown extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class RepresentativeBudget {
  readonly deadline: number;
  constructor(
    outerRemainingMs: number,
    readonly now: () => number = Date.now,
    readonly emissionMarginMs = 5_000,
  ) {
    if (outerRemainingMs <= emissionMarginMs || emissionMarginMs <= 0) throw new EvidenceUnknown("no-emission-margin");
    this.deadline = now() + outerRemainingMs - emissionMarginMs;
  }
  remaining(maximum = Number.MAX_SAFE_INTEGER): number {
    const remaining = this.deadline - this.now();
    if (remaining <= 0) throw new EvidenceUnknown("deadline-exhausted");
    return Math.min(remaining, maximum);
  }
  async run<T>(operation: (remaining: number) => Promise<T>): Promise<T> {
    return this.runBounded(operation, this.remaining());
  }
  async finish<T>(operation: (remaining: number) => Promise<T>): Promise<T> {
    const remaining = this.deadline + this.emissionMarginMs - this.now();
    if (remaining <= 0) throw new EvidenceUnknown("emission-deadline-exhausted");
    return this.runBounded(operation, remaining / 2);
  }
  private async runBounded<T>(operation: (remaining: number) => Promise<T>, remaining: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(remaining),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new EvidenceUnknown("deadline-exhausted")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function assertExactMembers(
  expected: readonly RepresentativeCoordinate[],
  selected: readonly string[],
  executed: readonly string[],
): void {
  const required = expected.map((member) => member.id).sort();
  if (new Set(required).size !== required.length || !required.length)
    throw new EvidenceUnknown("invalid-member-authority");
  for (const actual of [selected, executed]) {
    if (JSON.stringify([...actual].sort()) !== JSON.stringify(required))
      throw new EvidenceUnknown("incomplete-member-set");
  }
}

export function inventoryDigest(members: readonly RepresentativeCoordinate[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        members.map(({ id, group, providerKey, unitKey, language, target }) => ({
          id,
          group,
          providerKey,
          unitKey,
          language,
          target,
        })),
      ),
    )
    .digest("hex");
}

export type ItemInstant = Readonly<{ id: string; updatedAt: string }>;
export type CatalogScope = Readonly<{ source: string; tag: string; language: string; status: "draft" | "active" }>;
export type CatalogPage = Readonly<{
  pathname: string;
  heading: boolean;
  settled: boolean;
  error: boolean;
  page: number;
  scope: CatalogScope;
  urlScope: CatalogScope;
  total: number | null;
  totalVisible: boolean;
  ids: readonly string[];
  nextPage: number | null;
}>;

export function assertCatalogPage(snapshot: CatalogPage, scope: CatalogScope, page: number): void {
  if (
    snapshot.pathname !== "/catalog/catalog-items" ||
    !snapshot.heading ||
    !snapshot.settled ||
    snapshot.error ||
    snapshot.page !== page
  )
    throw new EvidenceUnknown("unsettled-catalog-route");
  for (const key of ["source", "tag", "language", "status"] as const) {
    if (snapshot.scope[key] !== scope[key] || snapshot.urlScope[key] !== scope[key])
      throw new EvidenceUnknown("wrong-catalog-scope");
  }
  if (!snapshot.totalVisible || snapshot.total === null || !Number.isSafeInteger(snapshot.total) || snapshot.total < 0)
    throw new EvidenceUnknown("unread-server-total");
  if (snapshot.ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id)) || new Set(snapshot.ids).size !== snapshot.ids.length)
    throw new EvidenceUnknown("unresolved-or-duplicate-item");
}

export async function collectCatalogCensus(
  scope: CatalogScope,
  read: (page: number) => Promise<CatalogPage>,
  budget: RepresentativeBudget,
  maxPages = 200,
): Promise<readonly string[]> {
  const ids = new Set<string>();
  let total: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const snapshot = await budget.run(() => read(page));
    assertCatalogPage(snapshot, scope, page);
    if (total !== null && total !== snapshot.total) throw new EvidenceUnknown("unstable-server-total");
    total = snapshot.total!;
    if (total >= maxPages * 50) throw new EvidenceUnknown("census-cap-reached");
    const expectedCount = Math.min(50, Math.max(0, total - page * 50));
    if (snapshot.ids.length !== expectedCount) throw new EvidenceUnknown("missing-page-tail");
    for (const id of snapshot.ids) {
      if (ids.has(id)) throw new EvidenceUnknown("duplicate-paging-identity");
      ids.add(id);
    }
    if (snapshot.nextPage === null) {
      if (ids.size !== total) throw new EvidenceUnknown("incomplete-census");
      return [...ids];
    }
    if (snapshot.nextPage !== page + 1 || ids.size >= total) throw new EvidenceUnknown("unsafe-page-continuation");
  }
  throw new EvidenceUnknown("census-cap-reached");
}

export function catalogListHref(scope: CatalogScope, page = 0): string {
  return `/catalog/catalog-items?${new URLSearchParams({ ...scope, page: String(page + 1) })}`;
}

export async function readRenderedCatalogPage(
  page: Page,
  scope: CatalogScope,
  pageIndex: number,
  budget: RepresentativeBudget,
): Promise<CatalogPage> {
  await budget.run((timeout) =>
    page.goto(catalogListHref(scope, pageIndex), { waitUntil: "domcontentloaded", timeout }),
  );
  await budget.run((timeout) =>
    expect(page.getByRole("heading", { name: "Catalog Items", exact: true })).toBeVisible({ timeout }),
  );
  await budget.run((timeout) =>
    expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout }),
  );
  const renderedScope = { ...scope };
  const more = page.getByRole("button", { name: "More filters", exact: true });
  let openedFilters = false;
  for (const [name, key] of [
    ["Source", "source"],
    ["Tag", "tag"],
    ["Language", "language"],
    ["Status", "status"],
  ] as const) {
    let control = page.getByRole(key === "source" || key === "tag" ? "textbox" : "combobox", { name, exact: true });
    if (!(await budget.run(() => control.isVisible()))) {
      if (openedFilters) throw new EvidenceUnknown("hidden-scope-control");
      await budget.run((timeout) => more.click({ timeout }));
      openedFilters = true;
      control = control.filter({ visible: true });
    }
    await budget.run((timeout) => expect(control).toBeVisible({ timeout }));
    if (key === "source" || key === "tag")
      renderedScope[key] = await budget.run((timeout) => control.inputValue({ timeout }));
    else {
      const text = (await budget.run((timeout) => control.innerText({ timeout }))).trim().toLowerCase();
      const labels =
        key === "language"
          ? ({ en: "english", ja: "japanese", ko: "korean", "zh-tw": "chinese (traditional)" } as Record<
              string,
              string
            >)
          : {};
      if (text !== scope[key] && text !== labels[scope[key]]) throw new EvidenceUnknown("wrong-rendered-scope-control");
    }
  }
  if (openedFilters)
    await budget.run((timeout) => page.getByRole("button", { name: "Close filters", exact: true }).click({ timeout }));
  const totalAnchor = page.locator("[data-catalog-items-total]");
  await budget.run((timeout) => expect(totalAnchor).toBeVisible({ timeout }));
  const totalText = await budget.run((timeout) => totalAnchor.innerText({ timeout }));
  const totalAttribute = await budget.run((timeout) =>
    totalAnchor.getAttribute("data-catalog-items-total", { timeout }),
  );
  const total = totalAttribute !== null && /^\d+$/.test(totalAttribute) ? Number(totalAttribute) : null;
  const visibleCount = totalText.match(/^\s*([\d,]+)/)?.[1]?.replaceAll(",", "");
  if (total === null || visibleCount === undefined || Number(visibleCount) !== total)
    throw new EvidenceUnknown("unparseable-server-total");
  const links = page.getByRole("link", { name: "View", exact: true });
  const ids: string[] = [];
  for (let i = 0, count = await budget.run(() => links.count()); i < count; i++) {
    const link = links.nth(i);
    await budget.run((timeout) => expect(link).toBeVisible({ timeout }));
    const href = await budget.run((timeout) => link.getAttribute("href", { timeout }));
    const target = new URL(href ?? "", page.url());
    const match = /^\/catalog\/catalog-items\/([A-Za-z0-9_-]+)$/.exec(target.pathname);
    if (target.origin !== new URL(page.url()).origin || !match || target.search || target.hash)
      throw new EvidenceUnknown("unresolved-item-link");
    ids.push(match[1]!);
  }
  const url = new URL(page.url());
  const next = page.getByRole("button", { name: "Next", exact: true });
  const nextPage =
    (await budget.run(() => next.count())) > 0 && (await budget.run(() => next.isEnabled())) ? pageIndex + 1 : null;
  const snapshot: CatalogPage = {
    pathname: url.pathname,
    heading: true,
    settled: (await budget.run(() => page.locator('[aria-busy="true"]').count())) === 0,
    error: (await budget.run(() => page.getByRole("heading", { name: /Something went wrong|Sign in/i }).count())) > 0,
    page: Number(url.searchParams.get("page") ?? 1) - 1,
    scope: renderedScope,
    urlScope: Object.fromEntries(
      ["source", "tag", "language", "status"].map((key) => [key, url.searchParams.get(key)]),
    ) as CatalogScope,
    total,
    totalVisible: true,
    ids,
    nextPage,
  };
  assertCatalogPage(snapshot, scope, pageIndex);
  return snapshot;
}

export async function readUpdatedItem(
  page: Page,
  id: string,
  scope: CatalogScope,
  budget: RepresentativeBudget,
): Promise<ItemInstant> {
  await budget.run((timeout) =>
    page.goto(`/catalog/catalog-items/${encodeURIComponent(id)}`, { waitUntil: "domcontentloaded", timeout }),
  );
  if (new URL(page.url()).pathname !== `/catalog/catalog-items/${id}`) throw new EvidenceUnknown("wrong-item-route");
  const updated = page
    .locator("dt")
    .filter({ hasText: /^Updated$/ })
    .locator("..")
    .locator("dd");
  await budget.run((timeout) => expect(updated).toBeVisible({ timeout }));
  const updatedAt = (await budget.run((timeout) => updated.innerText({ timeout }))).trim();
  parseInstant(updatedAt);
  await readRenderedCatalogPage(page, scope, 0, budget);
  return { id, updatedAt };
}

export async function readCatalogBaseline(
  page: Page,
  member: RepresentativeCoordinate,
  budget: RepresentativeBudget,
): Promise<readonly ItemInstant[]> {
  const items = new Map<string, ItemInstant>();
  for (const status of ["draft", "active"] as const) {
    const scope: CatalogScope = {
      source: member.providerKey,
      language: member.language,
      tag: member.unitKey.split(":")[1] === "mtg" ? "magic" : member.unitKey.split(":")[1]!,
      status,
    };
    const ids = await collectCatalogCensus(
      scope,
      (index) => readRenderedCatalogPage(page, scope, index, budget),
      budget,
    );
    for (const id of ids) {
      if (items.has(id)) throw new EvidenceUnknown("item-crossed-status-during-census");
      items.set(id, await readUpdatedItem(page, id, scope, budget));
    }
    const reconciled = await collectCatalogCensus(
      scope,
      (index) => readRenderedCatalogPage(page, scope, index, budget),
      budget,
    );
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...reconciled].sort()))
      throw new EvidenceUnknown("census-changed-during-detail-reads");
  }
  return [...items.values()];
}

function parseInstant(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new EvidenceUnknown("unparseable-instant");
  return Date.parse(value);
}

export function evaluateCausalReadback(
  input: Readonly<{
    before: readonly ItemInstant[];
    after: readonly ItemInstant[];
    watermark: string;
    completedAt: string;
    observationId: string;
    outcomeObservationId: string;
    catalogItemId: string | null;
    promotedAt: string | null;
    commandState: string;
    successful: boolean;
    exactTarget: boolean;
    competingMutation: boolean;
  }>,
): "created" | "refreshed" {
  if (
    !input.exactTarget ||
    input.competingMutation ||
    !input.successful ||
    input.commandState !== "completed" ||
    input.observationId !== input.outcomeObservationId ||
    !input.catalogItemId ||
    !input.promotedAt
  )
    throw new EvidenceUnknown("unproven-command-causality");
  const watermark = parseInstant(input.watermark);
  const completed = parseInstant(input.completedAt);
  const promoted = parseInstant(input.promotedAt);
  // Two seconds permits bounded server/client skew; own baseline advancement
  // and the command's exact observation/item join remain mandatory.
  const skew = 2_000;
  const item = input.after.find((candidate) => candidate.id === input.catalogItemId);
  if (!item) throw new EvidenceUnknown("missing-causal-item");
  const updated = parseInstant(item.updatedAt);
  if (
    updated < watermark - skew ||
    updated > completed + skew ||
    promoted < watermark - skew ||
    promoted > completed + skew ||
    Math.abs(updated - promoted) > skew
  )
    throw new EvidenceUnknown("outside-causal-interval");
  const old = input.before.find((candidate) => candidate.id === item.id);
  if (old && updated <= parseInstant(old.updatedAt)) throw new EvidenceUnknown("unchanged-preexisting-item");
  return old ? "refreshed" : "created";
}

export function activeMemberProfile(
  member: RepresentativeCoordinate,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
) {
  const version = getActiveCatalogProviderIntegrationProfileVersion(
    member.providerKey,
    { ingestionUnitKey: member.unitKey as CatalogIntegrationUnitKey },
    versions,
  );
  if (
    !version?.active ||
    version.lifecycle !== "active" ||
    catalogProviderProfileVersionIngestionUnitKey(version) !== member.unitKey ||
    version.executableMappingContract?.providerKey !== member.providerKey ||
    version.profile.providerKey !== member.providerKey
  )
    throw new EvidenceUnknown("inactive-or-mismatched-profile");
  return version;
}

export function memberPromotionPlan(
  member: RepresentativeCoordinate,
  normalized: SourceObservationNormalized,
  referenceIds: readonly string[],
) {
  const version = activeMemberProfile(member);
  if (referenceIds.length > 1) throw new EvidenceUnknown("missing-or-ambiguous-reference");
  const fieldIds = Object.fromEntries(
    Object.keys(version.profile.catalogFieldMapping.fieldKeys).map((key) => [key, `synthetic_field_${key}`]),
  ) as CatalogProviderPromotionResolvedCatalogMapping["fieldIds"];
  return planCatalogProviderPromotionCommands({
    profile: version.profile,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    providerKey: member.providerKey,
    externalKey: "synthetic-partition-observation",
    mode: "create",
    catalogItemId: "synthetic_partition_item" as CatalogItemId,
    normalized,
    catalog: {
      blueprintId: "synthetic_blueprint" as CatalogProviderPromotionResolvedCatalogMapping["blueprintId"],
      categoryId: "synthetic_category" as CatalogProviderPromotionResolvedCatalogMapping["categoryId"],
      fieldIds,
    },
    expansionReferenceId: referenceIds[0] as ReferenceRecordId,
    setReferenceId: referenceIds[0] as ReferenceRecordId,
    metadata: { title: normalized.name, subtitle: "" },
    productAssetSet: null,
  });
}

export function executableMemberPartition(member: RepresentativeCoordinate) {
  const version = activeMemberProfile(member);
  const payload = JSON.parse(readFileSync(`${version.fixtures.fixtureRoot}/normal.json`, "utf8"));
  const observation = mapMemberPayload(member, payload);
  const plan = memberPromotionPlan(member, observation.normalized, ["synthetic_reference"]);
  if (plan.status === "planned" && plan.plan.commands.length === 0) throw new EvidenceUnknown("empty-promotion-plan");
  if (
    plan.status === "blocked" &&
    !plan.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported-observation-kind" || diagnostic.code === "missing-promotion-capability",
    )
  )
    throw new EvidenceUnknown("unclassified-promotion-partition");
  return {
    version,
    unitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    normalized: observation.normalized,
    partition: plan.status === "planned" ? ("catalog-item" as const) : ("reference-only" as const),
  };
}

export function mapMemberPayload(member: RepresentativeCoordinate, payload: JsonValue) {
  const version = activeMemberProfile(member);
  const contract = version.executableMappingContract;
  if (!contract?.sourceObservation) throw new EvidenceUnknown("missing-executable-mapper");
  const mapped = normalizeCatalogProviderSourceObservation({
    contract: contract as CatalogProviderSourceObservationMappingContract,
    payload,
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  if (!mapped.observation) throw new EvidenceUnknown("fixture-mapper-refused");
  return mapped.observation;
}

export type MemberOutcome = Readonly<{
  id: string;
  group: string;
  state: "created" | "refreshed" | "reference-imported" | "failed" | "unreached";
  selected: boolean;
  executed: boolean;
  code: string | null;
  selectedProductId: string | null;
  observationId: string | null;
  importJobId: string | null;
  commandJobId: string | null;
  previewId: string | null;
  catalogItemId: string | null;
  referenceRecordId: string | null;
  watermark: string | null;
  updatedAt: string | null;
  absoluteCount: number | null;
  causalCount: number;
}>;
export type RepresentativeReceipt = Readonly<{
  version: "representative-catalog-v1";
  runId: string;
  attempt: string;
  sha: string;
  digest: string;
  members: readonly MemberOutcome[];
  groups: readonly { group: string; expected: number; terminal: number; failed: number; unreached: number }[];
}>;
export function emptyMemberOutcome(member: RepresentativeCoordinate): MemberOutcome {
  return {
    id: member.id,
    group: member.group,
    state: "unreached",
    selected: false,
    executed: false,
    code: null,
    selectedProductId: null,
    observationId: null,
    importJobId: null,
    commandJobId: null,
    previewId: null,
    catalogItemId: null,
    referenceRecordId: null,
    watermark: null,
    updatedAt: null,
    absoluteCount: null,
    causalCount: 0,
  };
}

export async function runRepresentativeMembers<T extends RepresentativeCoordinate>(
  members: readonly T[],
  budget: RepresentativeBudget,
  execute: (member: T, progress: { current: MemberOutcome }) => Promise<MemberOutcome>,
  identity: Pick<RepresentativeReceipt, "runId" | "attempt" | "sha">,
): Promise<RepresentativeReceipt> {
  const outcomes: MemberOutcome[] = [];
  for (const member of members) {
    const initial = emptyMemberOutcome(member);
    const progress = { current: initial };
    try {
      budget.remaining();
      outcomes.push(await budget.run(() => execute(member, progress)));
    } catch (error) {
      outcomes.push({
        ...progress.current,
        state:
          error instanceof EvidenceUnknown && error.code === "deadline-exhausted" && !progress.current.executed
            ? "unreached"
            : "failed",
        code: error instanceof EvidenceUnknown ? error.code : "member-operation-failed",
      });
    }
  }
  const groups = [...new Set(members.map((member) => member.group))].map((group) => {
    const rows = outcomes.filter((row) => row.group === group);
    return {
      group,
      expected: rows.length,
      terminal: rows.filter((row) => row.state !== "unreached").length,
      failed: rows.filter((row) => row.state === "failed").length,
      unreached: rows.filter((row) => row.state === "unreached").length,
    };
  });
  const receipt: RepresentativeReceipt = {
    version: "representative-catalog-v1",
    ...identity,
    digest: inventoryDigest(members),
    members: outcomes,
    groups,
  };
  validateRepresentativeReceipt(receipt, members);
  return receipt;
}

export function validateRepresentativeReceipt(
  receipt: RepresentativeReceipt,
  authority: readonly RepresentativeCoordinate[],
): void {
  if (
    Object.keys(receipt).sort().join() !==
    ["version", "runId", "attempt", "sha", "digest", "members", "groups"].sort().join()
  )
    throw new EvidenceUnknown("unexpected-receipt-field");
  if (
    receipt.version !== "representative-catalog-v1" ||
    !/^(?:\d+|synthetic-[a-z0-9-]+)$/.test(receipt.runId) ||
    !/^\d+$/.test(receipt.attempt) ||
    !/^[a-f0-9]{40}$/.test(receipt.sha) ||
    receipt.digest !== inventoryDigest(authority)
  )
    throw new EvidenceUnknown("invalid-receipt-identity");
  assertExactMembers(
    authority,
    receipt.members.map((row) => row.id),
    receipt.members.map((row) => row.id),
  );
  if (
    receipt.groups.length !== new Set(authority.map((member) => member.group)).size ||
    new Set(receipt.groups.map((group) => group.group)).size !== receipt.groups.length
  )
    throw new EvidenceUnknown("incomplete-receipt-groups");
  for (const row of receipt.members) {
    if (
      Object.keys(row).sort().join() !== Object.keys(emptyMemberOutcome(authority[0]!)).sort().join() ||
      row.group !== authority.find((member) => member.id === row.id)?.group
    )
      throw new EvidenceUnknown("invalid-receipt-member");
    for (const key of [
      "selectedProductId",
      "observationId",
      "importJobId",
      "commandJobId",
      "catalogItemId",
      "referenceRecordId",
      "code",
    ] as const)
      if (row[key] !== null && !/^[A-Za-z0-9_:.-]{1,256}$/.test(row[key]!))
        throw new EvidenceUnknown("unsafe-receipt-value");
    if (
      !["created", "refreshed", "reference-imported", "failed", "unreached"].includes(row.state) ||
      typeof row.selected !== "boolean" ||
      typeof row.executed !== "boolean" ||
      !Number.isSafeInteger(row.causalCount) ||
      row.causalCount < 0 ||
      (row.absoluteCount !== null && (!Number.isSafeInteger(row.absoluteCount) || row.absoluteCount < row.causalCount))
    )
      throw new EvidenceUnknown("invalid-receipt-state");
    if (row.watermark) parseInstant(row.watermark);
    if (row.updatedAt) parseInstant(row.updatedAt);
    if (row.previewId !== null && !/^[a-f0-9]{64}$/.test(row.previewId))
      throw new EvidenceUnknown("unsafe-preview-identity");
    if (row.executed && !row.selected) throw new EvidenceUnknown("executed-without-selection");
    if (
      (row.state === "created" || row.state === "refreshed") &&
      (!row.selected ||
        !row.executed ||
        !row.catalogItemId ||
        !row.observationId ||
        !row.commandJobId ||
        !row.watermark ||
        !row.updatedAt ||
        row.causalCount !== 1)
    )
      throw new EvidenceUnknown("incomplete-causal-receipt");
  }
  for (const group of receipt.groups) {
    const rows = receipt.members.filter((row) => row.group === group.group);
    if (
      Object.keys(group).sort().join() !== ["group", "expected", "terminal", "failed", "unreached"].sort().join() ||
      !rows.length ||
      group.expected !== rows.length ||
      group.terminal !== rows.filter((row) => row.state !== "unreached").length ||
      group.failed !== rows.filter((row) => row.state === "failed").length ||
      group.unreached !== rows.filter((row) => row.state === "unreached").length
    )
      throw new EvidenceUnknown("inconsistent-receipt-group");
  }
}

export function previewIdentityDigest(previewId: string): string {
  return createHash("sha256").update(previewId).digest("hex");
}

export function compareRepresentativeReceipts(
  authority: readonly RepresentativeCoordinate[],
  before: RepresentativeReceipt,
  after: RepresentativeReceipt,
): void {
  validateRepresentativeReceipt(before, authority);
  validateRepresentativeReceipt(after, authority);
  if (before.sha !== after.sha || before.digest !== after.digest) throw new EvidenceUnknown("repeat-authority-drift");
  for (const member of authority) {
    const previous = before.members.find((row) => row.id === member.id)!;
    const current = after.members.find((row) => row.id === member.id)!;
    if (
      [previous, current].some((row) => row.state === "failed" || row.state === "unreached") ||
      previous.selectedProductId !== current.selectedProductId ||
      previous.catalogItemId !== current.catalogItemId ||
      previous.referenceRecordId !== current.referenceRecordId
    )
      throw new EvidenceUnknown("repeat-member-drift");
  }
}
