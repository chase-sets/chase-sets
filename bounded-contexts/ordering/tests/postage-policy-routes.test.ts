import { describe, expect, it, vi, afterEach } from "vitest";
import {
  appendFreshWriteToken,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeCommitReceipt,
} from "@chase-sets/http/responses";
import { loader as detailLoader } from "../routes/admin/postage-policies-detail";
import { action as listAction, loader as listLoader } from "../routes/admin/postage-policies";
import { jsonResponse, requestUrl } from "./test-support/http";

const orderingCommit = {
  sourceContextName: "ordering",
  maxGlobalPosition: "44",
  eventIds: ["evt_postage_policy"],
};

const policy = {
  policy_id: "opp_1",
  label: "Default postage policy",
  status: "draft",
  policy_version: "operator-postage-v1",
  payload: {
    policyVersion: "operator-postage-v1",
    maxLetterUnits: 8,
    maxLetterWeightOunces: 3,
    maxLetterThicknessInches: 0.25,
    maxLetterDeclaredValueAmount: 100,
    letterEnvelopeWeightOunces: 0.2,
    parcelPackagingWeightOunces: 4,
    parcelRequiredShippingOptions: [],
    letterRequiredPhysicalFlags: [],
    parcelRequiredPhysicalFlags: [],
    signatureRequiredShippingOptions: [],
    signatureRequiredDeclaredValueAmount: null,
    signatureRequiredPhysicalFlags: [],
    insuranceRequiredDeclaredValueAmount: null,
  },
  effective_from: "2026-06-01T00:00:00.000Z",
  effective_until: null,
  activation_reason: null,
  created_by_user_id: "usr_admin",
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-01T00:00:00.000Z",
  activated_at: null,
  retired_at: null,
  history: [],
  activeComparison: [],
};

