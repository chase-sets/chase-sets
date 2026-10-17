import { afterEach, describe, expect, it, vi } from "vitest";
import { action } from "../../../routes/marketplace/account-team";
import { syntheticMutationResult } from "./test-support";

const binding = { tenantId: "tnt_synthetic", userId: "usr_synthetic", accountId: "acc_synthetic" };
const actor = {
  ...binding,
  sessionId: "ses_synthetic",
  membershipId: "mbr_synthetic",
  roleKey: "owner",
  permissions: ["memberships.manage"],
};
const key = "9230f01b-7871-420b-9c32-37139f80f749";

afterEach(() => vi.unstubAllGlobals());

describe("issue-7168-ac8-invitation-handoff", () => {
  it.each(["before-response", "after-call", "success", "replay", "crash-replay"])(
    "keeps %s delivery unknown and never resends a recorded invitation",
    async (stage) => {
      const requests: Request[] = [];
      const replay = stage === "replay" || stage === "crash-replay";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          requests.push(request);
          if (request.url.includes("/api/auth/session")) return Response.json({ actor });
          if (request.url.includes("/acceptance-link/request")) {
            if (stage === "before-response") throw new TypeError("synthetic transport loss");
            return Response.json(stage === "after-call" ? { error: { code: "synthetic" } } : { ok: true }, {
              status: stage === "after-call" ? 503 : 200,
            });
          }
          expect(request.headers.get("Idempotency-Key")).toBe(key);
          return Response.json(syntheticMutationResult("create-invitation", binding, { newlyCommitted: !replay }));
        }),
      );
      const result = await action({
        request: new Request("https://marketplace.test/account/team", {
          method: "POST",
          headers: { "Idempotency-Key": key, Accept: "text/x-script" },
          body: new URLSearchParams({
            intent: "create-invitation",
            email: "synthetic@example.test",
            roleKey: "viewer",
          }),
        }),
        params: {},
        context: undefined,
      });
      if (!(result instanceof Response)) throw new Error("Expected mutation response");
      expect(result.status).toBe(200);
      expect(result.headers.get("Location")).toBeNull();
      expect(await result.json()).toMatchObject({ outcome: "committed", newlyCommitted: !replay, delivery: "unknown" });
      expect(requests.filter((request) => request.url.includes("/api/identity/invitations"))).toHaveLength(1);
      expect(requests.filter((request) => request.url.includes("/acceptance-link/request"))).toHaveLength(
        replay ? 0 : 1,
      );
    },
  );
});
