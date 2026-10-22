import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scrydexCacheCaptureUnits } from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import {
  applyScrydexOptionRefreshRouteFence,
  runScrydexOptionRefresh,
  writeRefreshArtifact,
} from "./catalog-staging-scrydex-option-refresh.mjs";
import {
  classifyScrydexOptionRefreshRequest,
  evaluateScrydexUsagePreflight,
  providerPagesUpperBound,
  scrydexOptionRefreshArtifactPath,
  scrydexOptionRefreshDiagnosticArtifactPath,
  scrydexOptionRefreshMaxBytes,
  validateScrydexOptionRefreshReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-option-refresh.ts";

const temporaryWorkspaces = [];

afterEach(async () => {
  await Promise.all(temporaryWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

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

async function temporaryWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), "scrydex-option-refresh-test-"));
  temporaryWorkspaces.push(workspace);
  return workspace;
}

async function completeReceipt() {
  return runScrydexOptionRefresh(runnerInput());
}

async function stoppedReceipt() {
  return runScrydexOptionRefresh(
    runnerInput({
      read: async (path) => {
        if (path.includes("integration-control-plane")) return runnerInput().read(path);
        if (path.includes("provider-profiles")) return { items: profiles(), total: 5, count: 5 };
        return { status: 500, body: null };
      },
    }),
  );
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

describe("refresh artifact contract", () => {
  it("writes a valid complete receipt to the complete artifact path", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await completeReceipt();
    const artifact = await writeRefreshArtifact(receipt, {}, workspace);

    expect(artifact.path).toBe(join(workspace, scrydexOptionRefreshArtifactPath));
    expect(JSON.parse(await readFile(artifact.path, "utf8"))).toEqual(receipt);
  });

  it("writes a valid stopped receipt to the diagnostic artifact path", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await stoppedReceipt();
    const artifact = await writeRefreshArtifact(receipt, {}, workspace);

    expect(artifact.path).toBe(join(workspace, scrydexOptionRefreshDiagnosticArtifactPath));
    expect(JSON.parse(await readFile(artifact.path, "utf8"))).toEqual(receipt);
  });

  it("rejects invalid evidence and injected credential values", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await completeReceipt();
    const invalidReceipt = { ...receipt, requests: { ...receipt.requests, forced: 4 } };

    await expect(writeRefreshArtifact(invalidReceipt, {}, workspace)).rejects.toThrow(
      "scrydex-option-refresh-refused:receipt-invalid",
    );

    const credentialReceipt = { ...receipt, assumptions: [...receipt.assumptions, "synthetic-secret"] };
    await expect(writeRefreshArtifact(credentialReceipt, { GH_TOKEN: "synthetic-secret" }, workspace)).rejects.toThrow(
      "scrydex-option-refresh-refused:receipt-invalid",
    );
  });

  it("rejects a serialized receipt over the byte cap", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await completeReceipt();
    Object.defineProperty(receipt, "toJSON", {
      value: () => "x".repeat(scrydexOptionRefreshMaxBytes + 1),
      enumerable: false,
    });

    await expect(writeRefreshArtifact(receipt, {}, workspace)).rejects.toThrow(
      "scrydex-option-refresh-refused:receipt-invalid",
    );
  });

  it("refuses a non-empty target artifact directory", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await completeReceipt();
    const targetDirectory = join(workspace, "artifacts/catalog-scrydex-option-refresh");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "placeholder"), "not the artifact");

    await expect(writeRefreshArtifact(receipt, {}, workspace)).rejects.toThrow(
      "scrydex-option-refresh-refused:artifact-directory-not-empty",
    );
  });
});

describe("hosted Scrydex option refresh contract", () => {
  it("fences refresh routes to the two preflights and five forced reads", () => {
    const overview =
      "https://admin.staging.chasesets.com/api/catalog/source-observations/integration-control-plane/overview?audience=daily";
    const profiles = "https://admin.staging.chasesets.com/api/catalog/source-observations/provider-profiles";
    const forced = scrydexCacheCaptureUnits.map(
      ({ unitKey }, index) =>
        `https://admin.staging.chasesets.com/api/catalog/source-observations/integration-options?providerKey=scrydex&profileKey=p${index}&profileVersion=v&ingestionUnitKey=${encodeURIComponent(unitKey)}&queryKind=sets&limit=100&forceRefresh=true`,
    );
    const requests = [
      { method: "GET", url: overview },
      { method: "GET", url: profiles },
      ...forced.map((url) => ({ method: "GET", url })),
    ];
    const routeOutcomes = requests.map((request) => {
      const calls = [];
      applyScrydexOptionRefreshRouteFence(
        {
          request: () => ({ method: () => request.method, url: () => request.url }),
          abort: (reason) => calls.push(["abort", reason]),
          continue: () => calls.push(["continue"]),
        },
        "refresh",
      );
      return calls[0][0];
    });
    expect(routeOutcomes).toEqual(["continue", "continue", "continue", "continue", "continue", "continue", "continue"]);
    const rejected = [];
    applyScrydexOptionRefreshRouteFence(
      {
        request: () => ({
          method: () => "POST",
          url: () => "https://admin.staging.chasesets.com/api/catalog/source-observations/provider-transport",
        }),
        abort: (reason) => rejected.push(["abort", reason]),
        continue: () => rejected.push(["continue"]),
      },
      "refresh",
    );
    expect(rejected).toEqual([["abort", "blockedbyclient"]]);
  });

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
