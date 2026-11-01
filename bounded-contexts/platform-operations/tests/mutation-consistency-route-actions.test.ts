// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt } from "@chase-sets/http/responses";
import { getSupportFlowDefinition } from "../features/support-requests/domain/flow-catalog";
import type { SupportParticipantPolicy } from "../features/support-requests/api/support-flow-projection";

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
import {
  multipartRequest,
  openingPhotoForm,
  streamedIntakeRequest,
} from "../features/support-requests/tests/attachment-intake.test-support";
import {
  SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES,
  SUPPORT_ATTACHMENT_INTAKE_DEADLINE_MS,
} from "../features/support-requests/api/attachment-intake";
import {
  action as accountSupportDetailAction,
  loader as accountSupportDetailLoader,
} from "../routes/marketplace/account-support-detail";
import { action as platformFeedbackDetailAction } from "../routes/admin/platform-feedback-detail";
import { action as platformFeedbackListAction } from "../routes/admin/platform-feedback";
import { action as projectionOperationsAction } from "../routes/admin/projection-operations";
import { action as projectionOperationsReferenceAction } from "../routes/admin/projection-operations-reference";
import { action as supportOperationsDetailAction } from "../routes/admin/request-detail";
import { action as supportOperationsAction } from "../routes/admin/requests";

