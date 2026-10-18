import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configurePlatformPostWriteTokenStoreForTests,
  resolvePlatformPostWriteRequest,
} from "@chase-sets/platform-runtime/post-write-tokens";
import { UnresolvedPostWriteTokenError } from "@chase-sets/platform-runtime/http";
import { CollectionsApiError } from "@chase-sets/collections/server";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  DEFAULT_FRESH_WRITE_MAX_AGE_MS,
  decodeFreshWriteReceipt,
  type PostWriteTokenPayload,
} from "@chase-sets/http/responses";
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

import { DiscoveryApiError } from "./api-client";
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

const newList = {
  listId: "svl_new",
  title: "New Favorites",
  lineCount: 1,
  trackedUnitCount: 1,
  version: 2,
  changedAt: "2026-10-17T00:00:00.000Z",
};
const commitSource = { sourceContextName: "collections", maxGlobalPosition: "42", eventIds: ["evt_saved_list"] };
const startMs = Date.parse("2026-10-17T00:00:00.000Z");
const localizedRetry = { error: t("collections.features.savedLists.ui.addToList.error.description") };
const hostUrl = "https://marketplace.test/search?q=pikachu";

let restoreTokenStore: (() => void) | undefined;
let pickerRequests: Request[];
let pickerResponse: () => Response;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startMs);
  // Both actors resolve from the forwarded session cookie, so A/B separation is visible.
  mockResolveActorFromAuthApi.mockImplementation(async ({ request }: { request: Request }) => {
    const accountId = /(?:^|;\s*)session=(acc_\w+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    return accountId ? { accountId, permissions: ["accounts.view"] } : null;
  });
  mockCreateCollectionsRequestApiClient.mockReturnValue({
    addProductToSavedList: vi.fn(async () => ({
      listId: "svl_new",
      title: "New Favorites",
      lineStatus: "added",
      commandReceipt: { mode: "eventual", commitEventIds: commitSource.eventIds, commitPositions: [commitSource] },
    })),
  });
  pickerRequests = [];
  pickerResponse = () => Response.json({ items: [newList], total: 1, count: 1 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      pickerRequests.push(new Request(input, init));
      return pickerResponse();
    }),
  );
  // Same contract as the platform store: tokens resolve until nowMs + ttlMs.
  const stored = new Map<string, Readonly<{ payload: PostWriteTokenPayload; expiresAtMs: number }>>();
  restoreTokenStore = configurePlatformPostWriteTokenStoreForTests({
    async storePostWriteToken(payload, { nowMs, ttlMs }) {
      const token = `pwt_test${String(stored.size + 1).padStart(16, "0")}`;
      stored.set(token, { payload, expiresAtMs: nowMs + ttlMs });
      return token;
    },
    async resolvePostWriteToken(token) {
      const entry = stored.get(token);
      return entry && entry.expiresAtMs > Date.now() ? entry.payload : null;
    },
  });
});

