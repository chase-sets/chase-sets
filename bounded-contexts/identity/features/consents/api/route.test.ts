import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import {
  authorizeConsentForActor,
  ConsentRecordingAuthorizationError,
} from "../domain/consent-recording-authorization";
import { consentRoutes } from "./route";
import { createConsentRuntime, type ConsentServices } from "./runtime";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: [],
};

function buildContext(currentActor: ResolvedActor): EventStoreContext {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: currentActor.userId as never,
      forAccountId: currentActor.accountId as never,
    },
    trace: {},
  };
}

function buildApp(services: ConsentServices, currentActor: ResolvedActor | null = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    if (currentActor) {
      c.set("context", buildContext(currentActor));
    }
    await next();
  });
  app.route("/consents", consentRoutes(services));
  app.onError(errorHandler);
  return app;
}

function buildServices(consent: Record<string, unknown> | null = null) {
  return {
    commandHandler: vi.fn(async () => ({
      version: 2,
      state: { status: "withdrawn", withdrawnAt: "2026-07-15T00:00:00.000Z" },
      newEvents: [],
      storedEvents: [],
    })),
    getConsent: vi.fn(async () => consent),
    listConsents: vi.fn(async () => ({ items: [], total: 0 })),
    projectors: [],
  } as unknown as ConsentServices & {
    commandHandler: ReturnType<typeof vi.fn>;
    getConsent: ReturnType<typeof vi.fn>;
    listConsents: ReturnType<typeof vi.fn>;
  };
}

function createRealHarness() {
  const memory = createInMemoryEventStore();
  const appendToStream = vi.fn(memory.eventStore.appendToStream);
  const runtime = createConsentRuntime({
    eventStore: { ...memory.eventStore, appendToStream },
    checkpointStore: {
      loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
      saveCheckpoint: async () => undefined,
    },
    db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  });
  return { appendToStream, memory, runtime };
}

async function recordConsent(
  runtime: ConsentServices,
  consentId: string,
  subjectType: "account" | "user",
  userId: string,
  accountId: string,
) {
  const context = buildContext({
    ...actor,
    userId,
    accountId,
  });
  await runtime.commandHandler({
    streamId: `identity.consent-${consentId}`,
    command: {
      type: "RecordConsent",
      consentId: consentId as ConsentId,
      subjectType,
      userId: userId as UserId,
      accountId: accountId as AccountId,
      policyKey: "terms-of-service",
      policyVersion: "v1",
      recordedAt: "2026-07-01T00:00:00.000Z",
    },
    context,
    authorization: authorizeConsentForActor(context),
  });
}

function projectionRow(
  consentId: string,
  subjectType: "account" | "user",
  userId: string,
  accountId: string,
): Record<string, unknown> {
  return {
    consent_id: consentId,
    subject_type: subjectType,
    user_id: userId,
    account_id: accountId,
    policy_key: "terms-of-service",
    policy_version: "v1",
    status: "recorded",
    recorded_at: "2026-07-01T00:00:00.000Z",
    withdrawn_at: null,
    updated_at: "2026-07-01T00:00:00.000Z",
    is_current: true,
  };
}

