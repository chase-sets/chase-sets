// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Hono } from "hono";
import type { LoaderFunctionArgs } from "react-router";
import { MemoryRouter } from "react-router";
import { ApiError as CatalogApiError, createCatalogApiClient } from "../support/shell-support/api/client";
import type { CatalogAuthoringEnv } from "../support/authoring-support/api";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { catalogAttentionQueueRoutes } from "../features/attention-queue/api/route";
import {
  catalogAttentionProviderHealthItem,
  catalogAttentionQueueReadModelFixture,
} from "../features/attention-queue/api/attention-queue-test-fixtures";
import {
  decideCatalogAttentionDismissal,
  evolveCatalogAttentionDismissal,
  initialCatalogAttentionDismissalState,
  type CatalogAttentionDismissalCommand,
  type CatalogAttentionDismissalEvent,
} from "../features/attention-queue/domain/dismissal";
import { CatalogScopeLandingPage } from "../features/source-observations/ui/admin-control-plane/scope-landing/scope-landing-page";
import {
  buildCatalogAliasReviewReadModel,
  type CatalogAliasReviewReadModel,
} from "../features/alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogAliasCandidateRow } from "../features/alias-equivalence/read-model/queries";

const { mockCreateCatalogRequestApiClient, mockResolveActorFromAuthApi } = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
}));

vi.mock("../support/request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../support/request-support/api-client")>(
    "../support/request-support/api-client",
  );
  return { ...actual, createCatalogRequestApiClient: mockCreateCatalogRequestApiClient };
});

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
}));

const { action } = await import("../routes/admin/scope-landing");
const { loader } = await import("../support/route-support/admin-scope-landing/scope-landing-loader");

function request(intent: string, fields: Record<string, string> = {}) {
  const body = new URLSearchParams({ _intent: intent, ...fields });
  return new Request("https://admin.example/catalog/scopes?page=2", { method: "POST", body });
}

function routeArgs(input: Request): Parameters<typeof action>[0] {
  return { request: input, params: {}, context: {} } as Parameters<typeof action>[0];
}

function loaderArgs(input: Request): LoaderFunctionArgs {
  return { request: input, params: {}, context: {} } as LoaderFunctionArgs;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const queueItem = catalogAttentionProviderHealthItem();
const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: { performedByUserId: "usr_reviewer" as UserId, forAccountId: "acc_test" as AccountId },
};

const aliasFixture: CatalogAliasCandidateRow = {
  alias_hash: "alias-accepted",
  target_kind: "catalog-item",
  target_id: "item-1",
  target_key: "name",
  alias_text: "Bulbasaur",
  normalized_alias_text: "bulbasaur",
  alias_language_code: "en",
  source_language_code: "en",
  alias_type: "official-equivalent",
  confidence: "high",
  review_status: "accepted",
  provider_key: "tcgdex",
  observation_id: "obs-1",
  source_category: "provider-same-id-localized-endpoint",
  source_profile_key: "pokemon-tcg",
  source_profile_version: "v1",
  mapping_fingerprint: "fp",
  evidence: {},
  first_observed_at: "2026-07-13T12:00:00.000Z",
  updated_at: "2026-07-13T12:00:00.000Z",
};

function aliasReadModel(status: CatalogAliasCandidateRow["review_status"]): CatalogAliasReviewReadModel {
  return buildCatalogAliasReviewReadModel({
    generatedAt: "2026-07-13T12:00:00.000Z",
    filter: {
      providerKey: null,
      sourceProfileVersion: null,
      aliasType: null,
      reviewStatuses: [],
      observationId: null,
      targetKind: null,
      targetId: null,
    },
    candidateRows: [{ ...aliasFixture, review_status: status }],
    catalogItemAliasRows: [],
    referenceRecordAliasRows: [],
  });
}

