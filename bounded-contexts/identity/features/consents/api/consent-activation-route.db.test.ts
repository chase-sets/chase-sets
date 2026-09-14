import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PublicPolicyPublicationRecord } from "@chase-sets/public-docs";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildIdentityApi, type IdentityApiEnv } from "../../../api";
import { module as identityModule } from "../../../index";
import { createIdentityServices } from "../../../support/runtime-support/services";
import {
  identityConsentPolicyPublications,
  resolveConsentBundleAgainstCorpus,
  type ConsentPolicyPublicationCorpus,
} from "../domain/consent-bundle";
import {
  identityTermsOfServicePolicy,
  identityPrivacyPolicyActiveVersionPolicy,
} from "../domain/terms-of-service-policy";
import { resolveTermsAcceptanceStatus } from "../read-model/terms-acceptance";
import { CONSENT_ACTIVATION_RECENT_AUTH_MAX_AGE_MINUTES } from "./consent-activation-route";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for consent activation route tests.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const now = new Date("2026-09-14T16:00:00.000Z");
const context: EventStoreContext = {
  tenantId: createId("tnt"),
  audit: { performedByUserId: createId("usr"), forAccountId: createId("acc") },
};
const operator: ResolvedActor = {
  sessionId: "synthetic-session-8016",
  tenantId: context.tenantId,
  userId: context.audit.performedByUserId,
  accountId: context.audit.forAccountId,
  membershipId: "synthetic-membership-8016",
  roleKey: "platform-admin",
  permissions: ["platform-policy.manage"],
  authenticatedAt: now.toISOString(),
};
const publication: PublicPolicyPublicationRecord<"terms-of-service"> = {
  policyKey: "terms-of-service",
  version: "v999",
  href: "/terms",
  locale: "synthetic-test",
  publicationStatus: "published",
  effectiveAt: "2026-09-01T00:00:00.000Z",
  counselApprovalReference: "SYNTHETIC-NONLEGAL-8016",
  rolloutJurisdictionsOrProductLimits: ["Synthetic test only"],
  launchRequired: false,
  contentFingerprint: `sha256:${"a".repeat(64)}`,
  consentActivatable: true,
};
const basePath = "/api/identity/admin/consents/terms-of-service";

