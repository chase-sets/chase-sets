import { createHash } from "node:crypto";
import {
  buildScrydexCacheCaptureReceipt,
  decodeScrydexAcceptedMappings,
  decodeScrydexCacheCaptureOptionPage,
  decodeScrydexCacheCaptureProfiles,
  decodeScrydexCacheCaptureScopePage,
  scrydexCacheCaptureContinuationPath,
  scrydexCacheCaptureCoveragePath,
  scrydexCacheCaptureMaxContinuationPages,
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureProductDomains,
  scrydexCacheCaptureProfilesPath,
  scrydexCacheCaptureQueryHrefUnit,
  scrydexCacheCaptureScopePagePath,
  scrydexCacheCaptureUnits,
  type ScrydexCacheCaptureDeployGeneration,
  type ScrydexCacheCaptureEvidence,
  type ScrydexCacheCaptureProductDomain,
  type ScrydexCacheCaptureReceipt,
  type ScrydexCacheCaptureUnitKey,
} from "../domain/scrydex-cache-capture";

// Sequences one Scrydex cache capture over injected I/O so every fail-closed
// branch runs without a browser, GitHub or staging: bind the deployed revision,
// sign in, read the time-critical option caches first, then the Scope Record
// inventory and each record's accepted mappings, and bind the revision again.
// Nothing here retries, refreshes or substitutes a missing read; every gap is a
// named failure the receipt turns into governed unknown.

export type ScrydexCacheCaptureResponse = Readonly<{ status: number; text: string }>;
export type ScrydexCacheCaptureDeploymentSelection = Readonly<{
  generation: ScrydexCacheCaptureDeployGeneration | null;
  stop: string | null;
}>;

type Reads = { -readonly [K in keyof ScrydexCacheCaptureEvidence["reads"]]: number };
type UnitCapture = ScrydexCacheCaptureEvidence["units"][number];
type Stamp = Readonly<{ completedAt: string; responseSha256: string }>;

// Scope Record inventory pages per product domain: 50 x 200 records.
const maxScopePages = 50;
const maxFailures = 200;
const maxMappingsPerScope = 50;

export async function runScrydexCacheCapture(
  input: Readonly<{
    runner: ScrydexCacheCaptureEvidence["runner"];
    credentialsPresent: boolean;
    selectDeployment: () => Promise<ScrydexCacheCaptureDeploymentSelection>;
    signIn: () => Promise<void>;
    read: (path: string) => Promise<ScrydexCacheCaptureResponse>;
    resolveQueryHref: (
      profiles: readonly Record<string, unknown>[],
      unitKey: ScrydexCacheCaptureUnitKey,
    ) => string | null;
    tally: () => Pick<ScrydexCacheCaptureEvidence, "requests" | "fence">;
    now: () => string;
  }>,
): Promise<ScrydexCacheCaptureReceipt> {
  const startedAt = input.now();
  const failures = new Set<string>();
  const fail = (reason: string) => {
    if (failures.size < maxFailures - 1) failures.add(reason);
    else failures.add("failures-capped");
  };
  const sources = new CaptureSources(input, fail);
  let before: ScrydexCacheCaptureDeploymentSelection = { generation: null, stop: "not-attempted" };
  let after: ScrydexCacheCaptureDeploymentSelection = { generation: null, stop: "not-attempted" };

  if (!input.credentialsPresent) {
    fail("credentials-missing");
  } else {
    before = await selectDeployment(input.selectDeployment);
    if (before.generation) {
      let signedIn = false;
      try {
        await input.signIn();
        signedIn = true;
      } catch {
        fail("sign-in-failed");
      }
      if (signedIn) await sources.readAll();
      after = await selectDeployment(input.selectDeployment);
    }
  }

  const finishedAt = input.now();
  const { requests, fence } = input.tally();
  return buildScrydexCacheCaptureReceipt({
    runner: input.runner,
    deployment: {
      before: before.generation,
      after: after.generation,
      beforeStop: before.generation ? null : before.stop,
      afterStop: after.generation ? null : after.stop,
    },
    startedAt,
    finishedAt,
    requests,
    reads: sources.reads,
    fence,
    profileRead: sources.profileRead,
    scopeInventories: sources.scopeInventories,
    scopes: sources.scopes,
    units: sources.units,
    failures: [...failures],
  });
}