function formRequest(url: string, form: URLSearchParams) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie: "session=abc",
      "content-length": String(new TextEncoder().encode(form.toString()).length),
    },
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
  for (const scenario of ["declared-over", "stream-over", "cap", "stalled"] as const) {
    it(`bounds opening intake ${scenario} before uploads`, async () => {
      mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const cap = SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES;
      const request = streamedIntakeRequest(
        "http://localhost/account/support",
        scenario === "stream-over" ? cap + 1 : cap,
        scenario === "declared-over" ? cap + 1 : cap,
        scenario === "stalled",
      );
      const parse = vi.spyOn(Response.prototype, "formData");
      if (scenario === "stalled") vi.useFakeTimers();
      try {
        const pending = accountSupportAction({ request, params: {}, context: undefined } as never);
        if (scenario === "stalled") await vi.advanceTimersByTimeAsync(SUPPORT_ATTACHMENT_INTAKE_DEADLINE_MS);
        await pending;
        expect(parse).toHaveBeenCalledTimes(scenario === "cap" ? 1 : 0);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
        vi.useRealTimers();
      }
    });
  }

  it("accepts five opening files plus hidden fields, but rejects file six before parsing", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) =>
      String(input).endsWith("/attachments")
        ? jsonResponse({ attachments: [{ reference: `support-attachment:v1:sea_photo:${"a".repeat(64)}:jpg` }] })
        : jsonResponse({ id: "sup_1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    for (const count of [5, 6]) {
      fetchMock.mockClear();
      const request = await multipartRequest("http://localhost/account/support", await openingPhotoForm(count));
      const parse = vi.spyOn(Response.prototype, "formData");
      const decode = vi.spyOn(File.prototype, "arrayBuffer");
      try {
        const result = await accountSupportAction({ request, params: {}, context: undefined } as never);
        if (count === 5) {
          expect(result).toBeInstanceOf(Response);
          expect(fetchMock).toHaveBeenCalledTimes(2);
          expect(
            new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).get("x-support-attachment-operation-id"),
          ).toBe("sao_01ARZ3NDEKTSV4RRFFQ69G5FAV");
        } else {
          expect(result).toMatchObject({ error: expect.any(String) });
          expect(parse).not.toHaveBeenCalled();
          expect(decode).not.toHaveBeenCalled();
          expect(fetchMock).not.toHaveBeenCalled();
        }
      } finally {
        parse.mockRestore();
        decode.mockRestore();
      }
    }
  });

  it("recovers one id after ambiguity and refuses a second upload on retry; kills fresh retry id mutant", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    const fetchMock = vi.fn(async () => {
      throw new Error("Connection lost after dispatch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const form = await openingPhotoForm(1);
    const first = await accountSupportAction({
      request: await multipartRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never);
    expect(first).toMatchObject({
      attachmentOperationId: form.get("attachmentOperationId"),
      recoverySupportRequestId: "sup_1",
      uploadUncertain: true,
    });
    form.set("uploadUncertain", "true");
    const retry = await accountSupportAction({
      request: await multipartRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never);
    expect(retry).toMatchObject({
      attachmentOperationId: form.get("attachmentOperationId"),
      recoverySupportRequestId: "sup_1",
      uploadUncertain: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a dropped operation field without opening or uploading", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const form = await openingPhotoForm(1);
    form.delete("attachmentOperationId");
    const result = await accountSupportAction({
      request: await multipartRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never);
    expect(result).toMatchObject({ error: expect.stringContaining("batch id") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the operation id after a staged conflict and retries the same batch", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", tenantId: "tnt_identity" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Staged conflict" } }, 409))
      .mockResolvedValueOnce(
        jsonResponse({ attachments: [{ reference: `support-attachment:v1:sea_photo:${"a".repeat(64)}:jpg` }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "sup_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const form = await openingPhotoForm(1);
    const first = await accountSupportAction({
      request: await multipartRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never);
    expect(first).toMatchObject({ attachmentOperationId: form.get("attachmentOperationId"), uploadUncertain: false });
    const result = await accountSupportAction({
      request: await multipartRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never);
    expect(result).toBeInstanceOf(Response);
    for (const call of fetchMock.mock.calls.slice(0, 2))
      expect(new Headers((call[1] as RequestInit).headers).get("x-support-attachment-operation-id")).toBe(
        form.get("attachmentOperationId"),
      );
  });
  it("rejects opening intake without Content-Length before parsing; kills API-only bound mutant", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://localhost/account/support", {
      method: "POST",
      body: new URLSearchParams({ orderId: "ord_1" }),
    });
    const parse = vi.spyOn(request, "formData");
    const result = await accountSupportAction({ request, params: {}, context: undefined } as never);
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(parse).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
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
      request: formRequest("http://localhost/platform/projections?selected=catalog", form),
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
    expect(response.headers.get("Location")).toBe("/platform/projections?selected=catalog");
  });

  it("refetches the selected projection reference destination after drawer actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ accepted: true }, 202)),
    );
    const form = new URLSearchParams({
      intent: "retry-stream",
      projectionKey: "catalog.catalog-item-projection",
      streamId: "catalog.item-1",
    });

    const response = (await projectionOperationsReferenceAction({
      request: formRequest(
        "http://localhost/platform/projections/reference?search=catalog&selected=catalog.item-1",
        form,
      ),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/platform/projections/reference?search=catalog&selected=catalog.item-1",
    );
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

  it.each(["whole-order", "explicit-line"] as const)(
    "opens %s account support and redirects for list refetch",
    async (scope) => {
      const lines = scope === "whole-order" ? [] : ["line_1"];
      const fetchMock = vi.fn(async () => jsonResponse({ id: "sup_1", version: 1, status: "opened" }, 201));
      vi.stubGlobal("fetch", fetchMock);
      mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["support.manage"] });
      const form = new URLSearchParams({
        orderId: "ord_1",
        flowType: "product-not-received",
      });
      lines.forEach((lineId) => form.append("affectedLineIds", lineId));

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
            ...(lines.length ? { affectedLineIds: lines } : {}),
            intakePhotoReferences: [],
          }),
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/account/support/sup_1");
    },
  );

  it("lets the API reject missing required photos instead of trusting the posted boolean", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: "Add the required evidence photos before opening this case." } }, 400),
    );
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries recovered references under the original upload operation (mutant: omit or replace recovery id)", async () => {
    const reference =
      "support-attachment:v1:sea_photo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:jpg";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/support-requests")) {
        return jsonResponse({ id: "sup_1", version: 2, status: "opened" });
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
      attachmentOperationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });

    const response = (await accountSupportAction({
      request: formRequest("http://localhost/account/support", form),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/marketplace/support-requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          orderId: "ord_1",
          flowType: "product-damaged",
          intakePhotoReferences: [reference],
          attachmentOperationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/support/sup_1");
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

  it("loads participant-scoped case detail with the viewer role and catalog truth", async () => {
    const participantPolicy: SupportParticipantPolicy = {
      nextActor: "buyer",
      deadlineAt: "2026-10-13T12:00:00.000Z",
      actions: [{ kind: "escalate" }, { kind: "cancel" }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://localhost/api/marketplace/support-requests/sup_1");
      return jsonResponse({
        support_request_id: "sup_1",
        display_reference: "SUP-CASEDETA",
        buyer_account_id: "acc_buyer",
        seller_account_id: "acc_seller",
        opened_by_account_id: "acc_buyer",
        flow_type: "product-damaged",
        flow: getSupportFlowDefinition("product-damaged"),
        participantPolicy,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["support.view"] });

    const result = (await accountSupportDetailLoader({
      request: new Request("http://localhost/account/support/sup_1", { headers: { cookie: "session=abc" } }),
      params: { id: "sup_1" },
      context: undefined,
    } as never)) as {
      viewerRole: string;
      participantPolicy: SupportParticipantPolicy;
      flow: { flowType: string; automationSummary: string };
    };

    expect(mockRequireActorFromAuthApi).toHaveBeenCalledWith({
      request: expect.any(Request),
      permission: "support.view",
    });
    expect(result.viewerRole).toBe("buyer");
    expect(result.participantPolicy).toEqual(participantPolicy);
    expect(result.flow.flowType).toBe("product-damaged");
    expect(result.flow.automationSummary).toContain("If the seller does not respond by the deadline");
  });

  it.each([
    [
      "evidence",
      new URLSearchParams({
        intent: "evidence",
        submittedByRole: "buyer",
        evidenceType: "photo",
        summary: "Damaged corner",
      }),
      "http://localhost/api/marketplace/support-requests/sup_1/evidence",
      { submittedByRole: "buyer", evidenceType: "photo", summary: "Damaged corner" },
      "evidence",
    ],
    [
      "response",
      new URLSearchParams({
        intent: "response",
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        summary: "Offer five dollars",
        offerResolutionType: "partial-refund",
        refundAmount: "5.00",
      }),
      "http://localhost/api/marketplace/support-requests/sup_1/responses",
      {
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        summary: "Offer five dollars",
        refundAmount: "5.00",
      },
      "response",
    ],
    [
      "accept-offer",
      new URLSearchParams({ intent: "accept-offer", offerId: "sof_1" }),
      "http://localhost/api/marketplace/support-requests/sup_1/offers/sof_1/accept",
      {},
      "offerAccepted",
    ],
    [
      "decline-offer",
      new URLSearchParams({ intent: "decline-offer", offerId: "sof_1", summary: "Needs review" }),
      "http://localhost/api/marketplace/support-requests/sup_1/offers/sof_1/decline",
      { summary: "Needs review" },
      "offerDeclined",
    ],
    [
      "escalate",
      new URLSearchParams({ intent: "escalate", reason: "Needs review" }),
      "http://localhost/api/marketplace/support-requests/sup_1/escalate",
      { reason: "Needs review" },
      "escalated",
    ],
    [
      "cancel",
      new URLSearchParams({ intent: "cancel", reason: "Opened by mistake" }),
      "http://localhost/api/marketplace/support-requests/sup_1/cancel",
      { reason: "Opened by mistake" },
      "cancelled",
    ],
  ] as const)("refetches participant case detail after %s", async (_intent, form, url, body, actionResult) => {
    const fetchMock = vi.fn(async () => commandJsonResponse({ id: "sup_1", version: 3, status: actionResult }));
    vi.stubGlobal("fetch", fetchMock);
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["support.manage"] });

    const response = await captureRedirect(
      accountSupportDetailAction({
        request: formRequest("http://localhost/account/support/sup_1", form),
        params: { id: "sup_1" },
        context: undefined,
      } as never),
    );

    expect(mockRequireActorFromAuthApi).toHaveBeenCalledWith({
      request: expect.any(Request),
      permission: "support.manage",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "", "http://localhost");
    expect(location.pathname).toBe("/account/support/sup_1");
    expect(location.searchParams.get("action")).toBe(actionResult);
    expect(location.searchParams.get("afterWrite")).toBeTruthy();
  });
});

describe("marketplace response removal", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([null, "partial-refund", "replacement"])(
    "response action ignores retired resolution field: %s",
    async (retiredResolution) => {
      mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", tenantId: "ten_1" });
      const fetchMock = vi.fn<typeof fetch>(async () =>
        commandJsonResponse({ id: "sup_1", version: 3, status: "response-recorded" }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const form = new URLSearchParams({
        intent: "response",
        participantAttemptId: "10797_response_0123456789abcdef",
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        summary: "Offer five dollars",
        refundAmount: "5.00",
      });
      if (retiredResolution !== null) form.set("offerResolutionType", retiredResolution);
      const response = await accountSupportDetailAction({
        request: formRequest("http://localhost/account/support/sup_1", form),
        params: { id: "sup_1" },
        context: undefined,
      } as never);
      expect(response).toBeInstanceOf(Response);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        summary: "Offer five dollars",
        refundAmount: "5.00",
      });
      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe(
        form.get("participantAttemptId"),
      );
    },
  );

  it.each(["confirming", "committed"])(
    "response removal preserves retained attempt recovery: old explicit %s lookup never redispatches",
    async (outcome) => {
      mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", tenantId: "ten_1" });
      const descriptor = {
        actionKind: "record-response",
        targetId: "sup_1",
        attemptId: "10797_response_0123456789abcdef",
        requestHash: "3ba438568581f403087dcb003a79786b107e03b530c3d82b9e13318fe233bd69",
      };
      const fetchMock = vi.fn<typeof fetch>(async () =>
        commandJsonResponse({
          outcome,
          actionKind: "record-response",
          result: {
            id: "sup_1",
            version: 3,
            status: "response-recorded",
            evidenceId: null,
            responseId: "srp_1",
            offerId: "sof_1",
          },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const response = await accountSupportDetailAction({
        request: formRequest(
          "http://localhost/account/support/sup_1",
          new URLSearchParams({
            intent: "response",
            responseType: "offer-partial-refund",
            offerResolutionType: "partial-refund",
            participantRecovery: JSON.stringify({
              phase: "ambiguous",
              descriptor,
              accountId: "acc_seller",
              tenantId: "ten_1",
            }),
          }),
        ),
        params: { id: "sup_1" },
        context: undefined,
      } as never);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).headers.get("Location")).toContain("action=response");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `http://localhost/api/marketplace/support-requests/sup_1/participant-attempts/${descriptor.attemptId}?requestHash=${descriptor.requestHash}&actionKind=record-response`,
      );
      expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
    },
  );

  it("response removal preserves retained attempt recovery: failed-safe no-descriptor retry sends omission", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", tenantId: "ten_1" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "validation_failed" } }, 400))
      .mockResolvedValueOnce(commandJsonResponse({ id: "sup_1", version: 3, status: "response-recorded" }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new URLSearchParams({
      intent: "response",
      participantAttemptId: "10797_response_0123456789abcdef",
      submittedByRole: "seller",
      responseType: "offer-partial-refund",
      summary: "Offer five dollars",
      offerResolutionType: "partial-refund",
      refundAmount: "5.00",
    });
    const submit = () =>
      accountSupportDetailAction({
        request: formRequest("http://localhost/account/support/sup_1", form),
        params: { id: "sup_1" },
        context: undefined,
      } as never);
    expect(await submit()).toMatchObject({ participantRecovery: { phase: "failed-safe", descriptor: null } });
    expect(await submit()).toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("offerResolutionType");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(form.get("participantAttemptId"));
    }
  });
});
