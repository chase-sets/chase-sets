import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProducer,
  coordinatePreviewRunnerIdentity,
  createCoordinatePreviewRouteHandler,
  emptyCoordinatePreviewTally,
  finalCoordinatePreviewReceipt,
  readCoordinatePreviewResponseInPage,
  selectCoordinatePreviewDeployment,
  validateCoordinatePreviewUpload,
  writeCoordinatePreviewArtifact,
} from "./catalog-staging-scrydex-coordinate-preview.mjs";
import {
  mergeObservedCoordinatePreviewReceipt,
  runScrydexCoordinatePreview,
} from "../bounded-contexts/catalog/features/scope-sync-batches/api/scrydex-coordinate-preview-runner.ts";
import {
  scrydexCoordinatePreviewPhases,
  validateScrydexCoordinatePreviewReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-coordinate-preview.ts";
import {
  scrydexCacheCaptureCoordinate,
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureUnits,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const runnerEnv = (overrides = {}) => ({
  GITHUB_ACTIONS: "true",
  ADMIN_WEB_URL: scrydexCacheCaptureOrigin,
  GITHUB_SHA: "a".repeat(40),
  EXPECTED_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "123456",
  GITHUB_RUN_ATTEMPT: "1",
  CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scrydex-coordinate-preview",
  RUNNER_TEMP: join(tmpdir(), `scrydex-coordinate-preview-runner-${Math.random().toString(16).slice(2)}`),
  CATALOG_ADMIN_E2E_EMAIL: "synthetic-coordinate-admin@example.invalid",
  CATALOG_ADMIN_E2E_PASSWORD: "synthetic-coordinate-password-marker",
  GH_TOKEN: "synthetic-coordinate-actions-token",
  ...overrides,
});

const profileItems = scrydexCacheCaptureUnits.map((unit, index) => ({
  providerKey: "scrydex",
  profileKey: `profile-${index + 1}`,
  profileVersion: `2026.10.${index + 1}`,
  ingestionUnitKey: unit.unitKey,
  active: true,
  languageOptions: ["en"],
  supportedScopes: ["set-name"],
  sourceOptionKinds: [
    {
      queryKind: "sets",
      queryKeySynonyms: ["set"],
      displayName: "Set",
      scope: "set-name",
      parentScope: null,
      parentRequired: false,
      parentValueKind: null,
      parentDiagnosticText: null,
    },
  ],
}));

const generation = {
  runId: "9000000001",
  runAttempt: 1,
  jobId: "9000000002",
  jobCompletedAt: "2026-10-20T15:00:00.000Z",
  deployedHead: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
};

const testRunner = {
  sha: "a".repeat(40),
  runId: "123456",
  runAttempt: "1",
  journeyScope: "scrydex-coordinate-preview",
  origin: "admin.staging.chasesets.com",
};

function optionBody(unitKey, value) {
  return {
    items: [{ providerKey: "scrydex", queryKind: "sets", value }],
    total: 1,
    count: 1,
    page: { cursor: null, nextCursor: null, limit: 25, hasMore: false },
    cache: {
      status: "fresh",
      source: "cache",
      cacheKey: `sha256:${unitKey.length.toString(16).padStart(2, "0")}${"c".repeat(62)}`,
      fetchedAt: "2026-10-24T08:00:00.000Z",
      expiresAt: "2026-10-24T09:00:00.000Z",
      staleUntil: "2026-10-25T09:00:00.000Z",
      cacheOnly: true,
      forceRefresh: false,
    },
  };
}

function mapping(scopeRecordId, unitKey, index, setName) {
  return {
    mappingId: `mapping-${index}`,
    scopeRecordId,
    providerKey: "scrydex",
    unitKey,
    reviewStatus: "accepted",
    updatedAt: "2026-10-24T08:00:00.000Z",
    coordinates: { setId: null, setName },
  };
}

function previewBody() {
  const onePiece = "scope-one-piece";
  const lorcana = "scope-lorcana";
  return {
    previewVersion: "scope-sync-batch-preview-v1",
    selection: { mode: "ids", scopeRecordIds: [lorcana, onePiece] },
    budget: {
      maxScopesPerTurn: 1,
      defaultProviderConcurrency: 1,
      providerConcurrency: {},
      providerRequestLimits: {},
      creditedProviderRequestLimits: { scrydex: 0 },
      providerFailureThreshold: 3,
    },
    planFingerprint: "d".repeat(64),
    status: "blocked",
    confirmAllowed: false,
    counts: { scopes: 2, readyScopes: 0, blockedScopes: 2, providerUnits: 5 },
    providerUnitTotals: { scrydex: 5 },
    providerRequestEstimates: { scrydex: null },
    samples: [onePiece, lorcana].map((scopeRecordId) => ({
      scopeRecordId,
      providerUnitCount: scopeRecordId === onePiece ? 3 : 2,
      blockerCount: 1,
      estimatedRequestCount: null,
      providerKeys: ["scrydex"],
      mappingVersions: scrydexCacheCaptureUnits
        .filter((unit) =>
          scopeRecordId === onePiece ? unit.productDomain === "one-piece" : unit.productDomain === "lorcana",
        )
        .map((unit) => ({
          mappingId: `mapping-${scrydexCacheCaptureUnits.indexOf(unit) + 1}`,
          version: "2026-10-24T08:00:00.000Z",
          reviewStatus: "accepted",
        })),
      profileVersions: scrydexCacheCaptureUnits
        .filter((unit) =>
          scopeRecordId === onePiece ? unit.productDomain === "one-piece" : unit.productDomain === "lorcana",
        )
        .map((unit, index) => ({
          providerKey: "scrydex",
          unitKey: unit.unitKey,
          profileKey: `profile-${scrydexCacheCaptureUnits.indexOf(unit) + 1}`,
          profileVersion: `2026.10.${scrydexCacheCaptureUnits.indexOf(unit) + 1}`,
        })),
    })),
    blockers: [
      {
        code: "credited-provider-estimate-unavailable",
        scopeRecordId: null,
        providerKey: "scrydex",
        message: "scrydex request or credit evidence is unavailable; confirmation is closed.",
      },
    ],
    resolvedAt: "2026-10-24T08:30:00.000Z",
  };
}

function fakeProducerPage({ mutateBody = false } = {}) {
  const calls = [];
  const preview = previewBody();
  const page = {
    calls,
    async evaluate(_fn, input) {
      calls.push(input);
      const path = input.path;
      if (path.includes("provider-profiles"))
        return { status: 200, text: JSON.stringify({ items: profileItems, total: 5, count: 5 }) };
      if (path.includes("integration-control-plane/overview"))
        return {
          status: 200,
          text: JSON.stringify({
            providerReadiness: {
              providers: [{ providerKey: "scrydex", usageBudget: { readiness: "ready" } }],
            },
          }),
        };
      if (path.includes("scope-records")) {
        const productDomain = new URL(`https://example.invalid${path}`).searchParams.get("productDomain");
        const scopeRecordId = productDomain === "one-piece" ? "scope-one-piece" : "scope-lorcana";
        return {
          status: 200,
          text: JSON.stringify({
            items: [{ scopeRecordId, productDomain, scopeKind: "set", lifecycleStatus: "active" }],
            total: 1,
            count: 1,
          }),
        };
      }
      if (path.includes("provider-scope-mappings/coverage")) {
        const scopeRecordId = decodeURIComponent(path.split("/").at(-1));
        const isOnePiece = scopeRecordId === "scope-one-piece";
        const units = scrydexCacheCaptureUnits.filter((unit) =>
          isOnePiece ? unit.productDomain === "one-piece" : unit.productDomain === "lorcana",
        );
        return {
          status: 200,
          text: JSON.stringify({
            schemaVersion: "catalog-scope-coverage-v1",
            scopeRecordId,
            productDomain: isOnePiece ? "one-piece" : "lorcana",
            providers: [
              {
                providerKey: "scrydex",
                acceptedMappings: units.map((unit, index) =>
                  mapping(
                    scopeRecordId,
                    unit.unitKey,
                    scrydexCacheCaptureUnits.indexOf(unit) + 1,
                    isOnePiece ? "One Piece Set" : "Lorcana Set",
                  ),
                ),
              },
            ],
          }),
        };
      }
      if (path.includes("integration-options")) {
        const unitKey = new URL(`https://example.invalid${path}`).searchParams.get("ingestionUnitKey");
        return {
          status: 200,
          text: JSON.stringify(optionBody(unitKey, unitKey.includes("lorcana") ? "Lorcana Set" : "One Piece Set")),
        };
      }
      if (path === "/api/catalog/scope-sync-batches/preview") {
        expect(input.method).toBe("POST");
        expect(input.body).toEqual({
          selection: { mode: "ids", scopeRecordIds: ["scope-one-piece", "scope-lorcana"] },
        });
        return {
          status: 200,
          text: JSON.stringify(
            mutateBody ? { ...preview, selection: { mode: "ids", scopeRecordIds: ["wrong"] } } : preview,
          ),
        };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  return page;
}

describe("deployment *", () => {
  it("identity: binds the reviewed head and required runner fields", () => {
    expect(coordinatePreviewRunnerIdentity(runnerEnv())).toEqual({
      sha: "a".repeat(40),
      runId: "123456",
      runAttempt: "1",
      journeyScope: "scrydex-coordinate-preview",
      origin: "admin.staging.chasesets.com",
    });
    expect(() => coordinatePreviewRunnerIdentity(runnerEnv({ EXPECTED_SHA: "b".repeat(40) }))).toThrow(
      "runner-identity",
    );
  });

  it("stop: passes a value-free deployment stop through", async () => {
    await expect(
      selectCoordinatePreviewDeployment(
        "synthetic-token",
        vi.fn(async () => ({ stop: "deploy-in-progress", deployment: null, deployGeneration: null })),
      ),
    ).resolves.toEqual({ generation: null, stop: "deploy-in-progress" });
  });

  it("image-joined: binds the deployment image to the six generation fields", async () => {
    await expect(
      selectCoordinatePreviewDeployment(
        "synthetic-token",
        vi.fn(async () => ({
          stop: null,
          deployGeneration: { ...generation, imageDigest: undefined },
          deployment: { imageDigest: generation.imageDigest },
        })),
      ),
    ).resolves.toEqual({ generation, stop: null });
  });

  it("deployment-missing: refuses a generation without its deployment image", async () => {
    await expect(
      selectCoordinatePreviewDeployment(
        "synthetic-token",
        vi.fn(async () => ({ stop: null, deployGeneration: generation, deployment: null })),
      ),
    ).resolves.toEqual({ generation: null, stop: "selection-failed" });
  });

  it("selection-failed: normalizes an invalid selection to a value-free stop", async () => {
    await expect(
      selectCoordinatePreviewDeployment(
        "synthetic-token",
        vi.fn(async () => ({ stop: null, deployment: null, deployGeneration: null })),
      ),
    ).resolves.toEqual({ generation: null, stop: "selection-failed" });
  });
});

describe("producer *", () => {
  it("tally-required: refuses a producer without the live fence tally", () => {
    expect(() => buildProducer({ page: fakeProducerPage() })).toThrow("coordinate-preview-tally-required");
  });

  it("five-rows: reads executable options and posts the exact two-ID selection", async () => {
    const page = fakeProducerPage();
    const tally = emptyCoordinatePreviewTally();
    const observed = await buildProducer({ page, tally })();
    expect(observed.rows).toHaveLength(5);
    expect(observed.preview.selection.scopeRecordIds).toEqual(["scope-lorcana", "scope-one-piece"]);
    expect(page.calls.find((input) => input.path === "/api/catalog/scope-sync-batches/preview").body).toEqual({
      selection: { mode: "ids", scopeRecordIds: ["scope-one-piece", "scope-lorcana"] },
    });
  });

  it("option-page-malformed: refuses a producer response that cannot decode", async () => {
    const page = fakeProducerPage();
    page.evaluate = async (_fn, input) =>
      input.path.includes("provider-profiles")
        ? { status: 200, text: JSON.stringify({ items: [], total: 1, count: 1 }) }
        : { status: 500, text: "" };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow("profiles-malformed");
  });

  it("option-live-read: refuses a live cache source", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options")) {
        const body = JSON.parse(result.text);
        body.cache.source = "live";
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow("option-live-read");
  });

  it("cache-stale:unit: retains a stale cache row only while its stale-until bound is open", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options")) {
        const body = JSON.parse(result.text);
        body.cache.status = "stale";
        result.text = JSON.stringify(body);
      }
      return result;
    };
    const observed = await buildProducer({ page, tally: emptyCoordinatePreviewTally() })();
    expect(observed.rows.every((row) => row.cache.status === "stale")).toBe(true);
  });

  it("bracket-changed: refuses a changed coverage mapping between readiness and pre-confirm", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    let coverageReads = 0;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("provider-scope-mappings/coverage")) {
        coverageReads += 1;
        if (coverageReads > 2) {
          const body = JSON.parse(result.text);
          body.providers[0].acceptedMappings[0].updatedAt = "2026-10-24T08:01:00.000Z";
          result.text = JSON.stringify(body);
        }
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(/^bracket-changed$/);
    await expect(
      runScrydexCoordinatePreview({
        runner: testRunner,
        credentialsPresent: true,
        selectDeployment: async () => ({ generation, stop: null }),
        signIn: async () => undefined,
        produce: async () => {
          throw new Error("bracket-changed");
        },
        now: () => "2026-10-24T08:00:00.000Z",
      }),
    ).resolves.toMatchObject({ reasons: expect.arrayContaining(["producer-failed:bracket-changed"]) });
  });

  it("setName-coordinate: uses the planner's setName fallback when setId is null", () => {
    expect(
      scrydexCacheCaptureCoordinate(
        {
          mappingId: "mapping-set-name",
          unitKey: scrydexCacheCaptureUnits[0].unitKey,
          reviewStatus: "accepted",
          version: "2026-10-24T08:00:00.000Z",
          setId: null,
          setName: "Synthetic Set",
        },
        "scope-one-piece",
      ),
    ).toBe("Synthetic Set");
  });

  it("setName-coordinate: producer rows use the planner's setName fallback", async () => {
    const page = fakeProducerPage();
    const observed = await buildProducer({ page, tally: emptyCoordinatePreviewTally() })();
    expect(observed.rows.find((row) => row.mapping.setId === null)?.coordinate).toBe("One Piece Set");
  });

  it("bracket-changed:unit: refuses a changed second-pass cache snapshot", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    let optionReads = 0;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options")) {
        optionReads += 1;
        if (optionReads > 5) {
          const body = JSON.parse(result.text);
          body.cache.cacheKey = `sha256:${"d".repeat(64)}`;
          result.text = JSON.stringify(body);
        }
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(/^bracket-changed$/);
  });

  it("cache-cursor-stalled:unit: refuses a repeated continuation cursor", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options")) {
        const body = JSON.parse(result.text);
        body.page.cursor = input.path.includes("cursor=offset%3A1") ? "offset:1" : null;
        body.page.nextCursor = "offset:1";
        body.page.hasMore = true;
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(
      "cache-cursor-stalled",
    );
  });

  it("cache-incomplete:unit: refuses a truncated inventory tail", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("scope-records")) {
        const body = JSON.parse(result.text);
        body.total = 2;
        if (input.path.includes("offset=1")) {
          body.items = [];
          body.count = 0;
        }
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(
      "scope-inventory-truncated",
    );
  });

  it("cache-incomplete:unit: refuses an option continuation with a truncated total", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options")) {
        const body = JSON.parse(result.text);
        body.total = 7;
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow("cache-incomplete");
  });

  it("cache-continuation-cap: refuses more than the bounded option pages", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options")) {
        const match = input.path.match(/cursor=offset%3A(\d+)/);
        const index = match ? Number(match[1]) : 0;
        const body = JSON.parse(result.text);
        body.total = 101;
        body.page = {
          cursor: index === 0 ? null : `offset:${index}`,
          nextCursor: index >= 100 ? null : `offset:${index + 1}`,
          limit: 25,
          hasMore: index < 100,
        };
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(
      "option-continuation-cap",
    );
  });

  it("scope-inventory-changed: refuses a total that changes across pages", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("scope-records") && input.path.includes("one-piece")) {
        const body = JSON.parse(result.text);
        body.total = input.path.includes("offset=1") ? 3 : 2;
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(
      "scope-inventory-changed",
    );
  });

  it("continuation: reads the same cache identity across a bounded second page", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    let first = true;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options") && first) {
        first = false;
        const body = JSON.parse(result.text);
        body.total = 2;
        body.page.nextCursor = "offset:1";
        body.page.hasMore = true;
        result.text = JSON.stringify(body);
      } else if (input.path.includes("integration-options") && input.path.includes("cursor=offset%3A1")) {
        const body = JSON.parse(result.text);
        body.total = 2;
        body.page = { cursor: "offset:1", nextCursor: null, limit: 25, hasMore: false };
        body.items = [{ providerKey: "scrydex", queryKind: "sets", value: "Other Set" }];
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).resolves.toMatchObject({
      rows: expect.any(Array),
    });
  });

  it("cache-identity-changed:unit: refuses a continuation page whose cache identity differs", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    let first = true;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options") && first) {
        first = false;
        const body = JSON.parse(result.text);
        body.total = 2;
        body.page.nextCursor = "offset:1";
        body.page.hasMore = true;
        result.text = JSON.stringify(body);
      } else if (input.path.includes("integration-options") && input.path.includes("cursor=offset%3A1")) {
        const body = JSON.parse(result.text);
        body.total = 2;
        body.page = { cursor: "offset:1", nextCursor: null, limit: 25, hasMore: false };
        body.items = [{ providerKey: "scrydex", queryKind: "sets", value: "Other Set" }];
        body.cache.cacheKey = `sha256:${"e".repeat(64)}`;
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(
      /^cache-identity-changed-scrydex-/,
    );
  });

  it("cache-identity-changed:unit: refuses a continuation page whose total differs", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    let first = true;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("integration-options") && first) {
        first = false;
        const body = JSON.parse(result.text);
        body.total = 2;
        body.page.nextCursor = "offset:1";
        body.page.hasMore = true;
        result.text = JSON.stringify(body);
      } else if (input.path.includes("integration-options") && input.path.includes("cursor=offset%3A1")) {
        const body = JSON.parse(result.text);
        body.total = 3;
        body.page = { cursor: "offset:1", nextCursor: null, limit: 25, hasMore: false };
        body.items = [{ providerKey: "scrydex", queryKind: "sets", value: "Other Set" }];
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(
      /^cache-identity-changed-/,
    );
  });

  it("second-scope: skips an incomplete first candidate before selecting the second", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      if (input.path.endsWith("scope-lorcana-a")) {
        return {
          status: 200,
          text: JSON.stringify({
            schemaVersion: "catalog-scope-coverage-v1",
            scopeRecordId: "scope-lorcana-a",
            productDomain: "lorcana",
            providers: [{ providerKey: "scrydex", acceptedMappings: [] }],
          }),
        };
      }
      const result = await evaluate(fn, input);
      if (input.path.includes("scope-records") && input.path.includes("lorcana")) {
        const body = JSON.parse(result.text);
        body.items = [{ ...body.items[0], scopeRecordId: "scope-lorcana-a" }, body.items[0]];
        body.total = 2;
        body.count = 2;
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).resolves.toMatchObject({
      rows: expect.any(Array),
    });
  });

  it("second-scope: refuses when one product domain has no fully mapped scope", async () => {
    const page = fakeProducerPage();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, input) => {
      const result = await evaluate(fn, input);
      if (input.path.includes("scope-records") && input.path.includes("lorcana")) {
        const body = JSON.parse(result.text);
        body.items = [];
        body.total = 0;
        body.count = 0;
        result.text = JSON.stringify(body);
      }
      return result;
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally() })()).rejects.toThrow(
      "two-scopes-unavailable",
    );
  });

  it("read-timeout: bounds a never-settling body", async () => {
    await expect(
      readCoordinatePreviewResponseInPage({
        path: "/api/hang",
        deadlineMs: 5,
        fetchImpl: (_path, init) =>
          new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      }),
    ).rejects.toThrow();
  });

  it("read-timeout: normalizes a never-settling body in the producer", async () => {
    const page = {
      async evaluate(fn, input) {
        return fn({
          ...input,
          fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
        });
      },
    };
    await expect(buildProducer({ page, tally: emptyCoordinatePreviewTally(), readDeadlineMs: 50 })()).rejects.toThrow(
      /^read-timeout$/,
    );
  });

  it("deadline-threaded: forwards the deadline to every producer read", async () => {
    const page = fakeProducerPage();
    await buildProducer({ page, tally: emptyCoordinatePreviewTally(), readDeadlineMs: 50 })();
    expect(page.calls.length).toBeGreaterThan(0);
    expect(page.calls.every((input) => input.deadlineMs === 50)).toBe(true);
  });

  it("usage-readiness: accepts only the overview provider readiness shape", async () => {
    const readyPage = fakeProducerPage();
    const ready = await buildProducer({ page: readyPage, tally: emptyCoordinatePreviewTally() })();
    expect(ready.usageRead.allowed).toBe(true);

    for (const usageBody of [
      { allowed: true },
      { providerReadiness: { providers: [{ providerKey: "scrydex", usageBudget: { readiness: "unknown" } }] } },
    ]) {
      const page = fakeProducerPage();
      const evaluate = page.evaluate;
      page.evaluate = async (fn, input) => {
        const result = await evaluate(fn, input);
        if (input.path.includes("integration-control-plane/overview")) result.text = JSON.stringify(usageBody);
        return result;
      };
      const observed = await buildProducer({ page, tally: emptyCoordinatePreviewTally() })();
      expect(observed.usageRead.allowed).toBe(false);
    }
  });

  it("phases: keeps readiness, preview, and immediate pre-confirm reads ordered", async () => {
    const observed = await buildProducer({ page: fakeProducerPage(), tally: emptyCoordinatePreviewTally() })();
    expect(observed.phases).toEqual([...scrydexCoordinatePreviewPhases]);
  });
});

