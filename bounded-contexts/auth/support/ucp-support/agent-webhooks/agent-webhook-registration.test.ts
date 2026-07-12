import { describe, expect, it, vi } from "vitest";
import {
  AGENT_WEBHOOK_ORDER_SCOPE,
  parseWebhookConfiguration,
  parseWebhookRegistration,
  resolveAgentWebhookSigningSecret,
  resolveAgentWebhookTargets,
} from "./agent-webhook-registration";

describe("parseWebhookRegistration", () => {
  it("returns no registration when no callback is supplied", () => {
    const result = parseWebhookRegistration({});
    expect(result).toEqual({ ok: true, registration: undefined });
  });

  it("accepts an HTTPS callback via the flat field", () => {
    const result = parseWebhookRegistration({ webhook_callback_url: "https://agent.example/hooks" });
    expect(result).toEqual({ ok: true, registration: { callbackUrl: "https://agent.example/hooks" } });
  });

  it("accepts a nested webhook object", () => {
    const result = parseWebhookRegistration({ webhook: { callback_url: "https://agent.example/hooks" } });
    expect(result).toEqual({ ok: true, registration: { callbackUrl: "https://agent.example/hooks" } });
  });

  it("rejects non-HTTPS remote callbacks", () => {
    const result = parseWebhookRegistration({ webhook_callback_url: "http://agent.example/hooks" });
    expect(result.ok).toBe(false);
  });

  it("rejects callbacks with a fragment", () => {
    const result = parseWebhookRegistration({ webhook_callback_url: "https://agent.example/hooks#frag" });
    expect(result.ok).toBe(false);
  });

  it("allows localhost http callbacks for local development", () => {
    const result = parseWebhookRegistration({ webhook_callback_url: "http://localhost:4000/hooks" });
    expect(result.ok).toBe(true);
  });
});

describe("parseWebhookConfiguration", () => {
  it("accepts a replacement callback", () => {
    expect(parseWebhookConfiguration({ callback_url: "https://agent.example/new-hooks" })).toEqual({
      ok: true,
      configuration: { callbackUrl: "https://agent.example/new-hooks" },
    });
  });

  it("accepts null as an explicit disable operation", () => {
    expect(parseWebhookConfiguration({ callback_url: null })).toEqual({
      ok: true,
      configuration: { callbackUrl: null },
    });
  });

  it("requires the callback field", () => {
    expect(parseWebhookConfiguration({})).toMatchObject({ ok: false });
  });
});

describe("resolveAgentWebhookTargets", () => {
  it("joins active order:read authorizations (Identity) to callback-bearing clients (Auth)", async () => {
    const linkedAuthorizationsQuery = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ client_id: "ocl_1", account_id: "acc_buyer" }],
      rowCount: 1,
    }));
    const oauthClientsQuery = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ client_id: "ocl_1", webhook_callback_url: "https://agent.example/hooks" }],
      rowCount: 1,
    }));

    const targets = await resolveAgentWebhookTargets(
      { query: linkedAuthorizationsQuery } as never,
      { query: oauthClientsQuery } as never,
      "acc_buyer",
    );

    expect(targets).toEqual([
      { clientId: "ocl_1", accountId: "acc_buyer", callbackUrl: "https://agent.example/hooks" },
    ]);

    const [grantSql, grantValues] = linkedAuthorizationsQuery.mock.calls[0];
    expect(grantSql).toContain("FROM identity_linked_platform_authorizations");
    expect(grantSql).toContain("scopes ? $2");
    expect(grantValues).toEqual(["acc_buyer", AGENT_WEBHOOK_ORDER_SCOPE]);

    const [clientSql, clientValues] = oauthClientsQuery.mock.calls[0];
    expect(clientSql).toContain("FROM identity_ucp_oauth_clients");
    expect(clientSql).toContain("webhook_callback_url IS NOT NULL");
    expect(clientValues).toEqual([["ocl_1"]]);
  });

  it("skips the client lookup when the account has no active authorizations", async () => {
    const linkedAuthorizationsQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const oauthClientsQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    const targets = await resolveAgentWebhookTargets(
      { query: linkedAuthorizationsQuery } as never,
      { query: oauthClientsQuery } as never,
      "acc_buyer",
    );

    expect(targets).toEqual([]);
    expect(oauthClientsQuery).not.toHaveBeenCalled();
  });
});

describe("resolveAgentWebhookSigningSecret", () => {
  it("returns the stored secret for a client", async () => {
    const query = vi.fn(async () => ({ rows: [{ webhook_signing_secret: "whsec_secret" }], rowCount: 1 }));
    expect(await resolveAgentWebhookSigningSecret({ query } as never, "ocl_1")).toBe("whsec_secret");
  });

  it("returns null when the client has no secret", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    expect(await resolveAgentWebhookSigningSecret({ query } as never, "ocl_1")).toBeNull();
  });
});
