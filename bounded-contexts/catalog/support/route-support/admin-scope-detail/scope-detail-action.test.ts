import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const { mockCreateCatalogRequestApiClient } = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
}));

vi.mock("../../request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../request-support/api-client")>(
    "../../request-support/api-client",
  );
  return { ...actual, createCatalogRequestApiClient: mockCreateCatalogRequestApiClient };
});

const { action } = await import("./scope-detail-action");

function formRequest(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function runAction(fields: Record<string, string>) {
  return action({ request: formRequest(fields), params: {}, context: {} } as unknown as ActionFunctionArgs);
}

describe("Catalog scope-detail route action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches accept against the alias-equivalence command endpoint", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({ applied: [], count: 1 });
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runAction({ _intent: "accept", aliasHashes: "hash_ja_set_equivalent" });

    expect(result).toEqual({ status: "success", intent: "accept", result: "job-queued" });
    expect(dispatchCatalogAliasReviewCommand).toHaveBeenCalledWith({
      intent: "accept",
      aliasHashes: ["hash_ja_set_equivalent"],
    });
  });

  it("requires a reason for reject and revoke", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const rejectResult = await runAction({ _intent: "reject", aliasHashes: "hash_1" });
    const revokeResult = await runAction({ _intent: "revoke", aliasHashes: "hash_1" });

    expect(rejectResult).toEqual({ status: "error", intent: "reject", result: "reason-required" });
    expect(revokeResult).toEqual({ status: "error", intent: "revoke", result: "reason-required" });
    expect(dispatchCatalogAliasReviewCommand).not.toHaveBeenCalled();
  });

  it("passes the reason through once supplied", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({ applied: [], count: 1 });
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    await runAction({ _intent: "reject", aliasHashes: "hash_1", reason: "Wrong set" });

    expect(dispatchCatalogAliasReviewCommand).toHaveBeenCalledWith({
      intent: "reject",
      aliasHashes: ["hash_1"],
      reason: "Wrong set",
    });
  });

  it("acknowledges defer without dispatching a command (no aggregate transition)", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runAction({ _intent: "defer", aliasHashes: "hash_1" });

    expect(result).toEqual({ status: "success", intent: "defer", result: "job-queued" });
    expect(dispatchCatalogAliasReviewCommand).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent without calling the API", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runAction({ _intent: "auto-accept", aliasHashes: "hash_1" });

    expect(result).toEqual({ status: "error", intent: "auto-accept", result: "invalid-intent" });
    expect(dispatchCatalogAliasReviewCommand).not.toHaveBeenCalled();
  });

  it("rejects a submission with no selected candidates", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runAction({ _intent: "accept", aliasHashes: "" });

    expect(result).toEqual({ status: "error", intent: "accept", result: "no-candidates" });
    expect(dispatchCatalogAliasReviewCommand).not.toHaveBeenCalled();
  });
});
