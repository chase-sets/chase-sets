import { describe, expect, it, vi } from "vitest";
import { createPricingApiClient, PricingApiError, pricingValidationMessages } from "./api-client";
import { dryRunBody } from "../../features/repricing-engine/tests/dry-run-fixture";
import { getResponseMetadata } from "@chase-sets/http/responses";

const policy = {
  ...dryRunBody,
  excludedListingIds: [],
  policyId: "rpp_synthetic",
  accountId: "acc_synthetic",
  name: "Installed",
  status: "active",
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-17T00:00:00Z",
};

describe("Pricing authoring client", () => {
  it("separates installed reads from pending requests and retains read freshness metadata", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = createPricingApiClient({ baseUrl: "https://synthetic.test", fetch });
    const request = { requestKey: "synthetic-pending", requestedRevision: 2, status: "accepted-pending" };
    const configuration = { installedRevision: 1, installedState: null, requestedRevision: 2, request };
    const headers = { "Chase-Sets-Consistency": "eventual" };
    fetch.mockResolvedValueOnce(Response.json([{ ...policy, configuration, changesUsedToday: 0 }], { headers }));
    const list = await api.listRepricingPolicies();
    expect(list[0]).toMatchObject({ name: "Installed", configuration });
    expect(getResponseMetadata(list)?.consistency?.mode).toBe("eventual");
    fetch.mockResolvedValueOnce(Response.json({ ...policy, configuration }, { headers }));
    const detail = await api.getRepricingPolicy("rpp_synthetic");
    expect(detail).toMatchObject({ name: "Installed", configuration });
    expect(getResponseMetadata(detail)?.consistency?.mode).toBe("eventual");
    fetch.mockResolvedValueOnce(
      Response.json({ engaged: true, engagedAt: "2026-11-17T00:00:00Z", releasedAt: null, configuration }),
    );
    expect(await api.getRepricingHalt()).toMatchObject({ engaged: true, configuration });
    for (const malformed of [
      { ...configuration, requestedRevision: Number.MAX_SAFE_INTEGER },
      { ...configuration, request: { ...request, state: policy } },
      { ...configuration, request: null },
      {
        ...configuration,
        request: { ...request, status: "applied", installedRevision: 2, state: { ...policy, rules: [] } },
      },
    ]) {
      fetch.mockResolvedValueOnce(Response.json({ ...policy, configuration: malformed }));
      await expect(api.getRepricingPolicy("rpp_synthetic")).rejects.toThrow();
    }
  });
  it("apply-goal pending and superseded results are receipts, not successful goal application", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = createPricingApiClient({ baseUrl: "https://synthetic.test", fetch });
    const body = {
      dryRunId: "synthetic-run",
      targetRevision: 1,
      targetBodyHash: "target",
      candidateBodyHash: "candidate",
      goalId: "fixed-percentile",
      goalVersion: 1,
      parameters: { percentile: 65 },
    };
    for (const status of ["accepted-pending", "superseded-by-revision"] as const) {
      const receipt = {
        requestKey: "synthetic-goal",
        requestedRevision: 2,
        status,
        ...(status === "superseded-by-revision" ? { replacingRevision: 3 } : {}),
      };
      fetch.mockResolvedValueOnce(Response.json(receipt, { status: status === "accepted-pending" ? 202 : 409 }));
      expect(await api.applyPricingHealthGoal("rpp_synthetic", body)).toEqual(receipt);
      fetch.mockResolvedValueOnce(Response.json(receipt));
      await expect(api.applyPricingHealthGoal("rpp_synthetic", body)).rejects.toMatchObject({ status: 502 });
    }
    const applied = {
      ...body,
      status: "applied",
      requestKey: "synthetic-goal",
      requestedRevision: 2,
      installedRevision: 2,
      state: policy,
      policyId: policy.policyId,
      previousRevision: 1,
      revision: 2,
      bodyHash: "candidate",
      movement: { raised: 1, lowered: 0, held: 0 },
      alerts: { floorBinding: 0, evidenceFloorBinding: 0 },
    };
    fetch.mockResolvedValueOnce(Response.json(applied, { headers: { "Chase-Sets-Consistency": "eventual" } }));
    const result = await api.applyPricingHealthGoal(policy.policyId, body);
    expect(result).toMatchObject(applied);
    expect(getResponseMetadata(result)?.consistency?.mode).toBe("eventual");
    fetch.mockResolvedValueOnce(Response.json({ ...applied, movement: { raised: -1, lowered: 0, held: 0 } }));
    await expect(api.applyPricingHealthGoal(policy.policyId, body)).rejects.toMatchObject({ status: 502 });
  });
  it("all six writes distinguish pending, installed and superseded receipts, including typed HTTP 409", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = createPricingApiClient({ baseUrl: "https://synthetic.test", fetch });
    const key = "synthetic-key";
    const writes = [
      () => api.createRepricingPolicy({ dryRunId: "synthetic-run", name: "Requested" }, key),
      () => api.reviseRepricingPolicy("rpp_synthetic", { ...dryRunBody, name: "Requested" }, key),
      () => api.pauseRepricingPolicy("rpp_synthetic", key),
      () => api.resumeRepricingPolicy("rpp_synthetic", key),
      () => api.deleteRepricingPolicy("rpp_synthetic", key),
      () => api.setRepricingHalt(false, key),
    ];
    for (const [index, write] of writes.entries()) {
      const pending = { requestKey: key, requestedRevision: 2, status: "accepted-pending" };
      fetch.mockResolvedValueOnce(Response.json(pending, { status: 202 }));
      expect(await write()).toMatchObject(pending);
      const superseded = {
        requestKey: key,
        requestedRevision: 2,
        status: "superseded-by-revision",
        replacingRevision: 3,
      };
      fetch.mockResolvedValueOnce(Response.json(superseded, { status: 409 }));
      expect(await write()).toMatchObject(superseded);
      const applied = {
        requestKey: key,
        requestedRevision: 2,
        status: "applied",
        installedRevision: 2,
        state: index === 5 ? { engaged: false, engagedAt: null, releasedAt: "2026-11-17T00:00:00Z" } : policy,
      };
      fetch.mockResolvedValueOnce(Response.json(applied, { status: index === 0 ? 201 : 200 }));
      expect(await write()).toMatchObject(applied);
      expect(new Headers(fetch.mock.calls.at(-1)![1]?.headers).get("Idempotency-Key")).toBe(key);
      fetch.mockResolvedValueOnce(Response.json(pending));
      await expect(write()).rejects.toMatchObject({ status: 502 });
    }
  });
  it("refuses malformed nested receipts and unsafe revisions instead of coercing HTTP success into installed state", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = createPricingApiClient({ baseUrl: "https://synthetic.test", fetch });
    for (const body of [
      policy,
      { requestKey: "x", requestedRevision: Number.MAX_SAFE_INTEGER, status: "accepted-pending" },
      { requestKey: "x", requestedRevision: 2, status: "accepted-pending", state: policy },
      { requestKey: "x", requestedRevision: 2, status: "applied", installedRevision: 1, state: policy },
      {
        requestKey: "x",
        requestedRevision: 2,
        status: "applied",
        installedRevision: 2,
        state: { ...policy, rules: [] },
      },
    ]) {
      fetch.mockResolvedValueOnce(Response.json(body));
      await expect(api.pauseRepricingPolicy("rpp_synthetic")).rejects.toBeInstanceOf(PricingApiError);
    }
  });
  it("authoring prerequisites use the account route without selectors and preserve empty facts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ listingCurrencyCodes: [], hasCostBasis: false }),
    );
    const api = createPricingApiClient({ baseUrl: "https://synthetic.test", fetch });
    expect(await api.getRepricingAuthoringPrerequisites()).toMatchObject({
      listingCurrencyCodes: [],
      hasCostBasis: false,
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://synthetic.test/account/repricing-policies/authoring-prerequisites",
    );
    fetch.mockResolvedValueOnce(Response.json({ error: { code: "not_found" } }, { status: 404 }));
    await expect(api.getRepricingAuthoringPrerequisites()).rejects.toMatchObject({ status: 404 });
  });
  it("domain validation details survive the client and code-only errors do not become raw UI text", async () => {
    const message = "A repricing policy must define at least one rule.";
    const body = { error: { code: "validation_failed", message: "Invalid policy command.", details: [{ message }] } };
    const api = createPricingApiClient({
      baseUrl: "https://synthetic.test",
      fetch: async () => Response.json(body, { status: 400 }),
    });
    try {
      await api.reviseRepricingPolicy("rpp_synthetic", {
        name: "Synthetic",
        scope: { kind: "all-listings" },
        rules: [],
        maxChangesPerDay: 250,
      });
      expect.fail("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PricingApiError);
      expect((error as PricingApiError).body).toEqual(body);
      expect(pricingValidationMessages(error)).toEqual([message]);
    }
    for (const error of [
      new Error("internal-sentinel"),
      new PricingApiError(400, { error: { code: "validation_failed", message: "internal-sentinel" } }),
      new PricingApiError(500, body),
    ]) {
      expect(pricingValidationMessages(error)).toEqual([]);
    }
  });
});
