import { describe, expect, it } from "vitest";
import { scrydexCacheCaptureUnits } from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import { runScrydexOptionRefresh } from "./catalog-staging-scrydex-option-refresh.mjs";
import {
  classifyScrydexOptionRefreshRequest,
  evaluateScrydexUsagePreflight,
  providerPagesUpperBound,
  validateScrydexOptionRefreshReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-option-refresh.ts";

const sha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const profileSources = scrydexCacheCaptureUnits.map(() => ({
  supportedScopes: ["set-name"],
  optionQueries: [
    {
      queryKind: "sets",
      queryKeySynonyms: ["set"],
      displayName: "Set",
      scope: "set-name",
      parentScope: null,
    },
  ],
}));

function profiles() {
  return scrydexCacheCaptureUnits.map((unit, index) => {
    const source = profileSources[index];
    return {
      providerKey: "scrydex",
      profileKey: `profile-${index}`,
      profileVersion: index < 3 ? "2026.06.22" : "2026.06.23",
      ingestionUnitKey: unit.unitKey,
      active: true,
      languageOptions: ["en"],
      supportedScopes: [...source.supportedScopes],
      sourceOptionKinds: source.optionQueries.map((query) => ({
        queryKind: query.queryKind,
        queryKeySynonyms: "queryKeySynonyms" in query ? [...(query.queryKeySynonyms ?? [])] : [],
        displayName: query.displayName,
        scope: query.scope,
        parentScope: query.parentScope,
        parentRequired: "parentValue" in query ? Boolean(query.parentValue?.required) : false,
        parentValueKind: "parentValue" in query ? (query.parentValue?.valueKind ?? null) : null,
        parentDiagnosticText: "parentValue" in query ? (query.parentValue?.diagnosticText ?? null) : null,
      })),
    };
  });
}

function responseBody(total = 0) {
  return {
    status: 200,
    body: {
      total,
      cache: {
        status: "live",
        source: "live",
        fetchedAt: "2026-10-21T00:00:00.000Z",
        expiresAt: "2026-10-21T00:15:00.000Z",
        staleUntil: "2026-10-22T00:00:00.000Z",
      },
    },
  };
}

function runnerInput(overrides = {}) {
  const forcedReads = [];
  return {
    runner: {
      sha,
      runId: "1",
      runAttempt: "1",
      journeyScope: "scrydex-force-refresh-bounded",
      origin: "admin.staging.chasesets.com",
    },
    now: () => "2026-10-21T00:00:00.000Z",
    selectDeployment: async () => ({ deployedHead: sha, imageDigest }),
    signIn: async () => {},
    read: async (path) => {
      if (path.includes("integration-control-plane"))
        return {
          providerReadiness: {
            providers: [
              {
                providerKey: "scrydex",
                readiness: "ready",
                usageBudget: {
                  readiness: "ready",
                  freshness: "fresh",
                  creditBalance: 4000,
                  creditAllowance: 5000,
                  observedAt: "2026-10-21T00:00:00.000Z",
                },
              },
            ],
          },
          providerSendWindow: { state: "disabled" },
          readiness: { rolloutControls: { controls: [] } },
        };
      if (path.includes("provider-profiles")) return { items: profiles(), total: 5, count: 5 };
      forcedReads.push(path);
      return responseBody();
    },
    forcedReads,
    ...overrides,
  };
}

it("runs five injected route-shaped profile reads and five bounded option reads", async () => {
  const input = runnerInput();
  const receipt = await runScrydexOptionRefresh(input);
  expect(receipt.outcome).toBe("complete");
  expect(receipt.requests).toEqual({ forced: 5, refusals: 0 });
  expect(input.forcedReads).toHaveLength(5);
  expect(
    input.forcedReads.every(
      (path) => new URL(path, "https://admin.staging.chasesets.com").searchParams.get("limit") === "100",
    ),
  ).toBe(true);
  expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
});

it("stops on the first uncertain response and leaves remaining units unattempted", async () => {
  let reads = 0;
  const input = runnerInput({
    read: async (path) => {
      if (path.includes("integration-control-plane")) return runnerInput().read(path);
      if (path.includes("provider-profiles")) return { items: profiles(), total: 5, count: 5 };
      reads += 1;
      return reads === 1 ? { status: 500, body: null } : responseBody();
    },
  });
  const receipt = await runScrydexOptionRefresh(input);
  expect(receipt.outcome).toBe("stopped");
  expect(receipt.units.filter((unit) => unit.status === "not-attempted")).toHaveLength(4);
  expect(receipt.units[0]).toMatchObject({ status: "uncertain", total: null, providerPagesUpperBound: null });
  expect(receipt.creditsSpentUpperBound).toBe(1);
  expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
});

it("treats an over-cap response as uncertain without reading another unit", async () => {
  const input = runnerInput({
    read: async (path) => {
      if (path.includes("integration-control-plane")) return runnerInput().read(path);
      if (path.includes("provider-profiles")) return { items: profiles(), total: 5, count: 5 };
      input.readCount = (input.readCount ?? 0) + 1;
      return { status: 200, body: null, overCap: true };
    },
    readCount: 0,
  });
  const receipt = await runScrydexOptionRefresh(input);
  expect(receipt.outcome).toBe("stopped");
  expect(input.readCount).toBe(1);
  expect(receipt.units[0]).toMatchObject({ status: "uncertain", total: null, providerPagesUpperBound: null });
  expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
});

describe("hosted Scrydex option refresh contract", () => {
  it("uses the bounded page arithmetic", () => {
    expect([0, 100, 101].map(providerPagesUpperBound)).toEqual([2, 2, 3]);
    expect(providerPagesUpperBound(1001)).toBeNull();
  });

  it("refuses usage until the provider is fresh, ready and funded", () => {
    expect(
      evaluateScrydexUsagePreflight({
        providerKey: "scrydex",
        usageBudget: { readiness: "ready", freshness: "stale", creditBalance: 5000, creditAllowance: 5000 },
      }),
    ).toMatchObject({ admitted: false, reason: "usage-stale:stale" });
    expect(
      evaluateScrydexUsagePreflight({
        providerKey: "scrydex",
        usageBudget: { readiness: "ready", freshness: "fresh", creditBalance: 5000, creditAllowance: 5000 },
      }),
    ).toMatchObject({ admitted: true });
  });

  it("fences cursor, cache-only and non-Scrydex requests", () => {
    const href =
      "https://admin.staging.chasesets.com/api/catalog/source-observations/integration-options?providerKey=scrydex&profileKey=p&profileVersion=v&ingestionUnitKey=scrydex:one-piece:set:reference-data&queryKind=sets&limit=100&forceRefresh=true";
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: href }).allowed).toBe(true);
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: `${href}&cursor=offset:1` }).allowed).toBe(false);
    expect(
      classifyScrydexOptionRefreshRequest({
        method: "GET",
        url: href.replace("providerKey=scrydex", "providerKey=tcgdex"),
      }).allowed,
    ).toBe(false);
  });
});
