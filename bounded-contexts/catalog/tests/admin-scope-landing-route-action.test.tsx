import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { ApiError as CatalogApiError } from "../support/shell-support/api/client";

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
    expect(result.feedback).toMatchObject({ status: "error", intent: "dismiss-attention-item", result: "command-failed" });
  });

  it("returns the committed dismiss key, restores it, and the next loader observes the read-after-write state", async () => {
    let dismissed = true;
    const dispatch = vi.fn().mockImplementation(async ({ intent }: { intent: string }) => {
      dismissed = intent !== "restore";
      return { status: "recorded" };
    });
    const listCatalogScopeRecords = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const getCatalogAttentionQueueReadModel = vi.fn().mockImplementation(async () =>
      dismissed ? { malformed: true } : { malformed: true },
    );
    mockCreateCatalogRequestApiClient.mockReturnValue({
      dispatchCatalogAttentionQueueCommand: dispatch,
      listCatalogScopeRecords,
      getCatalogAttentionQueueReadModel,
    });

    const dismiss = await action(
      routeArgs(
        request("dismiss-attention-item", {
          itemKey: "provider-health:tcgdex:unit",
          kind: "provider-health",
          reason: "review",
        }),
      ),
    );
    expect(dismiss.attentionItemKey).toBe("provider-health:tcgdex:unit");
    expect(dispatch).toHaveBeenCalledWith({
      intent: "dismiss",
      itemKey: "provider-health:tcgdex:unit",
      kind: "provider-health",
      reason: "review",
    });

    const restored = await action(
      routeArgs(request("restore-attention-item", { itemKey: dismiss.attentionItemKey! })),
    );
    expect(restored.feedback).toMatchObject({ status: "success", result: "job-queued" });
    expect(dispatch).toHaveBeenLastCalledWith({ intent: "restore", itemKey: "provider-health:tcgdex:unit" });

    const nextLoad = await loader(loaderArgs(new Request("https://admin.example/catalog/scopes?page=2")));
    expect(nextLoad.readModel.rows).toEqual([]);
    expect(listCatalogScopeRecords).toHaveBeenCalledOnce();
    expect(getCatalogAttentionQueueReadModel).toHaveBeenCalledOnce();
    expect(dismissed).toBe(false);
  });

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
});