describe("fence *", () => {
  function routeFor({ method, url, navigation = false }) {
    return {
      request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => navigation }),
      fetch: vi.fn(async () => ({ headers: () => ({}) })),
      fulfill: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
  }

  it("isolation-fulfilled: fulfills one script-free isolation document and never fetches it", async () => {
    const tally = emptyCoordinatePreviewTally();
    const route = routeFor({
      method: "GET",
      url: `${scrydexCacheCaptureOrigin}/__scrydex-coordinate-preview-isolation`,
      navigation: true,
    });
    await createCoordinatePreviewRouteHandler({ phase: "sign-in", tally })(route);
    expect(route.fetch).not.toHaveBeenCalled();
    expect(route.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, body: expect.stringContaining("doctype") }),
    );
    expect(tally.requests.signIn).toBe(1);
  });

  it("ambient-api: aborts and counts an unlisted API read", async () => {
    const tally = emptyCoordinatePreviewTally();
    const route = routeFor({ method: "GET", url: `${scrydexCacheCaptureOrigin}/api/catalog/not-allowed` });
    await createCoordinatePreviewRouteHandler({ phase: "capture", tally })(route);
    expect(route.abort).toHaveBeenCalled();
    expect(tally.requests.forbidden).toBe(1);
  });

  it("static-asset: aborts an Admin bundle request after isolation", async () => {
    const tally = emptyCoordinatePreviewTally();
    const route = routeFor({ method: "GET", url: `${scrydexCacheCaptureOrigin}/assets/app.js` });
    await createCoordinatePreviewRouteHandler({ phase: "capture", tally })(route);
    expect(route.abort).toHaveBeenCalled();
    expect(tally.requests.forbidden).toBe(1);
  });

  it("complete: allows the bounded preview and usage classes once", async () => {
    const tally = emptyCoordinatePreviewTally();
    const handler = createCoordinatePreviewRouteHandler({ phase: "capture", tally });
    const preview = routeFor({
      method: "POST",
      url: `${scrydexCacheCaptureOrigin}/api/catalog/scope-sync-batches/preview`,
    });
    const usage = routeFor({
      method: "GET",
      url: `${scrydexCacheCaptureOrigin}/api/catalog/source-observations/integration-control-plane/overview?audience=daily`,
    });
    await handler(preview);
    await handler(usage);
    expect(tally.requests.previewPosts).toBe(1);
    expect(tally.requests.usageReads).toBe(1);
    expect(tally.requests.forbidden).toBe(0);
  });

  it("duplicate-usage-read: refuses a second usage readiness read", async () => {
    const tally = emptyCoordinatePreviewTally();
    const handler = createCoordinatePreviewRouteHandler({ phase: "capture", tally });
    const request = () =>
      routeFor({
        method: "GET",
        url: `${scrydexCacheCaptureOrigin}/api/catalog/source-observations/integration-control-plane/overview?audience=daily`,
      });
    await handler(request());
    await handler(request());
    expect(tally.requests.usageReads).toBe(1);
    expect(tally.requests.forbidden).toBe(1);
  });

  it("duplicate-preview: refuses a second preview POST", async () => {
    const tally = emptyCoordinatePreviewTally();
    const handler = createCoordinatePreviewRouteHandler({ phase: "capture", tally });
    const first = routeFor({
      method: "POST",
      url: `${scrydexCacheCaptureOrigin}/api/catalog/scope-sync-batches/preview`,
    });
    const second = routeFor({
      method: "POST",
      url: `${scrydexCacheCaptureOrigin}/api/catalog/scope-sync-batches/preview`,
    });
    await handler(first);
    await handler(second);
    expect(tally.requests.previewPosts).toBe(1);
    expect(tally.requests.forbidden).toBe(1);
  });

  it("refused: blocks mutation, cross-origin, and TCGplayer requests", async () => {
    for (const url of [
      `${scrydexCacheCaptureOrigin}/api/catalog/scope-sync-batches/preview`,
      "https://example.invalid/api/catalog/scope-sync-batches/preview",
      `${scrydexCacheCaptureOrigin}/tcgplayer/sets`,
    ]) {
      const tally = emptyCoordinatePreviewTally();
      const method = url.includes("preview") ? "PATCH" : "GET";
      const route = routeFor({ method, url });
      await createCoordinatePreviewRouteHandler({ phase: "capture", tally })(route);
      expect(tally.requests.forbidden).toBe(1);
    }
  });

  it("cross-origin-redirect: refuses a redirect before it leaves the fence", async () => {
    const tally = emptyCoordinatePreviewTally();
    const route = routeFor({
      method: "GET",
      url: `${scrydexCacheCaptureOrigin}/api/catalog/source-observations/provider-profiles`,
    });
    route.fetch = vi.fn(async () => ({ headers: () => ({ location: "https://example.invalid/redirect" }) }));
    await createCoordinatePreviewRouteHandler({ phase: "capture", tally })(route);
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(tally.forbiddenCalls[0]).toContain(
      "cross-origin-redirect:GET:-api-catalog-source-observations-provider-profiles",
    );
  });

  it("request-failed: records a failed allowed fetch as a refusal", async () => {
    const tally = emptyCoordinatePreviewTally();
    const route = routeFor({
      method: "GET",
      url: `${scrydexCacheCaptureOrigin}/api/catalog/source-observations/provider-profiles`,
    });
    route.fetch = vi.fn(async () => {
      throw new Error("synthetic transport failure");
    });
    await createCoordinatePreviewRouteHandler({ phase: "capture", tally })(route);
    expect(route.abort).toHaveBeenCalledWith("failed");
    expect(tally.requests.forbidden).toBe(1);
  });
});