async function selectDeployment(
  select: () => Promise<ScrydexCacheCaptureDeploymentSelection>,
): Promise<ScrydexCacheCaptureDeploymentSelection> {
  try {
    const selection = await select();
    if (selection.generation) return { generation: selection.generation, stop: null };
    return {
      generation: null,
      stop: /^[a-z0-9-]{1,64}$/.test(selection.stop ?? "") ? selection.stop : "selection-failed",
    };
  } catch {
    return { generation: null, stop: "selection-failed" };
  }
}

class CaptureSources {
  readonly reads: Reads = { profileReads: 0, scopeInventoryReads: 0, coverageReads: 0, cacheOptionReads: 0 };
  profileRead: Stamp | null = null;
  readonly units: UnitCapture[] = [];
  readonly scopeInventories: ScrydexCacheCaptureEvidence["scopeInventories"][number][] = [];
  readonly scopes: ScrydexCacheCaptureEvidence["scopes"][number][] = [];

  constructor(
    private readonly input: Parameters<typeof runScrydexCacheCapture>[0],
    private readonly fail: (reason: string) => void,
  ) {}

  async readAll(): Promise<void> {
    const profiles = await this.readProfiles();
    if (profiles) {
      for (const unit of scrydexCacheCaptureUnits) await this.readOptionList(unit, profiles);
    }
    for (const productDomain of scrydexCacheCaptureProductDomains) await this.readInventory(productDomain);
    for (const inventory of this.scopeInventories) {
      for (const scopeRecordId of new Set(inventory.scopeRecordIds)) {
        await this.readCoverage(scopeRecordId, inventory.productDomain);
      }
    }
  }

  private async readJson(
    path: string,
    counter: keyof Reads,
  ): Promise<Readonly<{ ok: true; body: unknown } & Stamp> | Readonly<{ ok: false; status: number | null }>> {
    this.reads[counter] += 1;
    let response: ScrydexCacheCaptureResponse;
    try {
      response = await this.input.read(path);
    } catch {
      return { ok: false, status: null };
    }
    const completedAt = this.input.now();
    if (response.status !== 200) return { ok: false, status: response.status };
    try {
      return {
        ok: true,
        body: JSON.parse(response.text),
        completedAt,
        responseSha256: createHash("sha256").update(response.text).digest("hex"),
      };
    } catch {
      return { ok: false, status: response.status };
    }
  }

  private async readProfiles(): Promise<readonly Record<string, unknown>[] | null> {
    const result = await this.readJson(scrydexCacheCaptureProfilesPath, "profileReads");
    if (!result.ok) {
      this.fail("profiles-unreadable");
      return null;
    }
    const decoded = decodeScrydexCacheCaptureProfiles(result.body);
    if (!decoded.ok) {
      this.fail(decoded.reason);
      return null;
    }
    this.profileRead = { completedAt: result.completedAt, responseSha256: result.responseSha256 };
    return decoded.profiles;
  }

