import { describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createConnectorFeedRuntime } from "../api/runtime";
import { createConnectorCredentialRoutes } from "../api/routes";
import { ConnectorPairingError } from "../domain/contracts";

const callback = "https://fixed.chromiumapp.org/ucp/oauth/callback";
const authorization = {
  client_id: "client",
  redirect_uri: callback,
  code_challenge: "x".repeat(43),
  code_challenge_method: "S256",
};
const query = new URLSearchParams({ ...authorization, response_type: "code", state: "state-sentinel" });
const actor = {
  userId: "usr_test",
  accountId: "acc_test",
  permissions: ["channels.manage"],
  sessionId: "ses_test",
  tenantId: "tnt_test",
  membershipId: "mem_test",
  roleKey: "seller",
};

function harness() {
  const audits: (readonly unknown[])[] = [];
  const db: PgTransactionalPool = {
    async query(_text, values) {
      audits.push(values ?? []);
      return { rows: [] };
    },
    async connect() {
      throw new Error("Route contract test must not transact");
    },
  };
  const service = createConnectorFeedRuntime({ db, eventStore: createPostgresEventStore({ pool: db }) });
  const validate = vi.spyOn(service, "validateAuthorization").mockResolvedValue(authorization);
  vi.spyOn(service, "resolveSeller").mockResolvedValue(actor);
  const authorize = vi.spyOn(service, "authorizePairing").mockImplementation(async (_input, _actor, identify) => {
    identify?.({ connectionId: "connection", pairingId: "pairing" });
    return { code: "authorization-code-sentinel" };
  });
  return { audits, service, validate, authorize, app: createConnectorCredentialRoutes(service, db) };
}

describe("connector-live-code-binding route contract", () => {
  it("explicitly audits the accepted 302 with verified identity and no redirect secrets", async () => {
    const h = harness();
    const response = await h.app.request(`http://localhost/authorize?${query}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.fromEntries(new URL(response.headers.get("location")!).searchParams)).toEqual({
      code: "authorization-code-sentinel",
      state: "state-sentinel",
    });
    expect(h.authorize).toHaveBeenCalledWith(authorization, actor, expect.any(Function));
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.slice(1, 6)).toEqual(["connection", "pairing", "authorize", "accepted", "accepted"]);
    expect(JSON.stringify(h.audits)).not.toContain("sentinel");
  });

  it.each([
    ["invalid-credential", undefined, "pairing_code_missing"],
    ["pairing-expired", undefined, "pairing_code_missing"],
    ["conflict", undefined, "pairing_code_missing"],
    ["conflict", "pairing_code_ambiguous", "pairing_code_ambiguous"],
    ["authorization-refused", undefined, "authorization_refused"],
  ] as const)("maps %s/%s to one refused audit and closed redirect", async (reason, description, expected) => {
    const h = harness();
    h.authorize.mockRejectedValue(new ConnectorPairingError(reason, description));
    const response = await h.app.request(`http://localhost/authorize?${query}`);
    expect(response.status).toBe(302);
    expect(Object.fromEntries(new URL(response.headers.get("location")!).searchParams)).toEqual({
      error: "access_denied",
      state: "state-sentinel",
      error_description: expected,
    });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.slice(1, 6)).toEqual([null, null, "authorize", "refused", reason]);
  });

  it("refuses unknown, duplicate and missing query members before resolving authorization", async () => {
    const cases = [new URLSearchParams([...query, ["pairing_code", "secret-sentinel"]])];
    for (const key of query.keys()) {
      const duplicate = new URLSearchParams(query);
      duplicate.append(key, query.get(key)!);
      cases.push(duplicate);
      const missing = new URLSearchParams(query);
      missing.delete(key);
      cases.push(missing);
    }
    for (const input of cases) {
      const h = harness();
      const response = await h.app.request(`http://localhost/authorize?${input}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(h.validate).not.toHaveBeenCalled();
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]?.slice(1, 6)).toEqual([null, null, "authorize", "refused", "invalid-request"]);
      expect(JSON.stringify(h.audits)).not.toContain("sentinel");
    }
  });

  it("does not authorize through the removed POST or Hono's implicit HEAD", async () => {
    const h = harness();
    expect((await h.app.request(`http://localhost/authorize?${query}`, { method: "POST" })).status).toBe(404);
    expect((await h.app.request(`http://localhost/authorize?${query}`, { method: "HEAD" })).status).toBe(405);
    expect(h.validate).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(2);
  });
});
