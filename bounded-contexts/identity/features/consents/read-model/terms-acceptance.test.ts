import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  consentActivationAuthorityReaderForTest,
  consentActivationAuthoritySnapshotForTest,
} from "../domain/consent-bundle-test-support";
import { resolveTermsAcceptanceStatus } from "./terms-acceptance";

// The required version is a PUBLISHED artifact plus an ACTIVATED authority, so a
// suite that needs a required version has to supply both halves. This one
// publishes the Terms of Service artifact; every case below then chooses what
// its Consent Activation Authority reports.
vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const { publicDocsWithConsentActivatable } = await import("../domain/consent-publication-test-support");
  return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service"], { "terms-of-service": "v2" });
});

const ACTIVATION_KEY = "identity.terms-of-service-active-version";

function readActive(version: string) {
  return vi.fn(consentActivationAuthorityReaderForTest({ [ACTIVATION_KEY]: version }));
}

function fakeDb(rows: readonly Record<string, unknown>[]) {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as PgQueryable;
}

function consentRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    consent_id: "cns_1",
    subject_type: "user",
    user_id: "usr_1",
    account_id: "acc_1",
    policy_key: "terms-of-service",
    policy_version: "v2",
    status: "recorded",
    recorded_at: "2026-03-01T00:00:00.000Z",
    withdrawn_at: null,
    updated_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveTermsAcceptanceStatus", () => {
  it("fails closed when no consent fact exists for the subject", async () => {
    const status = await resolveTermsAcceptanceStatus(fakeDb([]), readActive("v2"), {
      userId: "usr_1",
      accountId: "acc_1",
    });

    expect(status).toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "v2",
      accepted: false,
      acceptedVersion: null,
      acceptedAt: null,
    });
  });

  it("is accepted only when the recorded version exactly matches the ACTIVE version", async () => {
    const stale = await resolveTermsAcceptanceStatus(fakeDb([consentRow({ policy_version: "v1" })]), readActive("v2"), {
      userId: "usr_1",
    });
    expect(stale.accepted).toBe(false);
    expect(stale.requiredVersion).toBe("v2");
    expect(stale.acceptedVersion).toBe("v1");

    const current = await resolveTermsAcceptanceStatus(fakeDb([consentRow()]), readActive("v2"), { userId: "usr_1" });
    expect(current.accepted).toBe(true);
    expect(current.acceptedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("fails closed when the current-version consent was withdrawn", async () => {
    const status = await resolveTermsAcceptanceStatus(
      fakeDb([consentRow({ status: "withdrawn", withdrawn_at: "2026-04-01T00:00:00.000Z" })]),
      readActive("v2"),
      { userId: "usr_1" },
    );

    expect(status.accepted).toBe(false);
    expect(status.acceptedVersion).toBe("v2");
  });

  it("keeps the host port's user-or-account subject breadth", async () => {
    const db = fakeDb([]);
    const query = db.query as unknown as ReturnType<typeof vi.fn>;
    await resolveTermsAcceptanceStatus(db, readActive("v2"), { userId: "usr_1", accountId: "acc_1" });

    expect(query.mock.calls[0]?.[0]).toContain("user_id = $2 OR account_id = $3");
    expect(query.mock.calls[0]?.[1]).toEqual(["terms-of-service", "usr_1", "acc_1"]);
  });

  describe("the required version comes from the activation authority, never a cached policy value", () => {
    it("does not report a subject holding the superseded version as accepted", async () => {
      // The exact #6290-F2 shape: authority active at v2, a real recorded v1
      // consent for this subject. A cached policy value reporting v1 would make
      // this read `accepted: true`; the authority is the only source here.
      const status = await resolveTermsAcceptanceStatus(
        fakeDb([consentRow({ policy_version: "v1" })]),
        readActive("v2"),
        { userId: "usr_1", accountId: "acc_1" },
      );

      expect(status).toEqual({
        policyKey: "terms-of-service",
        requiredVersion: "v2",
        accepted: false,
        acceptedVersion: "v1",
        acceptedAt: "2026-03-01T00:00:00.000Z",
      });
    });

    it.each([
      {
        name: "an inactive authority",
        read: async () => consentActivationAuthoritySnapshotForTest(ACTIVATION_KEY, { status: "inactive" }),
      },
      {
        name: "a never-activated authority",
        read: async () => consentActivationAuthoritySnapshotForTest(ACTIVATION_KEY, { status: "never-activated" }),
      },
      {
        name: "an authority active at a version the publication does not carry",
        read: async () =>
          consentActivationAuthoritySnapshotForTest(ACTIVATION_KEY, { status: "active", activeVersion: "v9" }),
      },
      {
        name: "a malformed snapshot",
        read: async () => ({ policyKey: ACTIVATION_KEY, isActive: true }) as never,
      },
      {
        name: "an unreadable authority",
        read: async () => {
          throw new Error("authority stream unavailable");
        },
      },
    ])("fails closed on $name while preserving the host-port output shape", async ({ read }) => {
      // A consent recorded at the published version is planted deliberately: if
      // the required version were taken from anywhere but a trustworthy
      // authority read, this subject would read as accepted.
      const status = await resolveTermsAcceptanceStatus(fakeDb([consentRow()]), read, { userId: "usr_1" });

      expect(status).toEqual({
        policyKey: "terms-of-service",
        requiredVersion: "",
        accepted: false,
        acceptedVersion: "v2",
        acceptedAt: "2026-03-01T00:00:00.000Z",
      });
    });
  });
});