describeDb("consent-activation-route: actual Identity mount and PostgreSQL", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let eventStore: EventStore;
  let policies: PolicyRuntime;
  let documentId: string;
  const corpus = (record = publication): ConsentPolicyPublicationCorpus => ({
    ...identityConsentPolicyPublications,
    "terms-of-service": record,
  });

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "consent_activation_8016");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identityModule.schemaSql);
    eventStore = createPostgresEventStore({ pool: pools.identity });
    policies = createPolicyRuntime({ eventStore, db: pools.identity, now: () => now });
    documentId = (
      await policies.createPolicyDocument(
        identityTermsOfServicePolicy,
        {
          value: { version: publication.version },
          status: "active",
          effectiveFrom: now.toISOString(),
          effectiveUntil: null,
          actorUserId: operator.userId,
        },
        context,
      )
    ).documentId;
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function app(
    options: {
      actor?: ResolvedActor | null;
      context?: EventStoreContext | null;
      publications?: ConsentPolicyPublicationCorpus;
      runtime?: PolicyRuntime;
      production?: boolean;
    } = {},
  ) {
    const mounted = new Hono<IdentityApiEnv>();
    mounted.use("*", async (c, next) => {
      c.set("actor", options.actor === undefined ? operator : options.actor);
      if (options.context !== null) c.set("context", options.context ?? context);
      await next();
    });
    mounted.route(
      "/api/identity",
      buildIdentityApi(
        { ...createIdentityServices(pools.identity), policies: options.runtime ?? policies },
        {
          ...(options.production ? {} : { publications: options.publications ?? corpus() }),
          now: () => now,
        },
      ),
    );
    return mounted;
  }
  const input = () => ({
    version: publication.version,
    documentId,
    contentFingerprint: publication.contentFingerprint,
  });
  const post = (mounted = app(), body: unknown = input(), path = `${basePath}/activate`) =>
    mounted.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const state = () => policies.consentActivation.read(identityTermsOfServicePolicy.policyKey);
  const terms = (record = publication) =>
    resolveTermsAcceptanceStatus(
      pools.identity,
      policies.consentActivation,
      {
        userId: operator.userId,
        accountId: operator.accountId,
      },
      record,
    );
  async function refused(response: Response, code: string) {
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toEqual({ error: { code } });
    expect((await state()).isActive).toBe(false);
  }
  async function revise(version: string) {
    await policies.revisePolicyDocument(
      identityTermsOfServicePolicy,
      documentId,
      {
        value: { version },
        status: "active",
        effectiveFrom: now.toISOString(),
        effectiveUntil: null,
        actorUserId: operator.userId,
      },
      context,
    );
  }

  it.each([
    ["missing actor", null, "authentication_required"],
    ["permission", { ...operator, permissions: [] }, "permission_required"],
    ["missing authentication", { ...operator, authenticatedAt: null }, "recent_authentication_required"],
    ["invalid authentication", { ...operator, authenticatedAt: "invalid" }, "recent_authentication_required"],
    [
      "future authentication",
      { ...operator, authenticatedAt: new Date(now.getTime() + 1).toISOString() },
      "recent_authentication_required",
    ],
    [
      "old authentication",
      { ...operator, authenticatedAt: new Date(now.getTime() - 15 * 60_000 - 1).toISOString() },
      "recent_authentication_required",
    ],
    ["actor/context", { ...operator, userId: "synthetic-foreign-user" }, "actor_context_mismatch"],
  ] as const)("refuses %s on both operations before registration", async (_name, actor, code) => {
    for (const operation of ["activate", "deactivate"]) {
      await refused(
        await post(app({ actor }), operation === "activate" ? input() : {}, `${basePath}/${operation}`),
        code,
      );
      expect((await state()).registered).toBe(false);
    }
  });
  it("requires context and accepts the inclusive recent-authentication boundary", async () => {
    await refused(await post(app({ context: null })), "authentication_required");
    const actor = {
      ...operator,
      authenticatedAt: new Date(now.getTime() - CONSENT_ACTIVATION_RECENT_AUTH_MAX_AGE_MINUTES * 60_000).toISOString(),
    };
    expect((await post(app({ actor }))).status).toBe(200);
    const events = await eventStore.readStream({ streamId: (await state()).streamId });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.performedByUserId).toBe(operator.userId);
      expect(event.forAccountId).toBe(operator.accountId);
    }
    expect(events[1]?.payload).toMatchObject({ activation: { actorUserId: operator.userId } });
  });
  it.each(["terms", "unknown", "agent-connector-terms", "identity.terms-of-service-active-version", "x".repeat(129)])(
    "rejects key %s",
    async (key) => {
      for (const operation of ["activate", "deactivate"])
        await refused(await post(app(), {}, `/api/identity/admin/consents/${key}/${operation}`), "invalid_policy_key");
      expect((await state()).registered).toBe(false);
    },
  );
  it("rejects malformed, extra and unbounded fields without a write", async () => {
    for (const body of [
      null,
      [],
      {},
      { ...input(), actorUserId: "forged" },
      { ...input(), version: 999 },
      { ...input(), version: " v999" },
      { ...input(), version: `v${"9".repeat(64)}` },
      { ...input(), documentId: "x".repeat(65) },
      { ...input(), documentId: "bad/id" },
      { ...input(), contentFingerprint: "bad" },
    ]) {
      await refused(await post(app(), body), "invalid_activation_input");
    }
    const malformed = await app().request(`${basePath}/activate`, { method: "POST", body: "{" });
    await refused(malformed, "invalid_activation_input");
    await refused(await post(app(), { version: "v999" }, `${basePath}/deactivate`), "invalid_deactivation_input");
    expect((await state()).registered).toBe(false);
  });
  it("has no public or GET mutation and runbook URLs match the mount", async () => {
    expect((await app().request(`${basePath}/activate`)).status).toBe(404);
    expect((await post(app(), input(), "/api/public/identity/admin/consents/terms-of-service/activate")).status).toBe(
      404,
    );
    const runbook = await readFile(resolve(process.cwd(), "../../docs/runbooks/legal-corpus-publication.md"), "utf8");
    expect(runbook).toContain(`${basePath}/activate`);
    expect(runbook).toContain(`${basePath}/deactivate`);
  });
  it("production default refuses pending publication; each publication gate is distinguishable", async () => {
    await refused(await post(app({ production: true })), "publication_not_activatable");
    await refused(await post(app(), { ...input(), version: "v1000" }), "publication_version_mismatch");
    await refused(
      await post(app(), { ...input(), contentFingerprint: `sha256:${"b".repeat(64)}` }),
      "publication_fingerprint_mismatch",
    );
    await refused(
      await post(
        app({ publications: { ...corpus(), "terms-of-service": identityConsentPolicyPublications["privacy-policy"] } }),
      ),
      "publication_key_mismatch",
    );
    expect((await state()).registered).toBe(false);
  });
  it("gate-bypass control refuses an otherwise matching synthetic ineligible publication", async () => {
    await refused(
      await post(app({ publications: corpus({ ...publication, consentActivatable: false }) })),
      "publication_not_activatable",
    );
    expect((await state()).registered).toBe(false);
  });
  it("rejects missing, wrong-policy, invalid and stale-projection documents", async () => {
    await refused(await post(app(), { ...input(), documentId: "synthetic-missing" }), "document_not_found");
    const foreign = await policies.createPolicyDocument(
      identityPrivacyPolicyActiveVersionPolicy,
      {
        value: { version: publication.version },
        status: "active",
        effectiveFrom: now.toISOString(),
        effectiveUntil: null,
        actorUserId: operator.userId,
      },
      context,
    );
    await refused(await post(app(), { ...input(), documentId: foreign.documentId }), "document_policy_mismatch");
    // Project v999, then leave a newer authoritative revision deliberately unprojected.
    const projector = policies.projectors[0]!;
    for (const event of await eventStore.readStream({ streamId: `platform-policy.document-${documentId}` })) {
      const handler = projector.handlers[event.eventType];
      if (handler) await handler(toTransportEvent(event));
    }
    expect((await policies.getPolicyDocument(documentId))?.value).toEqual({ version: "v999" });
    await revise("v1000");
    await refused(await post(), "document_version_mismatch");
    expect((await state()).registered).toBe(false);
    await policies.commandHandler({
      streamId: `platform-policy.document-${documentId}`,
      command: {
        type: "RevisePolicyDocument",
        value: { unexpected: true },
        status: "active",
        effectiveFrom: now.toISOString(),
        effectiveUntil: null,
        actorUserId: operator.userId,
      },
      context,
    });
    await refused(await post(), "document_invalid");
  });
  it("rejects document revision at the atomic append; interruption leaves only registration and retry converges", async () => {
    let interrupt = true;
    const racedStore: EventStore = {
      ...eventStore,
      appendToStreams: async (inputs) => {
        if (interrupt) {
          interrupt = false;
          await revise("v1000");
        }
        return eventStore.appendToStreams!(inputs);
      },
    };
    const runtime = createPolicyRuntime({ eventStore: racedStore, db: pools.identity, now: () => now });
    await refused(await post(app({ runtime })), "activation_concurrency_conflict");
    expect(await state()).toMatchObject({ registered: true, status: "never-activated", authorityVersion: 1 });
    expect((await terms()).requiredVersion).toBe("");
    await revise("v999");
    expect((await post(app({ runtime }))).status).toBe(200);
    expect((await state()).authorityVersion).toBe(2);
  });
  it("rejects authority races and missing atomic append", async () => {
    const unavailable = createPolicyRuntime({
      eventStore: { ...eventStore, appendToStreams: undefined },
      db: pools.identity,
    });
    await refused(await post(app({ runtime: unavailable })), "atomic_append_unavailable");
    expect((await state()).registered).toBe(false);
    const racedStore: EventStore = {
      ...eventStore,
      appendToStreams: async (inputs) => {
        await policies.consentActivation.activate(
          identityTermsOfServicePolicy,
          { version: "v998", documentId: "synthetic-race", actorUserId: operator.userId },
          context,
        );
        return eventStore.appendToStreams!(inputs);
      },
    };
    const runtime = createPolicyRuntime({ eventStore: racedStore, db: pools.identity, now: () => now });
    const response = await post(app({ runtime }));
    expect(await response.json()).toEqual({ error: { code: "activation_concurrency_conflict" } });
    expect((await state()).activeVersion).toBe("v998");
  });
  it("recovers from interrupted registration/activation without duplicate registration", async () => {
    const interruptedStore: EventStore = {
      ...eventStore,
      appendToStreams: async () => {
        throw new Error("Synthetic interruption before activation commit");
      },
    };
    const runtime = createPolicyRuntime({ eventStore: interruptedStore, db: pools.identity, now: () => now });
    await refused(await post(app({ runtime })), "activation_unavailable");
    expect(await state()).toMatchObject({ registered: true, status: "never-activated", authorityVersion: 1 });
    await refused(await post(app(), {}, `${basePath}/deactivate`), "invalid_transition");
    expect((await terms()).requiredVersion).toBe("");
    expect((await post()).status).toBe(200);
    expect((await state()).authorityVersion).toBe(2);
  });
  it("replaces the active document at the same version instead of treating it as an exact repeat", async () => {
    expect((await post()).status).toBe(200);
    const replacement = await policies.createPolicyDocument(
      identityTermsOfServicePolicy,
      {
        value: { version: publication.version },
        status: "active",
        effectiveFrom: now.toISOString(),
        effectiveUntil: null,
        actorUserId: operator.userId,
      },
      context,
    );
    expect((await post(app(), { ...input(), documentId: replacement.documentId })).status).toBe(200);
    expect(await state()).toMatchObject({
      activeVersion: publication.version,
      activeDocumentId: replacement.documentId,
      activationCount: 2,
      authorityVersion: 3,
    });
    const events = await eventStore.readStream({ streamId: (await state()).streamId });
    expect(events.at(-1)?.eventType).toBe("platform-policy.consent-activation-authority.replaced");
  });
  it("document-guard mutant admits the race that the production guard rejects", async () => {
    const mutantStore: EventStore = {
      ...eventStore,
      appendToStreams: async (inputs) => {
        await revise("v1000");
        return eventStore.appendToStreams!(
          inputs.filter((input) => !input.streamId.startsWith("platform-policy.document-")),
        );
      },
    };
    const runtime = createPolicyRuntime({ eventStore: mutantStore, db: pools.identity, now: () => now });
    expect((await post(app({ runtime }))).status).toBe(200);
    expect((await state()).activeVersion).toBe("v999");
  });
  it("preserves never-activated, active steady state, repeat, replacement, rollback and reactivation", async () => {
    expect(await state()).toMatchObject({ status: "never-activated", registered: false });
    await refused(await post(app(), {}, `${basePath}/deactivate`), "invalid_transition");
    expect((await terms()).requiredVersion).toBe("");
    expect((await post()).status).toBe(200);
    const active = await state();
    expect(active).toMatchObject({ status: "active", activeVersion: "v999", authorityVersion: 2 });
    expect(await terms()).toMatchObject({ requiredVersion: "v999", accepted: false });
    const mountedStatus = await app().request("/api/identity/consents/terms-of-service");
    expect(await mountedStatus.json()).toMatchObject({ requiredVersion: "v999", accepted: false });
    const productionStatus = await app({ production: true }).request("/api/identity/consents/terms-of-service");
    expect(await productionStatus.json()).toMatchObject({ requiredVersion: "", accepted: false });
    expect((await post()).status).toBe(200);
    expect(await state()).toEqual(active);
    const next = { ...publication, version: "v1000" as const };
    const mismatch = await resolveConsentBundleAgainstCorpus(policies.consentActivation, "registration", corpus(next));
    expect(JSON.stringify(mismatch)).toContain("publication-activation-version-mismatch");
    await revise("v1000");
    expect((await post(app({ publications: corpus(next) }), { ...input(), version: "v1000" })).status).toBe(200);
    expect(await state()).toMatchObject({
      status: "active",
      activeVersion: "v1000",
      activationCount: 2,
      authorityVersion: 3,
    });
    await pools.identity.query(
      `INSERT INTO identity_consent_current_states (subject_type, subject_id, user_id, account_id, policy_key, consent_id, policy_version, status, recorded_at, withdrawn_at, last_event_global_position, updated_at)
      VALUES ('user', $1, $1, $2, 'terms-of-service', 'synthetic-consent-8016', 'v1000', 'recorded', $3, NULL, 1, $3)`,
      [operator.userId, operator.accountId, now.toISOString()],
    );
    expect((await terms(next)).accepted).toBe(true);
    await revise("v1001");
    expect((await post(app({ production: true }), {}, `${basePath}/deactivate`)).status).toBe(200);
    expect(await state()).toMatchObject({ status: "inactive", authorityVersion: 4 });
    expect(await terms(next)).toMatchObject({ requiredVersion: "", accepted: false });
    await refused(await post(app({ production: true }), {}, `${basePath}/deactivate`), "invalid_transition");
    await revise("v1000");
    expect((await post(app({ publications: corpus(next) }), { ...input(), version: "v1000" })).status).toBe(200);
    expect(await state()).toMatchObject({ status: "active", activeVersion: "v1000", authorityVersion: 5 });
    expect((await terms(next)).accepted).toBe(true);
  });
});
