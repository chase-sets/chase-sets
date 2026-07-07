import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildConsentProjectionHandlers } from "./projection";

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
});
