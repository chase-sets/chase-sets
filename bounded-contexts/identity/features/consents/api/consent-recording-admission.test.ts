import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import { CONSENT_VERSION_NOT_ACTIVATED_CODE, CONSENT_VERSION_NOT_PUBLISHED_CODE } from "../domain/consent-bundle";
import { identityTermsOfServicePolicy } from "../domain/terms-of-service-policy";
import { createConsentRuntime } from "./runtime";
import { termsOfServiceConsentRoutes } from "./terms-route";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: [],
};

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
  trace: {},
};

/**
 * A real consent runtime over a real event store. The only fake is the read
 * model's `db`, because the projection is not what admits a write -- the
 * authority stream is, and that is genuine here.
 */
function createHarness() {
  const { eventStore, streams } = createInMemoryEventStore();
  const db = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as PgQueryable;
  const policies = createPolicyRuntime({ eventStore, db });
  const consents = createConsentRuntime({ eventStore, db, checkpointStore: {} } as unknown as IdentityRuntimeDeps);

  return { eventStore, streams, db, policies, consents };
}

function consentStreams(streams: Map<string, unknown[]>) {
  return [...streams.keys()].filter((streamId) => streamId.startsWith("identity.consent-"));
}

async function activateTermsOfService(harness: ReturnType<typeof createHarness>, version: string) {
  await harness.policies.consentActivation.register(identityTermsOfServicePolicy, context);
  await harness.policies.consentActivation.activate(
    identityTermsOfServicePolicy,
    { version, documentId: "pol_terms", actorUserId: "usr_operator" },
    context,
  );
}

function recordTermsConsent(harness: ReturnType<typeof createHarness>, consentId: string, policyVersion: string) {
  return harness.consents.commandHandler({
    streamId: `identity.consent-${consentId}`,
    command: {
      type: "RecordConsent",
      consentId: consentId as never,
      subjectType: "user",
      userId: actor.userId as never,
      accountId: actor.accountId as never,
      policyKey: "terms-of-service",
      policyVersion,
      recordedAt: "2026-07-01T00:00:00.000Z",
    },
    context,
  });
}

describe("consent recording admission", () => {
  it("rejects a stub version that no publication carries, and writes nothing", async () => {
    const harness = createHarness();

    await expect(recordTermsConsent(harness, "cns_stub", "v99")).rejects.toMatchObject({
      code: CONSENT_VERSION_NOT_PUBLISHED_CODE,
    });
    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("rejects the published placeholder version while its authority has never activated it, and writes nothing", async () => {
    const harness = createHarness();

    await expect(recordTermsConsent(harness, "cns_placeholder", "v1")).rejects.toMatchObject({
      code: CONSENT_VERSION_NOT_ACTIVATED_CODE,
    });
    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("admits the exact active version once the authority activates it", async () => {
    const harness = createHarness();
    await activateTermsOfService(harness, "v1");

    const result = await recordTermsConsent(harness, "cns_ok", "v1");

    expect(result.state.status).toBe("recorded");
    expect(consentStreams(harness.streams)).toEqual(["identity.consent-cns_ok"]);
  });

  it("rejects an append whose authority guard has gone stale, and writes nothing", async () => {
    const harness = createHarness();
    await activateTermsOfService(harness, "v1");

    // Take the guard the admission would take, then move the authority under
    // it, then present the stale guard to the same all-or-nothing append.
    const stale = await harness.policies.consentActivation.read(identityTermsOfServicePolicy.policyKey);
    await harness.policies.consentActivation.deactivate(
      identityTermsOfServicePolicy,
      { actorUserId: "usr_operator" },
      context,
    );

    await expect(
      harness.eventStore.appendToStreams?.([
        harness.policies.consentActivation.guardAppendInput(stale.guard, context),
        {
          streamId: "identity.consent-cns_raced",
          expectedVersion: "no_stream",
          events: [
            {
              eventType: "identity.consent.recorded",
              payload: {
                consentId: "cns_raced",
                subjectType: "user",
                userId: actor.userId,
                accountId: actor.accountId,
                policyKey: "terms-of-service",
                policyVersion: "v1",
                recordedAt: "2026-07-01T00:00:00.000Z",
              },
            },
          ],
          context,
        },
      ]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("rejects recording after the authority deactivates the version, and writes nothing", async () => {
    const harness = createHarness();
    await activateTermsOfService(harness, "v1");
    await harness.policies.consentActivation.deactivate(
      identityTermsOfServicePolicy,
      { actorUserId: "usr_operator" },
      context,
    );

    await expect(recordTermsConsent(harness, "cns_after", "v1")).rejects.toMatchObject({
      code: CONSENT_VERSION_NOT_ACTIVATED_CODE,
    });
    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("leaves a policy key no bundle declares recordable, including a date-shaped legacy version", async () => {
    const harness = createHarness();

    const result = await harness.consents.commandHandler({
      streamId: "identity.consent-cns_legacy",
      command: {
        type: "RecordConsent",
        consentId: "cns_legacy" as never,
        subjectType: "user",
        userId: actor.userId as never,
        accountId: actor.accountId as never,
        policyKey: "terms",
        policyVersion: "2026-06-15",
        recordedAt: "2026-07-01T00:00:00.000Z",
      },
      context,
    });

    expect(result.state.status).toBe("recorded");
  });
});

describe("the authenticated acceptance route under the admission rules", () => {
  function buildApp(harness: ReturnType<typeof createHarness>) {
    const app = new Hono<IdentityApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", context);
      await next();
    });
    app.route(
      "/consents/terms-of-service",
      termsOfServiceConsentRoutes({ db: harness.db, policies: harness.policies, consents: harness.consents }),
    );
    return app;
  }

  it("cannot record acceptance of the pre-publication placeholder version", async () => {
    const harness = createHarness();

    const response = await buildApp(harness).request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: CONSENT_VERSION_NOT_ACTIVATED_CODE },
    });
    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("records acceptance once the active version is activated", async () => {
    const harness = createHarness();
    await activateTermsOfService(harness, "v1");

    const response = await buildApp(harness).request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(201);
    expect(consentStreams(harness.streams)).toHaveLength(1);
  });
});