describe("artifact *", () => {
  const runner = {
    sha: "a".repeat(40),
    runId: "123456",
    runAttempt: "1",
    journeyScope: "scrydex-coordinate-preview",
    origin: "admin.staging.chasesets.com",
  };
  const receipt = () => {
    const rows = scrydexCacheCaptureUnits.map((unit, index) => {
      const onePiece = unit.productDomain === "one-piece";
      const scopeRecordId = onePiece ? "scope-one-piece" : "scope-lorcana";
      const setName = onePiece ? "One Piece Set" : "Lorcana Set";
      return {
        unitKey: unit.unitKey,
        scopeRecordId,
        planFingerprint: "d".repeat(64),
        profileKey: `profile-${index + 1}`,
        profileVersion: `2026.10.${index + 1}`,
        mapping: {
          mappingId: `mapping-${index + 1}`,
          version: "2026-10-24T08:00:00.000Z",
          reviewStatus: "accepted",
          setId: null,
          setName,
        },
        coordinate: setName,
        cache: {
          status: "fresh",
          cacheKey: `sha256:${"c".repeat(64)}`,
          fetchedAt: "2026-10-24T08:00:00.000Z",
          expiresAt: "2026-10-24T09:00:00.000Z",
          staleUntil: "2026-10-25T09:00:00.000Z",
        },
        membership: "member",
      };
    });
    const observed = {
      phases: [...scrydexCoordinatePreviewPhases],
      requests: {
        signIn: 2,
        profileReads: 1,
        scopeInventoryReads: 2,
        coverageReads: 4,
        cacheOptionReads: 10,
        previewPosts: 1,
        usageReads: 1,
        forbidden: 0,
      },
      usageRead: { count: 1, allowed: true },
      forbiddenCalls: [],
      preview: {
        planFingerprint: "d".repeat(64),
        status: "blocked",
        confirmAllowed: false,
        resolvedAt: "2026-10-24T08:30:00.000Z",
        selection: { mode: "ids", scopeRecordIds: ["scope-lorcana", "scope-one-piece"] },
        samples: ["scope-lorcana", "scope-one-piece"].map((scopeRecordId) => ({
          scopeRecordId,
          mappingVersions: scrydexCacheCaptureUnits
            .filter((unit) =>
              scopeRecordId === "scope-one-piece"
                ? unit.productDomain === "one-piece"
                : unit.productDomain === "lorcana",
            )
            .map((unit) => ({
              mappingId: `mapping-${scrydexCacheCaptureUnits.indexOf(unit) + 1}`,
              version: "2026-10-24T08:00:00.000Z",
              reviewStatus: "accepted",
            })),
          profileVersions: scrydexCacheCaptureUnits
            .filter((unit) =>
              scopeRecordId === "scope-one-piece"
                ? unit.productDomain === "one-piece"
                : unit.productDomain === "lorcana",
            )
            .map((unit) => ({
              providerKey: "scrydex",
              unitKey: unit.unitKey,
              profileKey: `profile-${scrydexCacheCaptureUnits.indexOf(unit) + 1}`,
              profileVersion: `2026.10.${scrydexCacheCaptureUnits.indexOf(unit) + 1}`,
            })),
        })),
        blockers: [],
      },
      rows,
    };
    return mergeObservedCoordinatePreviewReceipt(
      {
        runner,
        deployment: { before: generation, after: generation },
        startedAt: "2026-10-24T08:00:00.000Z",
        finishedAt: "2026-10-24T08:30:00.000Z",
      },
      observed,
    );
  };

  const rawArtifact = async (candidate, env, workspace, suffix = "") => {
    const directory = join(workspace, "artifacts", "catalog-scrydex-coordinate-preview");
    await mkdir(directory, { recursive: true });
    await mkdir(env.RUNNER_TEMP, { recursive: true });
    const serialized = `${JSON.stringify(candidate)}${suffix}`;
    const bytes = Buffer.from(serialized);
    await writeFile(join(directory, "capture.json"), bytes);
    await writeFile(
      join(env.RUNNER_TEMP, "catalog-scrydex-coordinate-preview-seal.json"),
      JSON.stringify({ identity: runner, sha256: createHash("sha256").update(bytes).digest("hex") }),
    );
  };

  it("complete: writes and validates one sealed artifact", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    const candidate = receipt();
    expect(validateScrydexCoordinatePreviewReceipt(candidate)).toEqual([]);
    await expect(
      writeCoordinatePreviewArtifact(candidate, [env.CATALOG_ADMIN_E2E_EMAIL], env, workspace, runner),
    ).resolves.toMatchObject({ path: expect.stringContaining("capture.json") });
    await expect(validateCoordinatePreviewUpload(env, workspace)).resolves.toMatchObject({ captureStatus: "complete" });
  });

  it("producer-artifact-complete: projects the live preview before writing", async () => {
    const tally = emptyCoordinatePreviewTally();
    tally.requests.signIn = 2;
    tally.requests.previewPosts = 1;
    tally.requests.usageReads = 1;
    const observed = await buildProducer({ page: fakeProducerPage(), tally })();
    const candidate = await runScrydexCoordinatePreview({
      runner,
      credentialsPresent: true,
      selectDeployment: async () => ({ generation, stop: null }),
      signIn: async () => undefined,
      produce: async () => observed,
      now: (() => {
        const values = ["2026-10-24T08:00:00.000Z", "2026-10-24T08:30:00.000Z"];
        return () => values.shift();
      })(),
    });
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    expect(validateScrydexCoordinatePreviewReceipt(candidate)).toEqual([]);
    await writeCoordinatePreviewArtifact(candidate, [], env, workspace, runner);
    await expect(validateCoordinatePreviewUpload(env, workspace)).resolves.toMatchObject({ captureStatus: "complete" });
  });

  it("forbidden-call: handler-driven long-path refusal writes and validates", async () => {
    const tally = emptyCoordinatePreviewTally();
    tally.requests.signIn = 1;
    const route = {
      request: () => ({
        method: () => "GET",
        url: () => `${scrydexCacheCaptureOrigin}/api/${"x".repeat(230)}`,
        isNavigationRequest: () => false,
      }),
      fetch: vi.fn(async () => ({ headers: () => ({}) })),
      fulfill: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    await createCoordinatePreviewRouteHandler({ phase: "capture", tally })(route);
    expect(tally.requests.forbidden).toBe(1);
    expect(tally.forbiddenCalls[0].length).toBeLessThanOrEqual(64 + 1 + 200);
    const base = await runScrydexCoordinatePreview({
      runner,
      credentialsPresent: true,
      selectDeployment: async () => ({ generation, stop: null }),
      signIn: async () => undefined,
      produce: async () => ({}),
      now: (() => {
        const values = ["2026-10-24T08:00:00.000Z", "2026-10-24T08:30:00.000Z"];
        return () => values.shift();
      })(),
    });
    const candidate = finalCoordinatePreviewReceipt(base, {}, tally);
    expect(candidate.reasons).toContain("forbidden-call");
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await writeCoordinatePreviewArtifact(candidate, [], env, workspace, runner);
    await expect(validateCoordinatePreviewUpload(env, workspace)).resolves.toMatchObject({
      captureStatus: "governed-unknown",
    });
  });

  it("forbidden-call: final merge preserves producer failure and sign-in refusal evidence", async () => {
    const tally = emptyCoordinatePreviewTally();
    tally.requests.signIn = 1;
    tally.requests.forbidden = 1;
    tally.forbiddenCalls.push("ambient-api:GET:-api-sign-in");
    const base = await runScrydexCoordinatePreview({
      runner,
      credentialsPresent: true,
      selectDeployment: async () => ({ generation, stop: null }),
      signIn: async () => undefined,
      produce: async () => {
        throw new Error("bracket-changed");
      },
      now: (() => {
        const values = ["2026-10-24T08:00:00.000Z", "2026-10-24T08:30:00.000Z"];
        return () => values.shift();
      })(),
    });
    const candidate = finalCoordinatePreviewReceipt(base, {}, tally);
    expect(candidate.requests.forbidden).toBe(1);
    expect(candidate.reasons).toEqual(expect.arrayContaining(["forbidden-call", "producer-failed:bracket-changed"]));
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await writeCoordinatePreviewArtifact(candidate, [], env, workspace, runner);
    await expect(validateCoordinatePreviewUpload(env, workspace)).resolves.toMatchObject({
      captureStatus: "governed-unknown",
    });
  });

  it("governed-unknown: keeps a missing credential as a diagnostic and never promotes it", () => {
    const candidate = receipt();
    candidate.outcome = "governed-unknown";
    candidate.reasons = ["credentials-missing"];
    expect(validateScrydexCoordinatePreviewReceipt(candidate)).toEqual([]);
  });

  it("governed-unknown: preserves producer and refusal diagnostics", () => {
    const candidate = receipt();
    candidate.outcome = "governed-unknown";
    candidate.reasons = ["deployment-before:selection-failed", "producer-failed:bracket-changed", "forbidden-call"];
    candidate.requests.forbidden = 1;
    candidate.forbiddenCalls = ["ambient-read:GET:-assets-app.js"];
    expect(validateScrydexCoordinatePreviewReceipt(candidate)).toEqual([]);
  });

  it("governed-unknown: writes a deployment selection failure receipt", async () => {
    const candidate = await runScrydexCoordinatePreview({
      runner,
      credentialsPresent: true,
      selectDeployment: async () => ({ generation: null, stop: "selection-failed" }),
      signIn: vi.fn(async () => undefined),
      produce: vi.fn(async () => ({})),
      now: (() => {
        const values = ["2026-10-24T08:00:00.000Z", "2026-10-24T08:30:00.000Z"];
        return () => values.shift();
      })(),
    });
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await writeCoordinatePreviewArtifact(candidate, [], env, workspace, runner);
    await expect(validateCoordinatePreviewUpload(env, workspace)).resolves.toMatchObject({
      captureStatus: "governed-unknown",
    });
  });

  it("governed-unknown: writes and validates a 1001-refusal tally", async () => {
    const tally = emptyCoordinatePreviewTally();
    tally.requests.forbidden = 1001;
    tally.forbiddenCalls = Array.from({ length: 100 }, (_, index) => `ambient-api:GET:-api-${index}`);
    const base = receipt();
    const candidate = mergeObservedCoordinatePreviewReceipt(base, {
      ...base,
      requests: tally.requests,
      forbiddenCalls: tally.forbiddenCalls,
    });
    expect(tally.requests.forbidden).toBe(1001);
    expect(candidate.requests.forbidden).toBe(1000);
    expect(candidate.forbiddenCalls).toHaveLength(100);
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await writeCoordinatePreviewArtifact(candidate, [], env, workspace, runner);
    await expect(validateCoordinatePreviewUpload(env, workspace)).resolves.toMatchObject({
      captureStatus: "governed-unknown",
    });
  });

  it("create-once: refuses a second artifact write", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await writeCoordinatePreviewArtifact(receipt(), [], env, workspace, runner);
    await expect(writeCoordinatePreviewArtifact(receipt(), [], env, workspace, runner)).rejects.toThrow(
      "artifact-directory-not-empty",
    );
  });

  it("artifact-too-large: rejects a receipt that exceeds the one megabyte cap", async () => {
    const candidate = receipt();
    candidate.padding = "x".repeat(1_000_001);
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await expect(writeCoordinatePreviewArtifact(candidate, [], env, workspace, runner)).rejects.toThrow(
      "artifact-size",
    );
    await rawArtifact(receipt(), env, workspace, " ".repeat(1_000_001));
    await expect(validateCoordinatePreviewUpload(env, workspace)).rejects.toThrow("artifact-size");
  });

  it("writer-leak: refuses a credential marker before writing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    const candidate = receipt();
    candidate.preview.blockers = [
      { code: "scope-planning-blocked", scopeRecordId: null, providerKey: "scrydex", message: env.GH_TOKEN },
    ];
    candidate.reasons = ["scrydex-scope-planning-blocked"];
    candidate.outcome = "governed-unknown";
    await expect(writeCoordinatePreviewArtifact(candidate, [env.GH_TOKEN], env, workspace, runner)).rejects.toThrow(
      "artifact-invalid",
    );
  });

  it("validator-credential: refuses a credential marker already on disk", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    const candidate = receipt();
    candidate.preview.blockers = [
      { code: "scope-planning-blocked", scopeRecordId: null, providerKey: "scrydex", message: env.GH_TOKEN },
    ];
    candidate.reasons = ["scrydex-scope-planning-blocked"];
    candidate.outcome = "governed-unknown";
    await rawArtifact(candidate, env, workspace);
    await expect(validateCoordinatePreviewUpload(env, workspace)).rejects.toThrow("credential-marker");
  });

  it("validator-receipt: refuses an invalid receipt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    const candidate = receipt();
    candidate.outcome = "governed-unknown";
    await rawArtifact(candidate, env, workspace);
    await expect(validateCoordinatePreviewUpload(env, workspace)).rejects.toThrow("artifact-invalid");
  });

  it("validator-seal: refuses a seal for another digest", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await writeCoordinatePreviewArtifact(receipt(), [], env, workspace, runner);
    await writeFile(
      join(env.RUNNER_TEMP, "catalog-scrydex-coordinate-preview-seal.json"),
      JSON.stringify({ identity: runner, sha256: "0".repeat(64) }),
    );
    await expect(validateCoordinatePreviewUpload(env, workspace)).rejects.toThrow("seal-mismatch");
  });

  it("validator-runner: refuses a receipt bound to another run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    const candidate = receipt();
    candidate.runner = { ...runner, runId: "999999" };
    await rawArtifact(candidate, env, workspace);
    await expect(validateCoordinatePreviewUpload(env, workspace)).rejects.toThrow("runner-mismatch");
  });

  it("validator-directory-shape: refuses extra artifact entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await writeCoordinatePreviewArtifact(receipt(), [], env, workspace, runner);
    await writeFile(join(workspace, "artifacts", "catalog-scrydex-coordinate-preview", "extra.json"), "x");
    await expect(validateCoordinatePreviewUpload(env, workspace)).rejects.toThrow("artifact-shape");
  });

  it("artifact-directory: refuses a symlinked or non-directory path segment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    directories.push(workspace);
    const env = runnerEnv();
    directories.push(env.RUNNER_TEMP);
    await writeFile(join(workspace, "artifacts"), "not-a-directory");
    await expect(writeCoordinatePreviewArtifact(receipt(), [], env, workspace, runner)).rejects.toThrow(
      "artifact-directory",
    );
  });
});

describe("bounded read", () => {
  it("covers headers and body with same-origin, no-redirect fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    await expect(
      readCoordinatePreviewResponseInPage({ path: "/api/x", deadlineMs: 1000, byteCap: 100, fetchImpl }),
    ).resolves.toEqual({ status: 200, text: '{"ok":true}' });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({ credentials: "same-origin", redirect: "error", cache: "no-store" }),
    );
  });

  it("refuses an oversized body by the in-page byte cap", async () => {
    await expect(
      readCoordinatePreviewResponseInPage({
        path: "/api/x",
        deadlineMs: 1000,
        byteCap: 2,
        fetchImpl: vi.fn(async () => new Response("too-large", { status: 200 })),
      }),
    ).rejects.toThrow("read-cap");
  });
});
