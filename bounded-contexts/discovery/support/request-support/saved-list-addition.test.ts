import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configurePlatformPostWriteTokenStoreForTests } from "@chase-sets/platform-runtime/post-write-tokens";
import { UnresolvedPostWriteTokenError } from "@chase-sets/platform-runtime/http";
import { CollectionsApiError } from "@chase-sets/collections/server";
import { t } from "@chase-sets/localization";

const { mockCreateCollectionsRequestApiClient, mockResolveActorFromAuthApi } = vi.hoisted(() => ({
  mockCreateCollectionsRequestApiClient: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );
  return { ...actual, resolveActorFromAuthApi: mockResolveActorFromAuthApi };
});

vi.mock("@chase-sets/collections/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/collections/server")>(
    "@chase-sets/collections/server",
  );
  return { ...actual, createCollectionsRequestApiClient: mockCreateCollectionsRequestApiClient };
});

import { commitSavedListAddition, prepareSavedListAddition, savedListActionError } from "./saved-list-addition";

const product = {
  catalogItemId: "cat_card",
  productId: "cat_card::condition:near-mint",
  selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
} as const;

const preparation = {
  product,
  productLabel: "Pikachu · Near Mint",
  recentLists: [],
  tokens: {
    addCommandId: "slc_add",
    lineId: "sll_card",
    newListId: "svl_new",
    newListCommandId: "slc_new",
  },
  sourceSurface: "search" as const,
  claimIntentId: null,
  resumeDestination: null,
  resumeTrackedQuantity: null,
};

const receipt = {
  observedAtMs: Date.now(),
  sources: [
    {
      sourceContextName: "collections",
      maxGlobalPosition: "42",
      eventIds: ["evt_saved_list"],
    },
  ],
};

let restoreTokenStore: (() => void) | undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_1", permissions: ["accounts.view"] });
  mockCreateCollectionsRequestApiClient.mockReturnValue({
    addProductToSavedList: vi.fn(async () => ({
      listId: "svl_new",
      title: "New Favorites",
      lineStatus: "added",
      commandReceipt: {
        mode: "eventual",
        commitEventIds: receipt.sources[0].eventIds,
        commitPositions: receipt.sources,
      },
    })),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return Response.json({ items: [], total: 0, count: 0 });
    }),
  );
});

afterEach(() => {
  restoreTokenStore?.();
  restoreTokenStore = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function useTokenStore() {
  restoreTokenStore = configurePlatformPostWriteTokenStoreForTests({
    async storePostWriteToken() {
      return "pwt_test0000000001";
    },
    async resolvePostWriteToken() {
      return { receipt };
    },
  });
}

describe("Saved List addition request support", () => {
  it("mints an opaque token from the Collections command receipt before returning JSON", async () => {
    useTokenStore();
    const formData = new FormData();
    formData.set("preparation", JSON.stringify(preparation));
    formData.set("destinationKind", "new");
    formData.set("newListTitle", "New Favorites");
    formData.set("trackedQuantity", "1");

    const response = await commitSavedListAddition(new Request("https://marketplace.test/search?q=pikachu"), formData);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "saved", postWriteToken: "pwt_test0000000001" });
  });

  it("resolves a consumed-body prepare through metadata and forwards only the receipt header", async () => {
    useTokenStore();
    const request = new Request("https://marketplace.test/search?q=pikachu&postWriteToken=pwt_test0000000001", {
      method: "POST",
      headers: { authorization: "Bearer test", cookie: "session=test" },
      body: new URLSearchParams({ intent: "prepare-saved-list" }),
    });
    await request.formData();

    const response = await prepareSavedListAddition({
      request,
      product,
      productLabel: "Pikachu · Near Mint",
      sourceSurface: "search",
    });

    expect(response.status).toBe(200);
    expect(mockResolveActorFromAuthApi).toHaveBeenCalledWith({ request: expect.any(Request) });
    const authRequest = mockResolveActorFromAuthApi.mock.calls[0]?.[0].request as Request;
    expect(authRequest.method).toBe("GET");
    expect(authRequest.bodyUsed).toBe(false);
    const forwarded = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const forwardedHeaders = new Headers(forwarded.headers);
    expect(Object.fromEntries(forwardedHeaders.entries())).toMatchObject({
      "chase-sets-read-after-write": expect.any(String),
    });
    const receiptHeader = forwardedHeaders.get("chase-sets-read-after-write");
    expect(receiptHeader).toBeTruthy();
  });

  it("maps unresolved tokens and freshness timeouts to localized retryable action errors", async () => {
    const unresolved = savedListActionError(new UnresolvedPostWriteTokenError());
    expect(unresolved.status).toBe(503);

    const timeout = savedListActionError(
      new CollectionsApiError(503, { error: { code: "projection_freshness_timeout", message: "timeout" } }),
    );
    expect(timeout.status).toBe(503);
    expect(await timeout.json()).toEqual({
      error: t("collections.features.savedLists.ui.addToList.error.description"),
    });
  });

  it("scrubs freshness and compact-token parameters from anonymous return paths", async () => {
    useTokenStore();
    mockResolveActorFromAuthApi.mockResolvedValueOnce(null);
    const createAnonymousSavedListIntent = vi.fn(async () => ({ intent: { intentId: "sli_test" } }));
    mockCreateCollectionsRequestApiClient.mockReturnValueOnce({ createAnonymousSavedListIntent });
    const response = await prepareSavedListAddition({
      request: new Request(
        "https://marketplace.test/search?q=pikachu&postWriteToken=pwt_test0000000001&afterWrite=secret&postWriteHandoff=secret&claimSavedListIntent=old",
        { headers: { authorization: "Bearer test" } },
      ),
      product,
      productLabel: "Pikachu · Near Mint",
      sourceSurface: "search",
    });
    expect(response.status).toBe(200);
    expect(createAnonymousSavedListIntent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sourcePath: "/search?q=pikachu", sourceSurface: "search" }),
    );
    expect(((await response.json()) as { href: string }).href).toContain(
      "returnTo=%2Fsearch%3Fq%3Dpikachu%26claimSavedListIntent%3Dsli_test",
    );
  });
});
