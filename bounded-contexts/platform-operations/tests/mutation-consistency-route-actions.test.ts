import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt } from "@chase-sets/http/responses";

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

import { action as accountSupportAction, loader as accountSupportLoader } from "../routes/marketplace/account-support";
import { action as platformFeedbackDetailAction } from "../routes/admin/platform-feedback-detail";
import { action as platformFeedbackListAction } from "../routes/admin/platform-feedback";
import { action as projectionOperationsAction } from "../routes/admin/projection-operations";
import { action as supportOperationsDetailAction } from "../routes/admin/request-detail";
import { action as supportOperationsAction } from "../routes/admin/requests";

function formRequest(url: string, form: URLSearchParams) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: "session=abc" },
    body: form.toString(),
  });
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function commandJsonResponse(body: unknown, position = "42") {
  return jsonResponse(body, 200, {
    "Chase-Sets-Consistency": "eventual",
    "Chase-Sets-Commit-Position": position,
    "Chase-Sets-Commit-Event-Ids": `evt_platform_operations_${position}`,
    [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
      {
        sourceContextName: "platform-operations",
        maxGlobalPosition: position,
        eventIds: [`evt_platform_operations_${position}`],
      },
    ]),
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

  it("refetches platform feedback detail after review snapshots", async () => {
    const fetchMock = vi.fn(async () => commandJsonResponse({ id: "pfb_1", version: 2, status: "reviewed" }));
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
    expect(response.headers.get("Location")).toContain("/support/platform-feedback/pfb_1?afterWrite=");
  });

  it("refetches platform feedback detail after archive snapshots", async () => {
    const fetchMock = vi.fn(async () => commandJsonResponse({ id: "pfb_1", version: 3, status: "archived" }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({ intent: "archive" });

    const response = await captureRedirect(
      platformFeedbackDetailAction({
        request: formRequest("http://localhost/support/platform-feedback/pfb_1", form),
        params: { id: "pfb_1" },
        context: undefined,
      } as never),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/experience/platform-feedback/pfb_1/archive",
      expect.objectContaining({ method: "POST" }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/support/platform-feedback/pfb_1?afterWrite=");
  });

  it("refetches platform feedback detail after archive snapshots", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "pfb_1", version: 3, status: "archived" }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({ intent: "archive" });

    const response = await captureRedirect(
      platformFeedbackDetailAction({
        request: formRequest("http://localhost/support/platform-feedback/pfb_1", form),
        params: { id: "pfb_1" },
        context: undefined,
      } as never),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/experience/platform-feedback/pfb_1/archive",
      expect.objectContaining({ method: "POST" }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/support/platform-feedback/pfb_1");
  });

  it("refetches platform feedback queues after bulk snapshots", async () => {
    const fetchMock = vi.fn(async () =>
      commandJsonResponse({
        action: "reviewed",
        updated: 1,
        skipped: 0,
        items: [{ id: "pfb_1", version: 2, status: "reviewed" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({ intent: "bulk-review", feedbackIds: "pfb_1" });

    const response = await captureRedirect(
      platformFeedbackListAction({
        request: formRequest("http://localhost/support/platform-feedback?status=new", form),
        params: {},
        context: undefined,
      } as never),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/experience/platform-feedback/bulk/review",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ feedbackIds: ["pfb_1"] }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/support/platform-feedback?status=new&afterWrite=");
  });

  it("refetches platform feedback detail after operator note snapshots", async () => {
    const fetchMock = vi.fn(async () => commandJsonResponse({ id: "pfb_1", version: 3, noteId: "pfn_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({ intent: "record-note", body: "Follow up." });

    const response = await captureRedirect(
      platformFeedbackDetailAction({
        request: formRequest("http://localhost/support/platform-feedback/pfb_1", form),
        params: { id: "pfb_1" },
        context: undefined,
      } as never),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/experience/platform-feedback/pfb_1/notes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "Follow up." }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/support/platform-feedback/pfb_1?afterWrite=");
  });

  it("redirects support operations with the escalation snapshot counts, including whether the sweep was capped", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ escalated: 2, skipped: 1, capped: true, total: 120 }));
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
    expect(response.headers.get("Location")).toBe(
      "/support/requests?escalated=2&skipped=1&capped=true&escalationTotal=120",
    );
  });

  it("preserves the current queue's filters and pagination on the escalation redirect", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ escalated: 0, skipped: 0, capped: false, total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({ intent: "escalate-overdue" });

    const response = (await supportOperationsAction({
      request: formRequest(
        "http://localhost/support/requests?status=urgent&priority=urgent&search=ord_1&limit=25&offset=25",
        form,
      ),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "", "http://localhost");
    expect(location.searchParams.get("status")).toBe("urgent");
    expect(location.searchParams.get("priority")).toBe("urgent");
    expect(location.searchParams.get("search")).toBe("ord_1");
    expect(location.searchParams.get("limit")).toBe("25");
    expect(location.searchParams.get("offset")).toBe("25");
    expect(location.searchParams.get("escalated")).toBe("0");
    expect(location.searchParams.get("skipped")).toBe("0");
    expect(location.searchParams.get("capped")).toBe("false");
    expect(location.searchParams.get("escalationTotal")).toBe("0");
  });

  it.each([
    [
      "note",
      new URLSearchParams({ intent: "note", summary: "Operator note" }),
      "http://localhost/api/marketplace/support-requests/ops/sup_1/evidence",
      { evidenceType: "support-note", summary: "Operator note" },
    ],
    [
      "response",
      new URLSearchParams({
        intent: "response",
        responseType: "request-support-review",
        summary: "Reviewed by support",
      }),
      "http://localhost/api/marketplace/support-requests/ops/sup_1/responses",
      { responseType: "request-support-review", summary: "Reviewed by support" },
    ],
    [
      "escalate",
      new URLSearchParams({ intent: "escalate", reason: "Needs support owner" }),
      "http://localhost/api/marketplace/support-requests/ops/sup_1/escalate",
      { reason: "Needs support owner" },
    ],
    [
      "resolve",
      new URLSearchParams({
        intent: "resolve",
        resolutionType: "support-reviewed",
        summary: "Reviewed",
        refundAmount: "",
        responsibilityFinding: "undetermined|product-not-received.conflicting-evidence",
        evidenceBasisType: "insufficient-evidence",
      }),
      "http://localhost/api/marketplace/support-requests/ops/sup_1/resolve",
      {
        resolutionType: "support-reviewed",
        summary: "Reviewed",
        refundAmount: null,
        responsibility: "undetermined",
        evidenceBasis: {
          type: "insufficient-evidence",
          reference: "support-workbench.insufficient-evidence.v1",
        },
        responsibilityReasonCode: "product-not-received.conflicting-evidence",
      },
    ],
    [
      "close",
      new URLSearchParams({ intent: "close" }),
      "http://localhost/api/marketplace/support-requests/ops/sup_1/close",
      {},
    ],
    [
      "cancel",
      new URLSearchParams({ intent: "cancel", reason: "Duplicate case" }),
      "http://localhost/api/marketplace/support-requests/ops/sup_1/cancel",
      { reason: "Duplicate case" },
    ],
  ] as const)("refetches support request detail after %s actions", async (intent, form, url, body) => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "sup_1", version: 2, status: intent }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await captureRedirect(
      supportOperationsDetailAction({
        request: formRequest("http://localhost/support/requests/sup_1", form),
        params: { id: "sup_1" },
        context: undefined,
      } as never),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/support/requests/sup_1?action=${intent}`);
  });

  it("returns support drawer actions to the filtered queue with the request still selected", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "sup_1", version: 2, status: "response-recorded" }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({
      intent: "response",
      responseType: "request-support-review",
      summary: "Reviewed by support",
    });
    const returnTo = "/support/requests?status=ready-for-support&priority=urgent&search=ord_1&requestId=sup_1";

    const response = await captureRedirect(
      supportOperationsDetailAction({
        request: formRequest(`http://localhost/support/requests/sup_1?returnTo=${encodeURIComponent(returnTo)}`, form),
        params: { id: "sup_1" },
        context: undefined,
      } as never),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${returnTo}&action=response`);
  });

  it("redirects account support with the opened request snapshot id for list refetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "sup_1", version: 1, status: "opened" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["support.manage"] });
    const form = new URLSearchParams({
      orderId: "ord_1",
      flowType: "product-not-received",
      affectedLineIds: "line_1",
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
          affectedLineIds: ["line_1"],
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/support?opened=sup_1");
  });

  it("rejects missing required photos before opening a support case", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["support.manage"] });
    const form = new URLSearchParams({
      orderId: "ord_1",
      flowType: "product-damaged",
      photoRequired: "true",
    });

    const result = (await accountSupportAction({
      request: formRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never)) as { error: string; recoverySupportRequestId: string | null };

    expect(result).toMatchObject({
      error: "Add the required evidence photos before opening this case.",
      recoverySupportRequestId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries an uploaded attachment reference without opening a duplicate case", async () => {
    const reference =
      "support-attachment:v1:sea_photo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:jpg";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/support-requests/sup_1/evidence")) {
        return jsonResponse({ id: "sup_1", version: 2, status: "evidence-submitted" });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["support.manage"] });
    const form = new URLSearchParams({
      orderId: "ord_1",
      flowType: "product-damaged",
      photoRequired: "true",
      supportRequestId: "sup_1",
      uploadedAttachmentReferences: reference,
    });

    const response = (await accountSupportAction({
      request: formRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/marketplace/support-requests/sup_1/evidence",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          submittedByRole: "buyer",
          evidenceType: "photo",
          summary: "Photos submitted when the support case was opened.",
          attachments: [reference],
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/support?opened=sup_1");
  });

  it("loads account support with account-scoped order context from the query handoff", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/support-requests/flows")) {
        return jsonResponse({ items: [] });
      }
      if (url.endsWith("/support-requests/purchases") || url.endsWith("/support-requests/sales")) {
        return jsonResponse({ items: [], total: 0, count: 0 });
      }
      if (url.endsWith("/support-requests/orders/ord_1")) {
        return jsonResponse({
          orderId: "ord_1",
          openedByRole: "buyer",
          status: "ready-for-fulfillment",
          totalAmount: "24.00",
          lines: [],
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["support.view"] });

    const result = (await accountSupportLoader({
      request: new Request("http://localhost/account/support?orderId=ord_1", {
        headers: { cookie: "session=abc" },
      }),
      params: {},
      context: undefined,
    } as never)) as {
      supportOrder: {
        orderId: string;
        openedByRole: string;
        status: string;
        totalAmount: string;
        lines: readonly unknown[];
      } | null;
      lookupError: string | null;
    };

    expect(mockRequireActorFromAuthApi).toHaveBeenCalledWith({
      request: expect.any(Request),
      permission: "support.view",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/marketplace/support-requests/orders/ord_1",
      expect.any(Object),
    );
    expect(result.supportOrder).toEqual({
      orderId: "ord_1",
      openedByRole: "buyer",
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
      lines: [],
    });
    expect(result.lookupError).toBeNull();
  });
});
