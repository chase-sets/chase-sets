import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { ConsentActivationAuthorityError } from "@chase-sets/platform-policy/consent-activation-authority";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  activeSnapshot,
  deactivatedSnapshot,
  recordingAuthorityReader,
  registeredNeverActivatedSnapshot,
} from "../../../tests/consent-activation-authority-fixtures";
import type { ConsentActivationAuthorityReader } from "../domain/consent-bundle";
import { identityConsentActiveVersionPolicies } from "../domain/terms-of-service-policy";
import { resolveTermsAcceptanceStatus } from "./terms-acceptance";

const TERMS_ACTIVE_VERSION_POLICY_KEY = identityConsentActiveVersionPolicies["terms-of-service"].policyKey;

function fakeDb(rows: readonly Record<string, unknown>[]) {
  return { query: vi.fn(async () => ({ rows: [...rows], rowCount: rows.length })) } as unknown as PgQueryable;
}

function recordedTermsRow(policyVersion: string, status: "recorded" | "withdrawn" = "recorded") {
  return {
    consent_id: "cns_1",
    subject_type: "user",
    subject_id: "usr_1",
    user_id: "usr_1",
    account_id: "acc_1",
    policy_key: "terms-of-service",
    policy_version: policyVersion,
    status,
    recorded_at: "2026-03-01T00:00:00.000Z",
    withdrawn_at: status === "withdrawn" ? "2026-04-01T00:00:00.000Z" : null,
    updated_at: "2026-04-01T00:00:00.000Z",
  };
}

describe("resolveTermsAcceptanceStatus", () => {
  it("fails closed when no consent fact exists for the subject", async () => {
    const status = await resolveTermsAcceptanceStatus(fakeDb([]), recordingAuthorityReader({}), {
      userId: "usr_1",
      accountId: "acc_1",
    });

    expect(status).toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "",
      accepted: false,
      acceptedVersion: null,
      acceptedAt: null,
    });
  });

  it("keeps the exact host output field set", async () => {
    const status = await resolveTermsAcceptanceStatus(fakeDb([recordedTermsRow("v1")]), recordingAuthorityReader({}), {
      userId: "usr_1",
    });

    expect(Object.keys(status).sort()).toEqual([
      "accepted",
      "acceptedAt",
      "acceptedVersion",
      "policyKey",
      "requiredVersion",
    ]);
  });

  it.each([
    { name: "an unreadable authority", version: "v1" },
    { name: "a superseded recorded version", version: "v1" },
  ])("never reports acceptance for $name at the shipped corpus", async ({ version }) => {
    const status = await resolveTermsAcceptanceStatus(
      fakeDb([recordedTermsRow(version)]),
      recordingAuthorityReader({}),
      { userId: "usr_1" },
    );

    expect(status.accepted).toBe(false);
    expect(status.requiredVersion).toBe("");
    // Consent history stays readable even though it cannot satisfy anything.
    expect(status.acceptedVersion).toBe(version);
  });

  it("reads no authority at all while the Terms publication is not consent-activatable", async () => {
    const authority = recordingAuthorityReader({
      [TERMS_ACTIVE_VERSION_POLICY_KEY]: () => activeSnapshot(TERMS_ACTIVE_VERSION_POLICY_KEY, "v1"),
    });

    await resolveTermsAcceptanceStatus(fakeDb([]), authority, { userId: "usr_1" });

    expect(authority.reads).toEqual([]);
  });

  it("fails closed instead of throwing when the authority cannot be validated", async () => {
    const unreadable: ConsentActivationAuthorityReader = {
      read: async () => {
        throw new ConsentActivationAuthorityError("history_too_long", "authority history exceeded its bound");
      },
    };

    const status = await resolveTermsAcceptanceStatus(fakeDb([recordedTermsRow("v1")]), unreadable, {
      userId: "usr_1",
    });

    expect(status).toMatchObject({ requiredVersion: "", accepted: false });
  });

  it.each([
    { name: "never activated", snapshot: () => registeredNeverActivatedSnapshot(TERMS_ACTIVE_VERSION_POLICY_KEY) },
    { name: "deactivated", snapshot: () => deactivatedSnapshot(TERMS_ACTIVE_VERSION_POLICY_KEY) },
  ])("keeps a $name authority from producing a required version", async ({ snapshot }) => {
    const authority = recordingAuthorityReader({ [TERMS_ACTIVE_VERSION_POLICY_KEY]: snapshot });

    const status = await resolveTermsAcceptanceStatus(fakeDb([recordedTermsRow("v1")]), authority, {
      userId: "usr_1",
    });

    expect(status).toMatchObject({ requiredVersion: "", accepted: false });
  });

  it("queries the shipped user-or-account host disjunction unchanged", async () => {
    const db = fakeDb([]);

    await resolveTermsAcceptanceStatus(db, recordingAuthorityReader({}), { userId: "usr_1", accountId: "acc_1" });

    const [sql, values] = vi.mocked(db.query).mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain("(user_id = $2 OR account_id = $3)");
    expect(values).toEqual(["terms-of-service", "usr_1", "acc_1"]);
  });
});

describe("the cached policy resolver is unreachable from the acceptance gate", () => {
  it("never calls resolvePolicy when handed a whole policy runtime's authority surface", async () => {
    const resolvePolicy = vi.fn(async () => {
      throw new Error("resolvePolicy must never be reached by the acceptance gate.");
    });
    const runtime = {
      resolvePolicy,
      consentActivation: recordingAuthorityReader({}),
    } as unknown as Pick<PolicyRuntime, "resolvePolicy" | "consentActivation">;

    const status = await resolveTermsAcceptanceStatus(fakeDb([]), runtime.consentActivation, { userId: "usr_1" });

    expect(resolvePolicy).not.toHaveBeenCalled();
    expect(status.requiredVersion).toBe("");
  });

  it("cannot be handed a cached policy resolver in place of the authority reader", async () => {
    const cachedOnly = {
      resolvePolicy: vi.fn(async () => ({ value: { version: "v2" } })),
    };

    const status = await resolveTermsAcceptanceStatus(
      fakeDb([recordedTermsRow("v2")]),
      // @ts-expect-error the authority reader has no resolvePolicy member, so a cached resolver cannot stand in for it.
      cachedOnly,
      { userId: "usr_1" },
    );

    // Even forced through at runtime, the cached value never becomes a required
    // version: the publication is ineligible and no read is attempted.
    expect(status).toMatchObject({ requiredVersion: "", accepted: false });
    expect(cachedOnly.resolvePolicy).not.toHaveBeenCalled();
  });
});