  // The unit's deployed first page, then the loader's continuation from the
  // same cached snapshot until the cursor is exhausted.
  private async readOptionList(
    unit: (typeof scrydexCacheCaptureUnits)[number],
    profiles: readonly Record<string, unknown>[],
  ): Promise<void> {
    const { unitKey, productDomain } = unit;
    let queryHref: string | null = null;
    try {
      queryHref = this.input.resolveQueryHref(profiles, unitKey);
    } catch {
      queryHref = null;
    }
    const firstPage = queryHref ? new URL(queryHref, scrydexCacheCaptureOrigin) : null;
    if (!queryHref || !firstPage || scrydexCacheCaptureQueryHrefUnit(queryHref) !== unitKey) {
      this.fail(`query-href-unresolved:${unitKey}`);
      return;
    }
    const pages: UnitCapture["pages"][number][] = [];
    const values: string[] = [];
    const seenCursors = new Set<string>();
    let cache: UnitCapture["cache"] | null = null;
    let cursor: string | null = null;
    while (true) {
      if (pages.length > scrydexCacheCaptureMaxContinuationPages) {
        this.fail(`option-continuation-cap:${unitKey}`);
        break;
      }
      const path: string =
        cursor === null
          ? `${firstPage.pathname}${firstPage.search}`
          : scrydexCacheCaptureContinuationPath(queryHref, cursor);
      const result = await this.readJson(path, "cacheOptionReads");
      if (!result.ok) {
        // The cache-only route answers 503 when no usable cached row exists.
        this.fail(`${result.status === 503 ? "option-cache-unavailable" : "option-read-failed"}:${unitKey}`);
        break;
      }
      const decoded = decodeScrydexCacheCaptureOptionPage(result.body, { cursor });
      if (!decoded.ok) {
        this.fail(`${decoded.reason}:${unitKey}`);
        break;
      }
      const page = decoded.page;
      if (cache && !sameCachedSnapshot(cache, page.cache)) {
        this.fail(`option-cache-changed:${unitKey}`);
        break;
      }
      cache ??= page.cache;
      pages.push({
        cursor: page.cursor,
        nextCursor: page.nextCursor,
        count: page.count,
        total: page.total,
        completedAt: result.completedAt,
        responseSha256: result.responseSha256,
      });
      values.push(...page.values);
      if (page.nextCursor === null) break;
      if (seenCursors.has(page.nextCursor)) {
        this.fail(`option-cursor-stalled:${unitKey}`);
        break;
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (cache) {
      const profileKey = firstPage.searchParams.get("profileKey") ?? "";
      this.units.push({ productDomain, unitKey, profileKey, queryHref, cache, pages, values });
    }
  }

  private async readInventory(productDomain: ScrydexCacheCaptureProductDomain): Promise<void> {
    const scopeRecordIds: string[] = [];
    const pages: ScrydexCacheCaptureEvidence["scopeInventories"][number]["pages"][number][] = [];
    let total: number | null = null;
    let offset = 0;
    while (true) {
      if (pages.length >= maxScopePages) {
        this.fail(`scope-inventory-cap:${productDomain}`);
        break;
      }
      const result = await this.readJson(
        scrydexCacheCaptureScopePagePath(productDomain, offset),
        "scopeInventoryReads",
      );
      if (!result.ok) {
        this.fail(`scope-inventory-unreadable:${productDomain}`);
        break;
      }
      const decoded = decodeScrydexCacheCaptureScopePage(result.body, { productDomain });
      if (!decoded.ok) {
        this.fail(`${decoded.reason}:${productDomain}`);
        break;
      }
      if (total !== null && decoded.total !== total) {
        this.fail(`scope-inventory-changed:${productDomain}`);
        break;
      }
      total = decoded.total;
      pages.push({
        offset,
        count: decoded.scopeRecordIds.length,
        completedAt: result.completedAt,
        responseSha256: result.responseSha256,
      });
      scopeRecordIds.push(...decoded.scopeRecordIds);
      if (scopeRecordIds.length >= total) break;
      if (decoded.scopeRecordIds.length === 0) {
        this.fail(`scope-inventory-truncated:${productDomain}`);
        break;
      }
      offset += decoded.scopeRecordIds.length;
    }
    if (total !== null) this.scopeInventories.push({ productDomain, total, scopeRecordIds, pages });
  }

  private async readCoverage(scopeRecordId: string, productDomain: ScrydexCacheCaptureProductDomain): Promise<void> {
    const result = await this.readJson(scrydexCacheCaptureCoveragePath(scopeRecordId), "coverageReads");
    if (!result.ok) {
      this.fail(`coverage-read-failed:${scopeRecordId}`);
      return;
    }
    const decoded = decodeScrydexAcceptedMappings(result.body, { scopeRecordId, productDomain });
    if (!decoded.ok) {
      this.fail(`${decoded.reason}:${scopeRecordId}`);
      return;
    }
    if (decoded.mappings.length > maxMappingsPerScope) {
      this.fail(`coverage-mapping-cap:${scopeRecordId}`);
      return;
    }
    this.scopes.push({
      scopeRecordId,
      productDomain,
      completedAt: result.completedAt,
      responseSha256: result.responseSha256,
      mappings: decoded.mappings,
    });
  }
}

// Continuation pages come from one cached row: the same key and freshness. The
// fresh/stale status alone may move as expiresAt passes between pages.
function sameCachedSnapshot(first: UnitCapture["cache"], next: UnitCapture["cache"]): boolean {
  return (
    first.cacheKey === next.cacheKey &&
    first.fetchedAt === next.fetchedAt &&
    first.expiresAt === next.expiresAt &&
    first.staleUntil === next.staleUntil
  );
}