function statefulQueueApi(canManage = true, failCommand = false) {
  let state = initialCatalogAttentionDismissalState;
  let version = 0;
  const handler = vi.fn().mockImplementation(async ({ command }: { command: CatalogAttentionDismissalCommand }) => {
    const events = decideCatalogAttentionDismissal(state, command) as readonly CatalogAttentionDismissalEvent[];
    state = events.reduce(evolveCatalogAttentionDismissal, state);
    version += events.length;
    return { state, version, newEvents: [], storedEvents: [] };
  });
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { permissions: canManage ? ["catalog.view", "catalog.manage"] : ["catalog.view"] });
    c.set("context", context);
    await next();
  });
  app.route(
    "/attention-queue",
    catalogAttentionQueueRoutes({
      catalogAttentionDismissalCommandHandler: handler,
      getCatalogAttentionQueueReadModel: vi.fn().mockImplementation(async () => {
        const parked =
          state.disposition === "dismissed" ||
          (state.disposition === "deferred" && Date.parse(state.deferredUntil!) > Date.now());
        return catalogAttentionQueueReadModelFixture(parked ? [] : [queueItem], new Date().toISOString());
      }),
    }),
  );
  const api = createCatalogApiClient({
    baseUrl: "https://catalog.test",
    fetch: async (input, init) => {
      const req = new Request(input, init);
      if (failCommand && req.method === "POST")
        return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      return app.fetch(req);
    },
  });
  mockCreateCatalogRequestApiClient.mockReturnValue({
    ...api,
    listCatalogScopeRecords: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
    getCatalogAliasReviewReadModel: undefined,
    recordCatalogControlPlaneEvent: undefined,
  });
  mockResolveActorFromAuthApi.mockResolvedValue({
    permissions: canManage ? ["catalog.view", "catalog.manage"] : ["catalog.view"],
  });
  return { handler };
}

async function expectHomeQueue(visible: boolean, feedback?: Awaited<ReturnType<typeof action>>) {
  const data = await loader(loaderArgs(new Request("https://admin.example/catalog/scopes?page=2")));
  expect(data.attentionQueue.status).toBe("ready");
  if (data.attentionQueue.status !== "ready") throw new Error("Expected a validated queue response");
  expect(data.attentionQueue.readModel.items.map((item) => item.itemKey)).toEqual(visible ? [queueItem.itemKey] : []);
  cleanup();
  render(
    <MemoryRouter>
      <CatalogScopeLandingPage
        {...data}
        loading={false}
        actionHref="/catalog/scopes"
        commandFeedback={feedback?.feedback}
        attentionItemKey={feedback?.attentionItemKey}
      />
    </MemoryRouter>,
  );
  expect(screen.queryAllByText(/Unblock .* on tcgplayer/i).length > 0).toBe(visible);
  if (!visible) expect(screen.getByText(/running itself/i)).toBeTruthy();
  if (feedback?.attentionItemKey) {
    const restore = document
      .querySelector<HTMLInputElement>('input[name="_intent"][value="restore-attention-item"]')
      ?.closest("form");
    expect(restore?.querySelector<HTMLInputElement>('input[name="itemKey"]')?.value).toBe(queueItem.itemKey);
  }
  return data;
}

