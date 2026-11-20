import { afterEach, describe, expect, it, vi } from "vitest";
import { navigateAfterWrite, readFreshWriteToken } from "@chase-sets/http/responses";
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
      const body = (await result.json()) as { destination: string };
      expect(body).toMatchObject({ outcome: "committed", newlyCommitted: !replay, delivery: "unknown" });
      // A link that could not be asked for is named on the page it returns to, so it can be sent again.
      const unsent = new URL(body.destination, "https://marketplace.test").searchParams.get("unsent");
      expect(unsent).toBe(["before-response", "after-call"].includes(stage) ? "ivt_synthetic" : null);
      expect(requests.filter((request) => request.url.includes("/api/identity/invitations"))).toHaveLength(1);
      expect(requests.filter((request) => request.url.includes("/acceptance-link/request"))).toHaveLength(
        replay ? 0 : 1,
      );
    },
  );

  it.each([
    ["sent", 200, null],
    ["refused while Auth catches up", 503, "ivt_pending"],
  ] as const)(
    "resends a pending invitation with a new expiry and emails it (%s)",
    async (_stage, linkStatus, unsent) => {
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          requests.push(request.clone());
          if (request.url.includes("/api/auth/session")) return Response.json({ actor });
          if (request.url.includes("/acceptance-link/request"))
            return Response.json(
              linkStatus === 200 ? { ok: true } : { error: { code: "projection_freshness_timeout" } },
              {
                status: linkStatus,
              },
            );
          expect(request.headers.get("Idempotency-Key")).toBe(key);
          return Response.json(syntheticMutationResult("resend-invitation", binding, { target: "ivt_pending" }));
        }),
      );
      const before = Date.now();
      const result = await action({
        request: new Request("https://marketplace.test/account/team", {
          method: "POST",
          headers: { "Idempotency-Key": key, Accept: "text/x-script" },
          body: new URLSearchParams({ intent: "resend-invitation", invitationId: "ivt_pending" }),
        }),
        params: {},
        context: undefined,
      });
      if (!(result instanceof Response)) throw new Error("Expected mutation response");
      expect(result.status).toBe(200);
      const body = (await result.json()) as { destination: string };
      expect(body).toMatchObject({ outcome: "committed", delivery: "unknown" });
      expect(new URL(body.destination, "https://marketplace.test").searchParams.get("unsent")).toBe(unsent);
      const resend = requests.find((request) => request.url.includes("/api/identity/invitations/ivt_pending/resend"));
      const expiresAt = Date.parse(((await resend!.json()) as { expiresAt: string }).expiresAt);
      expect(expiresAt - before).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
      const link = requests.find((request) => request.url.includes("/acceptance-link/request"));
      expect(await link!.json()).toMatchObject({ invitationId: "ivt_pending" });
    },
  );

  it.each(["create-invitation", "resend-invitation"] as const)(
    "names the unsent invitation on Identity's own destination and keeps its fresh-write token (%s)",
    async (intent) => {
      const ownerDestination = navigateAfterWrite(
        { commitPositions: [{ sourceContextName: "identity", maxGlobalPosition: "42", eventIds: ["evt_synthetic"] }] },
        "/account/team",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.includes("/api/auth/session")) return Response.json({ actor });
          if (request.url.includes("/acceptance-link/request"))
            return Response.json({ error: { code: "projection_freshness_timeout" } }, { status: 503 });
          return Response.json({
            ...syntheticMutationResult(
              intent,
              binding,
              intent === "resend-invitation" ? { target: "ivt_pending" } : {},
            ),
            destination: ownerDestination,
          });
        }),
      );
      const fields: Record<string, string> =
        intent === "create-invitation"
          ? { email: "synthetic@example.test", roleKey: "viewer" }
          : { invitationId: "ivt_pending" };
      const result = await action({
        request: new Request("https://marketplace.test/account/team", {
          method: "POST",
          headers: { "Idempotency-Key": key, Accept: "text/x-script" },
          body: new URLSearchParams({ intent, ...fields }),
        }),
        params: {},
        context: undefined,
      });
      if (!(result instanceof Response)) throw new Error("Expected mutation response");
      const { destination } = (await result.json()) as { destination: string };
      const url = new URL(destination, "https://marketplace.test");
      expect(url.pathname).toBe("/account/team");
      expect(url.searchParams.get("unsent")).toBe(intent === "create-invitation" ? "ivt_synthetic" : "ivt_pending");
      expect(readFreshWriteToken(url)?.sources[0]?.maxGlobalPosition).toBe("42");
    },
  );

  it("keeps Identity's own destination unchanged when the link was asked for", async () => {
    const ownerDestination = navigateAfterWrite(
      { commitPositions: [{ sourceContextName: "identity", maxGlobalPosition: "42", eventIds: ["evt_synthetic"] }] },
      "/account/team",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.includes("/api/auth/session")) return Response.json({ actor });
        if (request.url.includes("/acceptance-link/request")) return Response.json({ ok: true });
        return Response.json({
          ...syntheticMutationResult("resend-invitation", binding, { target: "ivt_pending" }),
          destination: ownerDestination,
        });
      }),
    );
    const result = await action({
      request: new Request("https://marketplace.test/account/team", {
        method: "POST",
        headers: { "Idempotency-Key": key, Accept: "text/x-script" },
        body: new URLSearchParams({ intent: "resend-invitation", invitationId: "ivt_pending" }),
      }),
      params: {},
      context: undefined,
    });
    if (!(result instanceof Response)) throw new Error("Expected mutation response");
    expect(((await result.json()) as { destination: string }).destination).toBe(ownerDestination);
  });

  it("refuses a resend from a form that is not the interruption-safe client", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const result = await action({
      request: new Request("https://marketplace.test/account/team", {
        method: "POST",
        headers: { Accept: "text/x-script" },
        body: new URLSearchParams({ intent: "resend-invitation", invitationId: "ivt_pending" }),
      }),
      params: {},
      context: undefined,
    });
    if (!(result instanceof Response)) throw new Error("Expected mutation response");
    expect(result.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
