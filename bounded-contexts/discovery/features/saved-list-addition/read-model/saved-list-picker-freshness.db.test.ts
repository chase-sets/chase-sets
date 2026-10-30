import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  attachReadConsistencyMiddleware,
  attachWriteConsistencyMiddleware,
  bootstrapContextDatabase,
  mountApiRouters,
  resolveModuleApiMounts,
  type ReadConsistencyAuditRecord,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createAccountUserTestRequestContext,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PostWriteTokenPayload } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { configurePlatformPostWriteTokenStoreForTests } from "@chase-sets/platform-runtime/post-write-tokens";
import type { SavedListPickerPreparation, SavedListRouteActionData } from "../ui/contracts";
import type { SavedListProductSelection } from "@chase-sets/collections/server";
import { defineBoundedContextModule, type BcApiEntry } from "@chase-sets/bounded-context-module";
import { contextManifest as collectionsManifest, module as collectionsModule } from "@chase-sets/collections";
import { contextManifest as discoveryManifest, module as discoveryModule } from "../../../index";

// The receipt chain's only test double: helper-side actor resolution reads the
// same test session cookie that the mounted API actor middleware below reads.
const testActors = vi.hoisted(() => ({
  a: { sessionId: "ses_picker_a", userId: "usr_picker_a", accountId: "acc_picker_a", membershipId: "mbr_picker_a" },
  b: { sessionId: "ses_picker_b", userId: "usr_picker_b", accountId: "acc_picker_b", membershipId: "mbr_picker_b" },
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );
  return {
    ...actual,
    resolveActorFromAuthApi: async ({ request }: { request: Request }) => {
      const key = /(?:^|;\s*)picker_test_actor=([ab])/.exec(request.headers.get("cookie") ?? "")?.[1];
      return key ? testActors[key as "a" | "b"] : null;
    },
  };
});

import {
  commitSavedListAddition,
  prepareSavedListAddition,
  savedListActionError,
} from "../../../support/request-support/saved-list-addition";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const pickerProjectionName = "discovery-saved-list-picker-projection";
const pickerRoutePath = "/account/saved-lists/recent";
const hostUrl = "http://marketplace.test/search?q=charizard";
const product: SavedListProductSelection = {
  catalogItemId: "cat_picker" as SavedListProductSelection["catalogItemId"],
  productId: "cat_picker::condition:near-mint" as SavedListProductSelection["productId"],
  selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
};
const exactPickerDependency = [{ targetContextName: "discovery", projectionName: pickerProjectionName }];
const otherSourceContextNames = [
  ...new Set(
    [collectionsManifest, discoveryManifest].flatMap((manifest) =>
      manifest.eventSubscriptions.map((subscription) => subscription.sourceContextName),
    ),
  ),
].filter((name) => name !== "collections" && name !== "discovery");
const sourceOnlyModule = defineBoundedContextModule({
  manifest: { contextName: "catalog", apiBasePath: "/api/catalog", streamPrefix: "catalog." },
  schemaSql: "",
  createServices: () => ({}),
  buildApis: (): readonly BcApiEntry[] => [],
});

type ActorKey = keyof typeof testActors;

let pools: Readonly<Record<"collections" | "discovery" | "sources", PgTransactionalPool>>;
let databaseNames: Readonly<Record<"collections" | "discovery", string>>;
let tokenPayloads: Map<string, PostWriteTokenPayload>;
let restoreTokenStore: () => void;

function actorContext(key: ActorKey) {
  return createAccountUserTestRequestContext({ actor: testActors[key] });
}