afterEach(() => {
  restoreTokenStore?.();
  restoreTokenStore = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mintToken(cookie = "session=acc_a") {
  const formData = new FormData();
  formData.set("preparation", JSON.stringify(preparation));
  formData.set("destinationKind", "new");
  formData.set("newListTitle", "New Favorites");
  formData.set("trackedQuantity", "1");
  const response = await commitSavedListAddition(
    new Request(hostUrl, { method: "POST", headers: { cookie } }),
    formData,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { status: string; postWriteToken?: string };
  expect(body).toMatchObject({ status: "saved", postWriteToken: expect.stringMatching(/^pwt_test/) });
  return body.postWriteToken!;
}

// Mirrors the Search and Item Detail actions: the route consumes the POST body
// before the helper runs and maps any thrown error with savedListActionError.
async function prepareFromConsumedPost(postWriteToken: string | null, cookie = "session=acc_a") {
  const url = new URL(hostUrl);
  if (postWriteToken !== null) url.searchParams.set("postWriteToken", postWriteToken);
  const request = new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${cookie}`, cookie },
    body: new URLSearchParams({ intent: "prepare-saved-list" }),
  });
  await request.formData();
  const response = await prepareSavedListAddition({
    request,
    product,
    productLabel: "Pikachu · Near Mint",
    sourceSurface: "search",
  }).catch(savedListActionError);
  return { status: response.status, body: await response.json() };
}

function forwardedPickerRequest() {
  expect(pickerRequests).toHaveLength(1);
  const [request] = pickerRequests;
  const url = new URL(request!.url);
  expect(url.pathname).toBe("/api/marketplace/account/saved-lists/recent");
  expect(url.search).toBe("");
  expect(request!.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("discovery");
  return request!;
}

function readyLists(body: unknown) {
  expect(body).toMatchObject({ status: "ready", preparation: { product, productLabel: "Pikachu · Near Mint" } });
  return (body as { preparation: { recentLists: unknown[] } }).preparation.recentLists;
}

describe("Saved List addition request support", () => {
  it("mints an opaque token from the Collections command receipt before returning JSON", async () => {
    const token = await mintToken();
    const resolved = await resolvePlatformPostWriteRequest(new Request(`${hostUrl}&postWriteToken=${token}`));
    expect(decodeFreshWriteReceipt(new URL(resolved.url).searchParams.get("afterWrite"))).toEqual({
      observedAtMs: startMs,
      sources: [commitSource],
    });
  });

  describe("AC9 helper rows", () => {
    it("valid receipt: forwards only the receipt header to the picker read", async () => {
      const token = await mintToken();
      const prepared = await prepareFromConsumedPost(token);
      expect(prepared.status).toBe(200);
      expect(readyLists(prepared.body)).toEqual([newList]);
      const forwarded = forwardedPickerRequest();
      expect(decodeFreshWriteReceipt(forwarded.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER))).toEqual({
        observedAtMs: startMs,
        sources: [commitSource],
      });
    });

    it("valid token: still resolves and forwards the receipt just inside the fresh-write age", async () => {
      const token = await mintToken();
      vi.setSystemTime(startMs + DEFAULT_FRESH_WRITE_MAX_AGE_MS - 1);
      const prepared = await prepareFromConsumedPost(token);
      expect(prepared.status).toBe(200);
      expect(forwardedPickerRequest().headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(true);
    });

    it("expired receipt: a still-resolvable token whose original receipt aged out reads without a freshness claim", async () => {
      const token = await mintToken();
      vi.setSystemTime(startMs + DEFAULT_FRESH_WRITE_MAX_AGE_MS + 1);
      const prepared = await prepareFromConsumedPost(token);
      expect(prepared.status).toBe(200);
      expect(readyLists(prepared.body)).toEqual([newList]);
      expect(forwardedPickerRequest().headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(false);
    });

    it("expired token: the control drops it, so prepare is an ordinary unreceipted read", async () => {
      await mintToken();
      const prepared = await prepareFromConsumedPost(null);
      expect(prepared.status).toBe(200);
      expect(readyLists(prepared.body)).toEqual([newList]);
      expect(forwardedPickerRequest().headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(false);
    });

    it("malformed token: no resolution, no freshness claim, no error", async () => {
      await mintToken();
      const prepared = await prepareFromConsumedPost("not a token!");
      expect(prepared.status).toBe(200);
      expect(readyLists(prepared.body)).toEqual([newList]);
      expect(forwardedPickerRequest().headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(false);
    });

    it.each([
      ["unknown", () => Promise.resolve("pwt_unknown000000000000")],
      [
        "past the store TTL",
        async () => {
          const token = await mintToken();
          vi.setSystemTime(startMs + 120_001);
          return token;
        },
      ],
    ])("unresolvable token (%s): localized retryable error, no picker read", async (_name, token) => {
      const prepared = await prepareFromConsumedPost(await token());
      expect(prepared).toEqual({ status: 503, body: localizedRetry });
      expect(pickerRequests).toHaveLength(0);
    });

    it("timeout: the Discovery picker freshness timeout maps to the localized retryable error", async () => {
      const token = await mintToken();
      pickerResponse = () =>
        Response.json(
          { error: { code: "projection_freshness_timeout", message: "Projection read model did not catch up." } },
          { status: 503 },
        );
      const prepared = await prepareFromConsumedPost(token);
      expect(prepared).toEqual({ status: 503, body: localizedRetry });
      expect(JSON.stringify(prepared.body)).not.toMatch(/Projection|receipt|timeout/i);
      expect(forwardedPickerRequest().headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(true);
    });

    it("consumed-body-prepare: resolves through metadata after formData() with the receipt, actor and current query", async () => {
      const token = await mintToken();
      const consumed = new Request(`${hostUrl}&postWriteToken=${token}`, {
        method: "POST",
        headers: { authorization: "Bearer test", cookie: "session=acc_a" },
        body: new URLSearchParams({ intent: "prepare-saved-list" }),
      });
      await consumed.formData();

      const response = await prepareSavedListAddition({
        request: consumed,
        product,
        productLabel: "Pikachu · Near Mint",
        sourceSurface: "search",
      });

      expect(response.status).toBe(200);
      expect(readyLists(await response.json())).toEqual([newList]);
      const authRequest = mockResolveActorFromAuthApi.mock.calls[0]?.[0].request as Request;
      expect(authRequest.method).toBe("GET");
      expect(authRequest.bodyUsed).toBe(false);
      expect(new URL(authRequest.url).pathname).toBe("/search");
      expect(new URL(authRequest.url).searchParams.get("q")).toBe("pikachu");
      expect(new URL(authRequest.url).searchParams.has("postWriteToken")).toBe(false);
      const forwarded = forwardedPickerRequest();
      expect(forwarded.headers.get("cookie")).toBe("session=acc_a");
      expect(forwarded.headers.get("authorization")).toBe("Bearer test");
      expect(decodeFreshWriteReceipt(forwarded.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER))?.sources).toEqual([
        commitSource,
      ]);

      // Direct variant (RED control): resolving the consumed request itself, as a
      // helper without the metadata Request would, cannot rebuild the request.
      await expect(resolvePlatformPostWriteRequest(consumed)).rejects.toThrow(TypeError);
      expect(() => consumed.clone()).toThrow(TypeError);
    });

    it("actor A/B: each prepare forwards only its own credentials, and B never carries A's receipt", async () => {
      const tokenA = await mintToken("session=acc_a");
      await prepareFromConsumedPost(tokenA, "session=acc_a");
      await prepareFromConsumedPost(null, "session=acc_b");

      expect(pickerRequests).toHaveLength(2);
      const [forwardedA, forwardedB] = pickerRequests;
      expect(forwardedA!.headers.get("cookie")).toBe("session=acc_a");
      expect(forwardedA!.headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(true);
      expect(forwardedB!.headers.get("cookie")).toBe("session=acc_b");
      expect(forwardedB!.headers.get("authorization")).toBe("Bearer session=acc_b");
      expect(forwardedB!.headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(false);
    });

    it("token-bearing anonymous prepare: scrubs freshness and compact-token parameters from the return path", async () => {
      const token = await mintToken();
      const createAnonymousSavedListIntent = vi.fn(async () => ({ intent: { intentId: "sli_test" } }));
      mockCreateCollectionsRequestApiClient.mockReturnValueOnce({ createAnonymousSavedListIntent });
      const response = await prepareSavedListAddition({
        request: new Request(
          `${hostUrl}&postWriteToken=${token}&afterWrite=secret&postWriteHandoff=secret&claimSavedListIntent=old`,
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
      const href = ((await response.json()) as { href: string }).href;
      expect(href).toBe(`/register?returnTo=${encodeURIComponent("/search?q=pikachu&claimSavedListIntent=sli_test")}`);
      expect(response.headers.get("set-cookie")).toContain("chase_sets_anonymous_saved_lists=");
      expect(pickerRequests).toHaveLength(0);
    });
  });

  it("maps unresolved tokens and both contexts' freshness timeouts to localized retryable action errors", async () => {
    const timeoutBody = { error: { code: "projection_freshness_timeout", message: "timeout" } };
    for (const error of [
      new UnresolvedPostWriteTokenError(),
      new CollectionsApiError(503, timeoutBody),
      new DiscoveryApiError(503, timeoutBody),
    ]) {
      const response = savedListActionError(error);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(localizedRetry);
    }
  });
});
