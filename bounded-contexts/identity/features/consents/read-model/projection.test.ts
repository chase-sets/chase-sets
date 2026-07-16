import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildConsentCurrentStateProjectionHandlers, buildConsentProjectionHandlers } from "./projection";

describe("identity consent projection", () => {
  it("normalizes legacy consent facts before writing not-null read model columns", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as PgQueryable;
    const handlers = buildConsentProjectionHandlers(db);
    const handler = handlers["identity.consent.recorded"];
    expect(handler).toBeDefined();

    await handler!({
      id: "evt_1",
      type: "identity.consent.recorded",
      data: {
        consentId: "cns_1",
        userId: "usr_1",
        accountId: "acc_1",
        policyKey: "terms-of-service",
        policyVersion: "v1",
      },
      tenantId: "tnt_test",
      streamId: "identity.consent-cns_1",
      streamVersion: 1,
      globalPosition: "1",
      trace: { traceId: null },
      audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
      timing: {
        occurredAt: "2026-07-01T00:00:00.000Z",
        recordedAt: "2026-07-01T00:00:01.000Z",
      },
      metadata: {},
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO identity_consents"), [
      "cns_1",
      "user",
      "usr_1",
      "acc_1",
      "terms-of-service",
      "v1",
      "2026-07-01T00:00:01.000Z",
      "2026-07-01T00:00:01.000Z",
    ]);
  });

  it("projects policy-key-less legacy consent facts under an explicit legacy policy", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as PgQueryable;
    const handlers = buildConsentProjectionHandlers(db);

    await handlers["identity.consent.recorded"]!({
      id: "evt_legacy",
      type: "identity.consent.recorded",
      data: {
        consentId: "cns_legacy",
        userId: "usr_legacy",
      },
      tenantId: "tnt_test",
      streamId: "identity.consent-cns_legacy",
      streamVersion: 1,
      globalPosition: "1",
      trace: { traceId: null },
      audit: { performedByUserId: "usr_legacy", forAccountId: null },
      timing: {
        occurredAt: "2026-06-01T00:00:00.000Z",
        recordedAt: "2026-06-01T00:00:01.000Z",
      },
      metadata: {},
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO identity_consents"), [
      "cns_legacy",
      "user",
      "usr_legacy",
      null,
      "legacy-consent",
      "legacy",
      "2026-06-01T00:00:01.000Z",
      "2026-06-01T00:00:01.000Z",
    ]);
  });

  it("normalizes legacy consent facts with missing recorded timing before database writes", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as PgQueryable;
    const handlers = buildConsentProjectionHandlers(db);

    await handlers["identity.consent.recorded"]!({
      id: "evt_legacy_timing",
      type: "identity.consent.recorded",
      data: {
        consentId: "cns_legacy_timing",
        userId: "usr_legacy",
      },
      tenantId: "tnt_test",
      streamId: "identity.consent-cns_legacy_timing",
      streamVersion: 1,
      globalPosition: "1",
      trace: { traceId: null },
      audit: { performedByUserId: "usr_legacy", forAccountId: null },
      timing: {
        occurredAt: "2026-05-01T00:00:00.000Z",
        recordedAt: null,
      },
      metadata: {},
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO identity_consents"), [
      "cns_legacy_timing",
      "user",
      "usr_legacy",
      null,
      "legacy-consent",
      "legacy",
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
    ]);
  });

  it("projects consent withdrawal onto the retained history record", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as PgQueryable;
    const handlers = buildConsentProjectionHandlers(db);

    await handlers["identity.consent.withdrawn"]!({
      id: "evt_withdrawn",
      type: "identity.consent.withdrawn",
      data: {
        consentId: "cns_1",
        subjectType: "user",
        userId: "usr_1",
        accountId: "acc_1",
        policyKey: "marketing-email",
        policyVersion: "v1",
        withdrawnAt: "2026-07-02T00:00:00.000Z",
      },
      tenantId: "tnt_test",
      streamId: "identity.consent-cns_1",
      streamVersion: 2,
      globalPosition: "2",
      trace: { traceId: null },
      audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
      timing: {
        occurredAt: "2026-07-02T00:00:00.000Z",
        recordedAt: "2026-07-02T00:00:01.000Z",
      },
      metadata: {},
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE identity_consents"), [
      "cns_1",
      "2026-07-02T00:00:00.000Z",
      "2026-07-02T00:00:01.000Z",
    ]);
  });

  it("projects record, withdrawal, and re-record as one current policy state", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as PgQueryable;
    const handlers = buildConsentCurrentStateProjectionHandlers(db);
    const common = {
      tenantId: "tnt_test",
      trace: { traceId: null },
      audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
      metadata: {},
    } as const;

    await handlers["identity.consent.recorded"]!({
      ...common,
      id: "evt_recorded_1",
      type: "identity.consent.recorded",
      data: {
        consentId: "cns_1",
        subjectType: "user",
        userId: "usr_1",
        accountId: "acc_1",
        policyKey: "marketing-email",
        policyVersion: "v1",
        recordedAt: "2026-07-01T00:00:00.000Z",
      },
      streamId: "identity.consent-cns_1",
      streamVersion: 1,
      globalPosition: "1",
      timing: { occurredAt: "2026-07-01T00:00:00.000Z", recordedAt: "2026-07-01T00:00:01.000Z" },
    } as never);
    await handlers["identity.consent.withdrawn"]!({
      ...common,
      id: "evt_withdrawn_1",
      type: "identity.consent.withdrawn",
      data: {
        consentId: "cns_1",
        subjectType: "user",
        userId: "usr_1",
        accountId: "acc_1",
        policyKey: "marketing-email",
        policyVersion: "v1",
        withdrawnAt: "2026-07-02T00:00:00.000Z",
      },
      streamId: "identity.consent-cns_1",
      streamVersion: 2,
      globalPosition: "2",
      timing: { occurredAt: "2026-07-02T00:00:00.000Z", recordedAt: "2026-07-02T00:00:01.000Z" },
    } as never);
    await handlers["identity.consent.recorded"]!({
      ...common,
      id: "evt_recorded_2",
      type: "identity.consent.recorded",
      data: {
        consentId: "cns_2",
        subjectType: "user",
        userId: "usr_1",
        accountId: "acc_1",
        policyKey: "marketing-email",
        policyVersion: "v2",
        recordedAt: "2026-07-03T00:00:00.000Z",
      },
      streamId: "identity.consent-cns_2",
      streamVersion: 1,
      globalPosition: "3",
      timing: { occurredAt: "2026-07-03T00:00:00.000Z", recordedAt: "2026-07-03T00:00:01.000Z" },
    } as never);

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("identity_consent_current_states"), [
      "user",
      "usr_1",
      "usr_1",
      "acc_1",
      "marketing-email",
      "cns_1",
      "v1",
      "recorded",
      "2026-07-01T00:00:00.000Z",
      null,
      "1",
      "2026-07-01T00:00:01.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET status = 'withdrawn'"), [
      "user",
      "usr_1",
      "marketing-email",
      "cns_1",
      "2026-07-02T00:00:00.000Z",
      "2",
      "2026-07-02T00:00:01.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("identity_consent_current_states"), [
      "user",
      "usr_1",
      "usr_1",
      "acc_1",
      "marketing-email",
      "cns_2",
      "v2",
      "recorded",
      "2026-07-03T00:00:00.000Z",
      null,
      "3",
      "2026-07-03T00:00:01.000Z",
    ]);
  });
});