function compose(options: Readonly<{ omitPickerDeclaration?: boolean }> = {}) {
  const runtime = createMountedContextTestRuntime([
    ...otherSourceContextNames.map((contextName) => ({
      contextName,
      module: sourceOnlyModule,
      pool: pools.sources,
      ports: {},
      mountRole: "source-only" as const,
    })),
    {
      contextName: "collections",
      module: collectionsModule,
      pool: pools.collections,
      // Host port normally provided by platform-api from Catalog; Product
      // resolution is outside this receipt chain.
      ports: {
        savedListProductCatalog: {
          resolveProduct: async (selection: SavedListProductSelection) => ({
            availability: "active" as const,
            product: selection,
          }),
        },
      },
    },
    { contextName: "discovery", module: discoveryModule, pool: pools.discovery, ports: {} },
  ]);
  const mountedServices = (contextName: string) =>
    runtime.mountedContexts.find((entry) => entry.contextName === contextName)!.services;
  const collections = mountedServices("collections") as ReturnType<typeof collectionsModule.createServices>;
  const discovery = mountedServices("discovery") as ReturnType<typeof discoveryModule.createServices>;
  const collectionsMounts = resolveModuleApiMounts(collectionsModule, collections);
  const discoveryMounts = resolveModuleApiMounts(discoveryModule, discovery).map((mount) =>
    options.omitPickerDeclaration
      ? {
          ...mount,
          readFreshnessRoutes: mount.readFreshnessRoutes?.filter((route) => route.routePath !== pickerRoutePath),
        }
      : mount,
  );
  const audits: ReadConsistencyAuditRecord[] = [];
  const pickerReads: Request[] = [];
  const app = new Hono<{ Variables: { actor: unknown; context: unknown } }>();
  app.use("*", async (c, next) => {
    const key = /(?:^|;\s*)picker_test_actor=([ab])/.exec(c.req.header("cookie") ?? "")?.[1] as ActorKey | undefined;
    const requestContext = key ? actorContext(key) : null;
    c.set("actor", requestContext?.actor ?? null);
    c.set("context", requestContext?.context ?? null);
    if (c.req.path.endsWith(pickerRoutePath)) pickerReads.push(c.req.raw.clone());
    await next();
  });
  attachWriteConsistencyMiddleware(app, collectionsMounts, runtime.projectionGroups, { enabled: false });
  attachReadConsistencyMiddleware(app, discoveryMounts, runtime.projectionGroups, {
    timeoutMs: 0,
    exactDependencyMode: "enabled",
    recordReadConsistencyAudit: (record) => audits.push(record),
  });
  mountApiRouters(app, [...collectionsMounts, ...discoveryMounts]);
  const picker = runtime.subscriptionRunners.find(
    (runner) => runner.targetContextName === "discovery" && runner.projectionName === pickerProjectionName,
  )!;
  expect(picker).toBeDefined();
  // The helpers' forwarded-auth clients reach only this composed app.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init));
  return { collections, picker, audits, pickerReads };
}

async function prepare(actor: ActorKey, postWriteToken: string | null = null) {
  const url = new URL(hostUrl);
  if (postWriteToken) url.searchParams.set("postWriteToken", postWriteToken);
  const request = new Request(url, {
    method: "POST",
    headers: { cookie: `picker_test_actor=${actor}` },
    body: new URLSearchParams({ intent: "prepare-saved-list" }),
  });
  // Route actions consume the body before calling the helper, and catch its
  // errors exactly like Search and Item Detail do.
  await request.formData();
  const response = await prepareSavedListAddition({
    request,
    product,
    productLabel: "Charizard · Near Mint",
    sourceSurface: "search",
  }).catch(savedListActionError);
  return { status: response.status, body: (await response.json()) as SavedListRouteActionData | { error: string } };
}

async function commit(actor: ActorKey, preparation: SavedListPickerPreparation, title: string) {
  const formData = new FormData();
  formData.set("preparation", JSON.stringify(preparation));
  formData.set("destinationKind", "new");
  formData.set("newListTitle", title);
  formData.set("trackedQuantity", "2");
  const response = await commitSavedListAddition(
    new Request(hostUrl, { method: "POST", headers: { cookie: `picker_test_actor=${actor}` } }),
    formData,
  );
  const body = (await response.json()) as Extract<SavedListRouteActionData, { status: "saved" }>;
  expect(response.status).toBe(200);
  expect(body.status).toBe("saved");
  expect(body.postWriteToken).toMatch(/^pwt_picker/);
  const receipt = tokenPayloads.get(body.postWriteToken!)!.receipt;
  return { body, token: body.postWriteToken!, receipt };
}