describe("ordering postage policy routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("keeps list creates on the lifecycle home and opens the new draft drawer with the Ordering commit receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/marketplace/admin/postage-policies")) {
          return Promise.resolve(
            jsonResponse({ id: "opp_1", version: 1 }, 201, {
              "Chase-Sets-Consistency": "committed",
              [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([orderingCommit]),
            }),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = await listAction({
      request: new Request("http://localhost/commerce/postage-policies", {
        method: "POST",
        body: new URLSearchParams({
          label: "Default postage policy",
          effectiveFrom: "2026-06-01T00:00:00.000Z",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    const location = (response as Response).headers.get("Location") ?? "";
    expect(location).toContain("/commerce/postage-policies?policy=opp_1");
    expect(location).toContain("afterWrite=");
  });

  it("forwards fresh-write metadata when the list reloads after create", async () => {
    const fetchCalls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        fetchCalls.push(request);
        return Promise.resolve(jsonResponse({ items: [policy], total: 1, count: 1 }));
      }),
    );

    const result = await listLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/commerce/postage-policies", { commitPositions: [orderingCommit] }, Date.now())}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.items).toHaveLength(1);
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("ordering");
  });

  it("returns temporary recovery when the fresh postage policy list is still catching up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/admin/postage-policies")) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: "Projection did not catch up.",
                },
              },
              503,
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = (await listLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/commerce/postage-policies",
          { commitPositions: [orderingCommit] },
          Date.now(),
        )}`,
      ),
      params: {},
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Preparing postage policies");
  });

  it("loads selected policy detail for the home drawer", async () => {
    const fetchCalls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        fetchCalls.push(request);
        const url = requestUrl(request);
        if (url.includes("/api/marketplace/admin/postage-policies/opp_1")) {
          return Promise.resolve(jsonResponse(policy));
        }
        if (url.includes("/api/marketplace/admin/postage-policies")) {
          return Promise.resolve(jsonResponse({ items: [policy], total: 1, count: 1 }));
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await listLoader({
      request: new Request("http://localhost/commerce/postage-policies?policy=opp_1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.items).toHaveLength(1);
    expect(result.selectedPolicy?.policy_id).toBe("opp_1");
    expect(fetchCalls).toHaveLength(2);
  });

  it("returns postage preview snapshots on the lifecycle home without redirecting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/marketplace/admin/postage-policies/preview")) {
          return Promise.resolve(
            jsonResponse({
              packagePlan: {
                packagePlanVersion: "measured-package-plan-v1",
                packageCount: 1,
                packages: [],
                letterEligibility: { eligible: true, reasons: [] },
                postagePolicySnapshot: {
                  policyVersion: "operator-postage-v1",
                  parcelRequired: false,
                  parcelReasons: [],
                  signatureRequired: false,
                  signatureReasons: [],
                  insuranceRequired: false,
                  insuranceReasons: [],
                  insuredValueAmount: null,
                  shippingEvidenceTier: "letter-untracked",
                },
                missingProductIds: [],
              },
            }),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await listAction({
      request: new Request("http://localhost/commerce/postage-policies?policy=opp_1", {
        method: "POST",
        body: new URLSearchParams({
          intent: "preview",
          policyId: "opp_1",
          label: "Default postage policy",
          effectiveFrom: "2026-06-01T00:00:00.000Z",
          previewShippingOption: "standard",
          previewItemSubtotalAmount: "25.00",
          previewQuantity: "1",
          previewUnitLengthInches: "3.5",
          previewUnitWidthInches: "2.5",
          previewUnitHeightInches: "0.016",
          previewUnitWeightOunces: "0.05",
          previewPhysicalFlags: "raw-card",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      preview: {
        packagePlan: {
          postagePolicySnapshot: {
            policyVersion: "operator-postage-v1",
          },
        },
      },
    });
  });

  it("keeps lifecycle commands on the home drawer with the Ordering commit receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/marketplace/admin/postage-policies/opp_1/activate")) {
          return Promise.resolve(
            jsonResponse({ id: "opp_1", version: 2 }, 200, {
              "Chase-Sets-Consistency": "committed",
              [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([orderingCommit]),
            }),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = await listAction({
      request: new Request("http://localhost/commerce/postage-policies?policy=opp_1", {
        method: "POST",
        body: new URLSearchParams({
          intent: "activate",
          policyId: "opp_1",
          activationReason: "Reviewed policy thresholds.",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    const location = (response as Response).headers.get("Location") ?? "";
    expect(location).toContain("/commerce/postage-policies?policy=opp_1");
    expect(location).toContain("afterWrite=");
  });

  it("forwards fresh-write metadata to list and selected detail after a lifecycle command", async () => {
    const fetchCalls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        fetchCalls.push(request);
        const url = requestUrl(request);
        return Promise.resolve(
          url.includes("/api/marketplace/admin/postage-policies/opp_1")
            ? jsonResponse(policy)
            : jsonResponse({ items: [policy], total: 1, count: 1 }),
        );
      }),
    );

    const result = await listLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/commerce/postage-policies?policy=opp_1", { commitPositions: [orderingCommit] }, Date.now())}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.selectedPolicy?.policy_id).toBe("opp_1");
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("ordering");
    expect(fetchCalls[1]?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(fetchCalls[1]?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("ordering");
  });

  it("redirects legacy detail URLs to the selected policy drawer", async () => {
    const response = await detailLoader({
      request: new Request("http://localhost/commerce/postage-policies/opp_1?afterWrite=receipt"),
      params: { id: "opp_1" },
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe(
      "/commerce/postage-policies?afterWrite=receipt&policy=opp_1",
    );
  });

  it("returns temporary recovery when the selected postage policy is still catching up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/admin/postage-policies/opp_1")) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: "Projection did not catch up.",
                },
              },
              503,
            ),
          );
        }

        if (url.includes("/api/marketplace/admin/postage-policies")) {
          return Promise.resolve(jsonResponse({ items: [policy], total: 1, count: 1 }));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = (await listLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/commerce/postage-policies?policy=opp_1",
          { commitPositions: [orderingCommit] },
          Date.now(),
        )}`,
      ),
      params: {},
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Preparing postage policies");
  });
});
