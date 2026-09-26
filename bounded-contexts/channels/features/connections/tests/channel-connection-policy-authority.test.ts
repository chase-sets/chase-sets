import { describe, expect, it, vi } from "vitest";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createConnectionPolicyAuthority } from "../api/policy-authority";
import { tcgplayerStagedImportPolicy } from "../../tcgplayer-csv/domain/policy";

const input = { accountId: "account", connectionId: "connection", policyKey: tcgplayerStagedImportPolicy.policyKey };

describe("channel-connection-policy-authority", () => {
  function policies() {
    const resolution = vi.fn<PolicyRuntime["resolvePolicy"]>();
    const resolvePolicy: PolicyRuntime["resolvePolicy"] = async (definition, params) => ({
      ...(await resolution(definition, params)),
      value: definition.defaultValue,
    });
    return {
      resolvePolicy,
      resolution,
      getPolicyDocument: vi.fn<PolicyRuntime["getPolicyDocument"]>(),
    };
  }

  it("reports compiled fallback revision zero as complete without reading a document", async () => {
    const port = policies();
    port.resolution.mockResolvedValue({
      policyKey: input.policyKey,
      documentId: null,
      value: {},
      source: "fallback",
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-09-20T00:00:00Z",
    });
    expect(await createConnectionPolicyAuthority(port).resolve(input)).toEqual({
      policyKey: input.policyKey,
      revision: 0,
      status: "complete",
    });
    expect(port.resolution).toHaveBeenCalledWith(tcgplayerStagedImportPolicy, undefined);
    expect(port.getPolicyDocument).not.toHaveBeenCalled();
  });

  it("reports stored history length, not a made-up resolver revision", async () => {
    const port = policies();
    port.resolution.mockResolvedValue({
      policyKey: input.policyKey,
      documentId: "document",
      value: {},
      source: "policy",
      effectiveFrom: "2026-01-01T00:00:00Z",
      effectiveUntil: null,
      resolvedAt: "2026-09-20T00:00:00Z",
    });
    const row = {
      document_id: "document",
      policy_key: input.policyKey,
      context_name: "channels",
      schema_summary: "test",
      status: "active",
      value: {},
      effective_from: "2026-01-01T00:00:00Z",
      effective_until: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const history = {
      history_id: "history",
      event_id: "event",
      document_id: "document",
      policy_key: input.policyKey,
      event_type: "created",
      actor_user_id: "user",
      status: "active",
      value: {},
      effective_from: row.effective_from,
      effective_until: null,
      recorded_at: row.created_at,
    };
    port.getPolicyDocument.mockResolvedValue({ ...row, history: [history, { ...history, history_id: "history-2" }] });
    expect(await createConnectionPolicyAuthority(port).resolve(input)).toEqual({
      policyKey: input.policyKey,
      revision: 2,
      status: "complete",
    });
    expect(port.getPolicyDocument).toHaveBeenCalledWith("document");
  });

  it.each(["resolver", "document", "missing", "history"])("fails closed for %s failure", async (kind) => {
    const port = policies();
    port.resolution.mockResolvedValue({
      policyKey: input.policyKey,
      documentId: "document",
      value: {},
      source: "policy",
      effectiveFrom: "2026-01-01T00:00:00Z",
      effectiveUntil: null,
      resolvedAt: "2026-09-20T00:00:00Z",
    });
    if (kind === "resolver") port.resolution.mockRejectedValue(new Error("unavailable"));
    if (kind === "document") port.getPolicyDocument.mockRejectedValue(new Error("unavailable"));
    if (kind === "missing") port.getPolicyDocument.mockResolvedValue(null);
    expect(await createConnectionPolicyAuthority(port).resolve(input)).toEqual({
      policyKey: input.policyKey,
      revision: 0,
      status: "incomplete",
    });
  });
});