describe("consent API route", () => {
  it("requires an authenticated actor and ignores caller-supplied subject filters", async () => {
    const services = buildServices();

    const response = await buildApp(services, null).request("/consents?userId=usr_victim&accountId=acc_victim");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
    expect(services.listConsents).not.toHaveBeenCalled();
  });

  it("scopes ordinary actors to their own user and account", async () => {
    const services = buildServices();

    const response = await buildApp(services).request("/consents?userId=usr_victim&accountId=acc_victim");

    expect(response.status).toBe(200);
    expect(services.listConsents).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: actor.userId,
        accountId: actor.accountId,
      }),
    );
  });

  it("allows security managers to apply explicit subject filters", async () => {
    const services = buildServices();

    const response = await buildApp(services, { ...actor, permissions: ["security.manage"] }).request(
      "/consents?userId=usr_subject&accountId=acc_subject",
    );

    expect(response.status).toBe(200);
    expect(services.listConsents).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "usr_subject",
        accountId: "acc_subject",
      }),
    );
  });

  it("withdraws the actor's current user consent on its event stream", async () => {
    const services = buildServices({
      consent_id: "cns_1",
      subject_type: "user",
      user_id: actor.userId,
      account_id: actor.accountId,
      policy_key: "marketing-email",
      policy_version: "v1",
      status: "recorded",
      recorded_at: "2026-07-01T00:00:00.000Z",
      withdrawn_at: null,
      updated_at: "2026-07-01T00:00:00.000Z",
      is_current: true,
    });

    const response = await buildApp(services).request("/consents/cns_1/withdraw", { method: "POST" });

    expect(response.status).toBe(200);
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "identity.consent-cns_1",
        command: expect.objectContaining({ type: "WithdrawConsent" }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ id: "cns_1", version: 2, status: "withdrawn" });
  });

  it("requires authentication before withdrawing Consent", async () => {
    const services = buildServices();

    const response = await buildApp(services, null).request("/consents/cns_unauthenticated/withdraw", {
      method: "POST",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
    expect(services.getConsent).not.toHaveBeenCalled();
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("returns not found when the requested Consent does not exist", async () => {
    const services = buildServices();

    const response = await buildApp(services).request("/consents/cns_missing/withdraw", { method: "POST" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects withdrawal of a superseded Consent", async () => {
    const services = buildServices({
      consent_id: "cns_superseded",
      subject_type: "user",
      user_id: actor.userId,
      account_id: actor.accountId,
      status: "recorded",
      is_current: false,
    });

    const response = await buildApp(services).request("/consents/cns_superseded/withdraw", { method: "POST" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "consent_superseded" },
    });
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("returns an already-withdrawn Consent idempotently without writing", async () => {
    const services = buildServices({
      consent_id: "cns_withdrawn",
      subject_type: "user",
      user_id: actor.userId,
      account_id: actor.accountId,
      status: "withdrawn",
      withdrawn_at: "2026-07-15T00:00:00.000Z",
      is_current: true,
    });

    const response = await buildApp(services).request("/consents/cns_withdrawn/withdraw", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "cns_withdrawn",
      status: "withdrawn",
      withdrawnAt: "2026-07-15T00:00:00.000Z",
    });
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("does not allow an actor to withdraw another user's consent", async () => {
    const services = buildServices({
      consent_id: "cns_2",
      subject_type: "user",
      user_id: "usr_other",
      account_id: "acc_other",
      policy_key: "marketing-email",
      policy_version: "v1",
      status: "recorded",
      recorded_at: "2026-07-01T00:00:00.000Z",
      withdrawn_at: null,
      updated_at: "2026-07-01T00:00:00.000Z",
      is_current: true,
    });

    const response = await buildApp(services, { ...actor, permissions: ["security.manage"] }).request(
      "/consents/cns_2/withdraw",
      { method: "POST" },
    );

    expect(response.status).toBe(403);
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "platform-admin withdrawing a foreign user's Consent",
      consentId: "cns_platform_admin_foreign",
      subjectType: "user" as const,
      subjectUserId: "usr_member",
      subjectAccountId: "acc_member",
      currentActor: {
        ...actor,
        userId: "usr_admin",
        accountId: "acc_admin",
        roleKey: "platform-admin",
      },
    },
    {
      name: "same-account security.manage withdrawing a colleague's Consent",
      consentId: "cns_security_manager_foreign",
      subjectType: "user" as const,
      subjectUserId: "usr_member",
      subjectAccountId: actor.accountId,
      currentActor: {
        ...actor,
        userId: "usr_security_manager",
        permissions: ["security.manage"],
      },
    },
    {
      name: "accounts.manage withdrawing account-scoped Consent recorded by a colleague",
      consentId: "cns_account_manager_foreign",
      subjectType: "account" as const,
      subjectUserId: "usr_account_owner",
      subjectAccountId: actor.accountId,
      currentActor: {
        ...actor,
        userId: "usr_account_manager",
        permissions: ["accounts.manage"],
      },
    },
  ])("returns the existing named forbidden response without writing for $name", async (testCase) => {
    const { appendToStream, memory, runtime } = createRealHarness();
    await recordConsent(
      runtime,
      testCase.consentId,
      testCase.subjectType,
      testCase.subjectUserId,
      testCase.subjectAccountId,
    );
    const eventsBeforeRequest = [...memory.readAllEvents()];
    appendToStream.mockClear();
    const commandHandler = vi.fn(runtime.commandHandler);
    const services: ConsentServices = {
      ...runtime,
      commandHandler,
      getConsent: async () =>
        projectionRow(
          testCase.consentId,
          testCase.subjectType,
          testCase.subjectUserId,
          testCase.subjectAccountId,
        ) as never,
    };

    const response = await buildApp(services, testCase.currentActor).request(
      `/consents/${testCase.consentId}/withdraw`,
      { method: "POST" },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authorization_forbidden" },
    });
    expect(commandHandler).not.toHaveBeenCalled();
    expect(appendToStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toEqual(eventsBeforeRequest);
    expect(memory.readAllEvents().filter((event) => event.eventType === "identity.consent.withdrawn")).toHaveLength(0);
  });

  it("preserves a named Consent authorization error from the withdrawal command boundary", async () => {
    const services = buildServices({
      consent_id: "cns_authorization_failure",
      subject_type: "user",
      user_id: actor.userId,
      account_id: actor.accountId,
      status: "recorded",
      is_current: true,
    });
    services.commandHandler.mockRejectedValue(
      new ConsentRecordingAuthorizationError(
        "consent_user_not_authorized",
        "User-scoped Consent must name the authoritative request User.",
      ),
    );

    const response = await buildApp(services).request("/consents/cns_authorization_failure/withdraw", {
      method: "POST",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "consent_user_not_authorized" },
    });
  });

  it("does not translate unrelated withdrawal command failures", async () => {
    const services = buildServices({
      consent_id: "cns_unrelated_failure",
      subject_type: "user",
      user_id: actor.userId,
      account_id: actor.accountId,
      status: "recorded",
      is_current: true,
    });
    services.commandHandler.mockRejectedValue(new Error("unexpected withdrawal failure"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await buildApp(services).request("/consents/cns_unrelated_failure/withdraw", {
      method: "POST",
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "internal_error" },
    });
    expect(consoleError).toHaveBeenCalledWith("Unhandled error:", expect.any(Error));
    consoleError.mockRestore();
  });
});
