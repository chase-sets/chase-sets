import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import * as authContext from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { IdentityApiEnv } from "../../../api";
import { createInMemoryEventStore } from "../../../tests/in-memory-event-store";
import { createAccountCapabilityRuntime } from "./runtime";
import { parseCapabilityAdministrationAuthority } from "./authority";
import { accountCapabilityRoutes } from "./route";

export const now = new Date("2026-10-12T12:00:00.000Z");
export const actor: ResolvedActor = {
  sessionId: "ses_synthetic",
  userId: "usr_synthetic_admin",
  accountId: "acc_synthetic",
  tenantId: "tnt_synthetic",
  membershipId: "mbr_synthetic",
  roleKey: "member",
  permissions: ["account.read"],
  authenticatedAt: now.toISOString(),
};
export const context: EventStoreContext = {
  tenantId: actor.tenantId as never,
  audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
};
export const scope = {
  environment: "preview",
  deploymentInstance: '["support-deployment-instance/v1","preview-9385","release-a"]',
  implementationSha: "a".repeat(40),
};
export const declaration = {
  version: 1,
  environment: scope.environment,
  deploymentInstance: scope.deploymentInstance,
  authorityId: "support-admin",
  revision: 1,
  adminUserIds: [actor.userId],
};
export const registry = [
  {
    owningContext: "platform-operations",
    key: "support.evidence.any-case",
    kind: "boolean",
    defaultValue: false,
    description: "Synthetic",
  },
] as const;
export const input = { accountId: "acc_target", capabilityKey: "support.evidence.any-case", expectedVersion: 0 };

function setup(
  currentActor: ResolvedActor | null = actor,
  currentContext = context,
  raw: string | undefined = JSON.stringify(declaration),
) {
  const eventStore = createInMemoryEventStore();
  const runtime = createAccountCapabilityRuntime(
    { eventStore, checkpointStore: {} as never, db: {} as never },
    {
      authority: parseCapabilityAdministrationAuthority(raw, scope),
      registry,
      now: () => now,
      targetAccountInTenant: async () => true,
    },
  );
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    c.set("context", currentContext);
    await next();
  });
  app.route("/", accountCapabilityRoutes(runtime));
  const post = (body = input, action = "grant") =>
    app.request(`/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { eventStore, runtime, post };
}

describe("Account Capability admission routes", () => {
  it("admits a listed human at exactly 15:00 and grant/revoke uses only the explicit account", async () => {
    const { post, eventStore } = setup({ ...actor, authenticatedAt: new Date(now.getTime() - 900000).toISOString() });
    expect((await post()).status).toBe(200);
    expect((await post({ ...input, expectedVersion: 1 }, "revoke")).status).toBe(200);
    expect(eventStore.streamIdsWithPrefix("identity.account-capability-")).toEqual([
      "identity.account-capability-tnt_synthetic-acc_target-support.evidence.any-case",
    ]);
  });
  it.each([
    ["off-list/platform-admin bypass", { ...actor, userId: "usr_other", roleKey: "platform-admin" }],
    [
      "any-case-only/self-administration bypass",
      {
        ...actor,
        userId: "usr_other",
        capabilityAssignments: [{ key: input.capabilityKey, assignmentId: "acap_synthetic", version: 1 }],
      },
    ],
    [
      "15:00.001/account-switch timestamp reset bypass",
      { ...actor, authenticatedAt: new Date(now.getTime() - 900001).toISOString() },
    ],
    ["token-refresh reset bypass", { ...actor, authenticatedAt: undefined }],
    ["invalid authentication bypass", { ...actor, authenticatedAt: "invalid" }],
    ["date-only/timezone-less authentication bypass", { ...actor, authenticatedAt: "2026-10-12T12:00:00.000" }],
    ["future authentication bypass", { ...actor, authenticatedAt: new Date(now.getTime() + 1).toISOString() }],
    ["guest bypass", { ...actor, sessionId: "guest:synthetic" }],
    ["OAuth bypass", { ...actor, sessionId: "ucp:synthetic" }],
    ["API-key bypass", { ...actor, sessionId: "api-key:synthetic" }],
    ["service bypass", { ...actor, sessionId: "service:synthetic" }],
    ["missing membership bypass", { ...actor, membershipId: "" }],
  ] as const)("denies %s with audit and no assignment", async (_, currentActor) => {
    const matching = {
      tenantId: currentActor.tenantId as never,
      audit: { performedByUserId: currentActor.userId as never, forAccountId: currentActor.accountId as never },
    };
    const { post, eventStore } = setup(currentActor, matching);
    expect((await post()).status).toBe(403);
    expect(eventStore.streamIdsWithPrefix("identity.account-capability-")).toEqual([]);
    expect(eventStore.streamIdsWithPrefix("identity.capability-assignment-attempt-")).toHaveLength(1);
  });
  it.each([
    undefined,
    "PLANTED_SECRET",
    JSON.stringify({
      ...declaration,
      deploymentInstance: '["support-deployment-instance/v1","preview-9385","release-b"]',
    }),
  ])("denies absent/malformed/wrong-instance authority", async (raw) => {
    const { post } = setup(actor, context, raw === undefined ? "" : raw);
    expect((await post()).status).toBe(403);
  });
  it("denies actor/context mismatch and closed request payload", async () => {
    expect((await setup(actor, { ...context, tenantId: "tnt_other" as never }).post()).status).toBe(403);
    expect((await setup().post({ ...input, extra: "PLANTED_SECRET" } as typeof input)).status).toBe(400);
  });
  it("audit failure prevents mutation and never exposes raw errors", async () => {
    const { post, eventStore } = setup();
    vi.spyOn(eventStore, "appendToStreams").mockRejectedValue(new Error("PLANTED_SECRET"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PLANTED_SECRET");
    expect(eventStore.streamIdsWithPrefix("identity.account-capability-")).toEqual([]);
  });
  it("executes the recent-authentication-always-true bypass mutant against the same 15:00.001 assertion", async () => {
    const stale = { ...actor, authenticatedAt: new Date(now.getTime() - 900001).toISOString() };
    expect((await setup(stale).post()).status).toBe(403);
    const spy = vi
      .spyOn(authContext, "resolveRecentAuthenticationStatus")
      .mockReturnValue({ recentlyAuthenticated: true, authenticatedAt: stale.authenticatedAt });
    try {
      const mutant = await setup(stale).post();
      expect(() => expect(mutant.status).toBe(403)).toThrow();
      expect(mutant.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});