async function readyPreparation(actor: ActorKey) {
  const prepared = await prepare(actor);
  expect(prepared.status).toBe(200);
  expect(prepared.body).toMatchObject({ status: "ready" });
  return (prepared.body as Extract<SavedListRouteActionData, { status: "ready" }>).preparation;
}

function recentLists(body: unknown) {
  expect(body).toMatchObject({ status: "ready" });
  return (body as Extract<SavedListRouteActionData, { status: "ready" }>).preparation.recentLists;
}

describeDb("Collections receipt to Discovery Saved List picker on independent stores", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["collections", "discovery", "sources"],
      "saved_list_freshness",
    );
    expect(urls.collections).not.toBe(urls.discovery);
    databaseNames = {
      collections: new URL(urls.collections).pathname.slice(1),
      discovery: new URL(urls.discovery).pathname.slice(1),
    };
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  }, 120_000);

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(sourceOnlyModule, pools.sources);
    await bootstrapContextDatabase(collectionsModule, pools.collections);
    await bootstrapContextDatabase(discoveryModule, pools.discovery);
    tokenPayloads = new Map();
    restoreTokenStore = configurePlatformPostWriteTokenStoreForTests({
      async storePostWriteToken(payload) {
        const token = `pwt_picker${String(tokenPayloads.size + 1).padStart(16, "0")}`;
        tokenPayloads.set(token, payload);
        return token;
      },
      async resolvePostWriteToken(token) {
        return tokenPayloads.get(token) ?? null;
      },
    });
  }, 120_000);

  afterEach(() => {
    restoreTokenStore();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("holds the receipted picker read, then returns the new List on the first read after release", async () => {
    const composed = compose();
    const committed = await commit("a", await readyPreparation("a"), "New Favorites");
    expect(committed.receipt.sources).toHaveLength(1);
    const [source] = committed.receipt.sources;
    expect(source).toMatchObject({ sourceContextName: "collections" });
    expect(BigInt(source!.maxGlobalPosition)).toBeGreaterThan(0n);
    const commitEvents = await pools.collections.query<{ event_type: string; global_position: string }>(
      "SELECT event_type, global_position::text FROM event_store_events WHERE event_id = ANY($1) ORDER BY global_position",
      [source!.eventIds],
    );
    expect(commitEvents.rows.map((row) => row.event_type)).toEqual([
      "collections.saved-list.created",
      "collections.saved-list.line-added",
    ]);
    expect(commitEvents.rows.at(-1)!.global_position).toBe(source!.maxGlobalPosition);

    composed.audits.length = 0;
    const held = await prepare("a", committed.token);
    expect(held).toEqual({
      status: 503,
      body: { error: t("collections.features.savedLists.ui.addToList.error.description") },
    });
    const receiptedAudit = {
      waitMode: "exact-dependency",
      receiptSourceContextNames: ["collections"],
      dependencies: exactPickerDependency,
    };
    expect(composed.audits).toEqual([expect.objectContaining({ ...receiptedAudit, outcome: "timeout" })]);
    expect(composed.audits[0]!.receiptSourceCount).toBeGreaterThanOrEqual(1);

    await composed.picker.runOnce();
    const checkpoint = await composed.picker.refreshStatus();
    expect(BigInt(checkpoint.lastGlobalPosition)).toBeGreaterThanOrEqual(BigInt(source!.maxGlobalPosition));
    composed.audits.length = 0;
    composed.pickerReads.length = 0;
    const released = await prepare("a", committed.token);
    expect(released.status).toBe(200);
    const firstRead = recentLists(released.body);
    expect(firstRead).toEqual([
      expect.objectContaining({
        listId: committed.body.result.listId,
        title: "New Favorites",
        lineCount: 1,
        trackedUnitCount: 2,
        version: 2,
      }),
    ]);
    expect(composed.pickerReads).toHaveLength(1);
    expect(composed.audits).toEqual([expect.objectContaining({ ...receiptedAudit, outcome: "fresh" })]);
    expect(composed.audits[0]!.receiptSourceCount).toBeGreaterThanOrEqual(1);
    console.info(
      "[saved-list-picker AC8 evidence]",
      JSON.stringify({
        databases: databaseNames,
        actorAccountId: testActors.a.accountId,
        commitEvents: commitEvents.rows,
        receiptMaxGlobalPosition: source!.maxGlobalPosition,
        pickerCheckpoint: { key: composed.picker.checkpointKey, lastGlobalPosition: checkpoint.lastGlobalPosition },
        firstRead: firstRead.map(({ listId, title, lineCount, trackedUnitCount, version }) => ({
          listId,
          title,
          lineCount,
          trackedUnitCount,
          version,
        })),
        audits: composed.audits.map(({ outcome, waitMode, receiptSourceCount, dependencies }) => ({
          outcome,
          waitMode,
          receiptSourceCount,
          dependencies,
        })),
      }),
    );
  });

  it("reads stale Lists without a freshness claim when only the token is omitted", async () => {
    const composed = compose();
    await commit("a", await readyPreparation("a"), "New Favorites");
    composed.audits.length = 0;

    const unreceipted = await prepare("a");

    expect(unreceipted.status).toBe(200);
    expect(recentLists(unreceipted.body)).toEqual([]);
    expect(composed.audits).toEqual([
      expect.objectContaining({
        outcome: "missing-receipt",
        readAfterWriteHeaderPresent: false,
        receiptSourceCount: 0,
        dependencies: exactPickerDependency,
      }),
    ]);
  });

  it("waits by target context with no exact dependency when only the picker declaration is omitted", async () => {
    const composed = compose({ omitPickerDeclaration: true });
    const committed = await commit("a", await readyPreparation("a"), "New Favorites");
    composed.audits.length = 0;

    const held = await prepare("a", committed.token);

    expect(held.status).toBe(503);
    expect(composed.audits).toHaveLength(1);
    expect(composed.audits[0]).toMatchObject({
      outcome: "timeout",
      waitMode: "target-context",
      receiptSourceContextNames: ["collections"],
      dependencies: [],
    });
    expect(composed.audits[0]).not.toMatchObject({ waitMode: "exact-dependency", dependencies: exactPickerDependency });
  });

  it("excludes archived Lists and never shows actor A's Lists to actor B, even with A's token", async () => {
    const composed = compose();
    const archived = await commit("a", await readyPreparation("a"), "Old Favorites");
    const active = await commit("a", await readyPreparation("a"), "Active Favorites");
    type ArchiveInput = Parameters<typeof composed.collections.savedLists.archiveSavedList>[0];
    // The real Collections archive command; the picker learns it only through its runner.
    await composed.collections.savedLists.archiveSavedList(
      {
        commandId: "slc_picker_archive" as ArchiveInput["commandId"],
        listId: archived.body.result.listId as ArchiveInput["listId"],
        ownerAccountId: testActors.a.accountId as ArchiveInput["ownerAccountId"],
        expectedVersion: 2,
      },
      actorContext("a").context!,
    );
    await composed.picker.runOnce();

    const ownerRead = await prepare("a", active.token);
    expect(ownerRead.status).toBe(200);
    expect(recentLists(ownerRead.body).map((list) => list.title)).toEqual(["Active Favorites"]);

    for (const token of [active.token, null]) {
      const otherActorRead = await prepare("b", token);
      expect(otherActorRead.status).toBe(200);
      expect(recentLists(otherActorRead.body)).toEqual([]);
    }
  });
});