describe("Catalog scope-landing route action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveActorFromAuthApi.mockResolvedValue({ permissions: ["catalog.view", "catalog.manage"] });
  });

  it.each([403, 500])("returns command-failed feedback for a Catalog API %s", async (status) => {
    mockCreateCatalogRequestApiClient.mockReturnValue({
      dispatchCatalogAttentionQueueCommand: vi
        .fn()
        .mockRejectedValue(new CatalogApiError(status, { error: { code: "blocked" } })),
    });

    const result = await action(
      routeArgs(
        request("dismiss-attention-item", {
          itemKey: "provider-health:tcgdex:unit",
          kind: "provider-health",
          reason: "review",
        }),
      ),
    );
    expect(result.feedback).toMatchObject({
      status: "error",
      intent: "dismiss-attention-item",
      result: "command-failed",
    });
  });

  it("commits dismiss, hides on the next load and reload, and restores the visible item through the real API", async () => {
    const { handler } = statefulQueueApi();
    await expectHomeQueue(true);
    const dismiss = await action(
      routeArgs(
        request("dismiss-attention-item", {
          itemKey: queueItem.itemKey,
          kind: "provider-health",
          reason: "review",
        }),
      ),
    );
    expect(dismiss.feedback.status).toBe("success");
    expect(dismiss.attentionItemKey).toBe(queueItem.itemKey);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: "DismissAttentionItem", itemKey: queueItem.itemKey }),
      }),
    );
    await expectHomeQueue(false, dismiss);
    await expectHomeQueue(false);
    const restored = await action(routeArgs(request("restore-attention-item", { itemKey: dismiss.attentionItemKey! })));
    expect(restored.feedback).toMatchObject({ status: "success", result: "job-queued" });
    await expectHomeQueue(true, restored);
    await expectHomeQueue(true);
  });

  it("keeps a deferred item hidden across reloads, reveals it at expiry, and also supports explicit restore", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    statefulQueueApi();
    const fields = { itemKey: queueItem.itemKey, kind: queueItem.kind, reason: "later", deferHours: "24" };
    const deferred = await action(routeArgs(request("defer-attention-item", fields)));
    expect(deferred.feedback.status).toBe("success");
    await expectHomeQueue(false, deferred);
    await expectHomeQueue(false);
    vi.setSystemTime(new Date("2026-07-10T11:59:59.999Z"));
    await expectHomeQueue(false);
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    await expectHomeQueue(true);
    await expectHomeQueue(true);
    await action(routeArgs(request("defer-attention-item", fields)));
    await expectHomeQueue(false);
    await action(routeArgs(request("restore-attention-item", { itemKey: queueItem.itemKey })));
    await expectHomeQueue(true);
  });

  it.each(["denied", "API failure"])(
    "does not park or claim success after %s and preserves the item on reload",
    async (failure) => {
      const { handler } = statefulQueueApi(failure !== "denied", failure === "API failure");
      const result = await action(
        routeArgs(
          request("dismiss-attention-item", { itemKey: queueItem.itemKey, kind: queueItem.kind, reason: "review" }),
        ),
      );
      expect(result.feedback).toMatchObject({ status: "error", result: "command-failed" });
      expect(result.attentionItemKey).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
      const data = await expectHomeQueue(true, result);
      expect(data.canManage).toBe(failure !== "denied");
      await expectHomeQueue(true);
    },
  );

  it.each(["alias.accept", "alias.reject"])("submits the exact %s alias payload", async (intent) => {
    const dispatch = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand: dispatch });

    const result = await action(
      routeArgs(
        request(intent, {
          aliasHashes: "alias-1,alias-2",
          ...(intent === "alias.reject" ? { reason: "not equivalent" } : {}),
        }),
      ),
    );
    expect(result.feedback).toMatchObject({ status: "success", intent, result: "job-queued" });
    expect(dispatch).toHaveBeenCalledWith({
      intent: intent === "alias.accept" ? "accept" : "reject",
      aliasHashes: ["alias-1", "alias-2"],
      ...(intent === "alias.reject" ? { reason: "not equivalent" } : {}),
    });
  });

  it("revokes an accepted alias through the home action and observes the revoked row after loader reload", async () => {
    let status: CatalogAliasCandidateRow["review_status"] = "accepted";
    const dispatch = vi.fn().mockImplementation(async () => {
      status = "revoked";
      return { status: "recorded" };
    });
    const scopes = { items: [], total: 0, count: 0 };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listCatalogScopeRecords: vi.fn().mockResolvedValue(scopes),
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue(catalogAttentionQueueReadModelFixture([])),
      getCatalogAliasReviewReadModel: vi.fn().mockImplementation(async () => aliasReadModel(status)),
      dispatchCatalogAliasReviewCommand: dispatch,
    });

    const before = await loader(loaderArgs(new Request("https://admin.example/catalog/scopes")));
    expect(before.generalAliasReview?.candidates[0]?.reviewStatus).toBe("accepted");
    const result = await action(
      routeArgs(
        request("alias.revoke", {
          aliasHashes: "alias-accepted",
          reason: "reviewed",
        }),
      ),
    );
    expect(result.feedback).toMatchObject({ status: "success", intent: "alias.revoke", result: "job-queued" });
    expect(dispatch).toHaveBeenCalledWith({ intent: "revoke", aliasHashes: ["alias-accepted"], reason: "reviewed" });

    const after = await loader(loaderArgs(new Request("https://admin.example/catalog/scopes")));
    expect(after.generalAliasReview?.candidates[0]?.reviewStatus).toBe("revoked");
  });
});
