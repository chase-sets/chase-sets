import { afterEach, describe, expect, it, vi } from "vitest";

const { mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
  };
});

import { action as accountSupportAction } from "../routes/marketplace/account-support";
import { action as platformFeedbackDetailAction } from "../routes/admin/platform-feedback-detail";
import { action as projectionOperationsAction } from "../routes/admin/projection-operations";
import { action as releaseControlsAction } from "../routes/admin/release-controls";
import { action as supportOperationsAction } from "../routes/admin/requests";

function formRequest(url: string, form: URLSearchParams) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: "session=abc" },
    body: form.toString(),
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureRedirect(actionCall: Promise<unknown>) {
  try {
    return (await actionCall) as Response;
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }
}

describe("platform operations mutation consistency route actions", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("refetches the selected projection operations console after operator writes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({
      intent: "rebuild-group",
      contextName: "catalog",
      projectionName: "catalog-item-projection",
    });

    const response = (await projectionOperationsAction({
      request: formRequest("http://localhost/platform/projections?tab=groups&selected=catalog", form),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://localhost/api/platform/projections/groups/catalog/catalog-item-projection/rebuild"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ confirm: "rebuild" }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/platform/projections?tab=groups&selected=catalog");
  });

  it("refetches release controls after command-owned policy snapshots are accepted", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        releaseLock: { locked: true, reason: "incident", reference: "inc_1" },
        rolloutPolicies: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({
      intent: "set-release-lock",
      releaseAction: "lock",
      releaseReason: "incident",
      releaseReference: "inc_1",
    });

    const response = (await releaseControlsAction({
      request: formRequest("http://localhost/platform/release-controls?releaseAction=lock", form),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/platform/release-controls/release-lock",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ locked: true, reason: "incident", reference: "inc_1" }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/platform/release-controls?releaseAction=lock");
  });

  it("refetches platform feedback detail after review snapshots", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "pfb_1", version: 2, status: "reviewed" }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({ intent: "review" });

    const response = await captureRedirect(
      platformFeedbackDetailAction({
        request: formRequest("http://localhost/support/platform-feedback/pfb_1", form),
        params: { id: "pfb_1" },
        context: undefined,
      } as never),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/experience/platform-feedback/pfb_1/review",
      expect.objectContaining({ method: "POST" }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/support/platform-feedback/pfb_1");
  });

  it("redirects support operations with the escalation snapshot counts", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ escalated: 2, skipped: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({ intent: "escalate-overdue" });

    const response = (await supportOperationsAction({
      request: formRequest("http://localhost/support/requests", form),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/marketplace/support-requests/ops/escalate-overdue",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ limit: 100 }) }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/support/requests?escalated=2&skipped=1");
  });

  it("redirects account support with the opened request snapshot id for list refetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "sup_1", version: 1, status: "opened" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["support.manage"] });
    const form = new URLSearchParams({
      orderId: "ord_1",
      flowType: "product-not-received",
      openedByRole: "buyer",
    });

    const response = (await accountSupportAction({
      request: formRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockRequireActorFromAuthApi).toHaveBeenCalledWith({
      request: expect.any(Request),
      permission: "support.manage",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/marketplace/support-requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          orderId: "ord_1",
          flowType: "product-not-received",
          openedByRole: "buyer",
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/support?opened=sup_1");
  });
});
