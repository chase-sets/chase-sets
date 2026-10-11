import { describe, expect, it } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "../../../tests/in-memory-event-store";
import { SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY, toAccountCapabilityAssignmentStreamId } from "../domain/domain";
import {
  createAccountCapabilityRuntime,
  type AccountCapabilityAssignmentAdmission,
  type AccountCapabilityCatalog,
} from "./runtime";

const TENANT = "tnt_synthetic";
const ADMINISTRATOR = "usr_synthetic_administrator";
const ACCOUNT = "acc_synthetic_support";
const context = {
  tenantId: TENANT,
  audit: { performedByUserId: ADMINISTRATOR, forAccountId: ACCOUNT },
} as unknown as EventStoreContext;
// Test-only stand-in for the admission #9385's administration authority will mint.
const admission = { tenantId: TENANT, administratorUserId: ADMINISTRATOR } as AccountCapabilityAssignmentAdmission;
const supportDeclaration = {
  owningContext: "platform-operations",
  key: SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY,
  description: "Synthetic declaration",
  kind: "boolean",
  defaultValue: false,
} as const;
const registry: AccountCapabilityCatalog = [
  {
    owningContext: "authenticity",
    key: "authenticity.seller-included",
    description: "Synthetic",
    kind: "boolean",
    defaultValue: false,
  },
  supportDeclaration,
];
const streamId = toAccountCapabilityAssignmentStreamId({
  tenantId: TENANT,
  accountId: ACCOUNT,
  capabilityKey: SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY,
});

function setup() {
  const eventStore = createInMemoryEventStore();
  const runtime = createAccountCapabilityRuntime({ eventStore, checkpointStore: {} as never, db: {} as never });
  const request = (expectedVersion: number, overrides: Record<string, unknown> = {}) => ({
    admission,
    accountCapabilityRegistry: registry,
    accountId: ACCOUNT,
    capabilityKey: SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY,
    expectedVersion,
    ...overrides,
  });
  return { eventStore, runtime, request, history: () => eventStore.eventTypesFor(streamId) };
}

describe("Account Capability assignment runtime", () => {
  it("records absent -> granted -> revoked -> granted on one stream and treats exact retries as no-ops", async () => {
    const { runtime, request, history } = setup();

    const granted = await runtime.grantAccountCapability(request(0), context);
    expect(await runtime.grantAccountCapability(request(0), context)).toMatchObject({ appended: false, version: 1 });
    const revoked = await runtime.revokeAccountCapability(request(1), context);
    expect(await runtime.revokeAccountCapability(request(1), context)).toMatchObject({ appended: false, version: 2 });
    const regranted = await runtime.grantAccountCapability(request(2), context);

    expect([granted, revoked, regranted].map(({ appended, version, state }) => [appended, version, state.status])).toEqual(
      [
        [true, 1, "granted"],
        [true, 2, "revoked"],
        [true, 3, "granted"],
      ],
    );
    expect(regranted.state).toMatchObject({
      tenantId: TENANT,
      accountId: ACCOUNT,
      assignmentId: granted.state.status === "granted" ? granted.state.assignmentId : "missing",
    });
    expect(history()).toEqual([
      "identity.account-capability.granted",
      "identity.account-capability.revoked",
      "identity.account-capability.granted",
    ]);
  });

  it("lets exactly one of two concurrent grants observed at the same version append", async () => {
    const { runtime, request, history } = setup();

    const outcomes = await Promise.allSettled([
      runtime.grantAccountCapability(request(0), context),
      runtime.grantAccountCapability(request(0), context),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "concurrency_conflict" },
    });
    expect(history()).toEqual(["identity.account-capability.granted"]);
  });

  it.each([
    ["an undeclared key", { accountCapabilityRegistry: [] }, /not declared as a default-false boolean/],
    [
      "a declaration that defaults on",
      { accountCapabilityRegistry: [{ ...supportDeclaration, defaultValue: true }] },
      /not declared as a default-false boolean/,
    ],
    [
      "a non-boolean declaration",
      { accountCapabilityRegistry: [{ ...supportDeclaration, kind: "limit", defaultValue: 0 }] },
      /not declared as a default-false boolean/,
    ],
    // Bypass mutant: validating only against the registry would accept this declared default-false boolean.
    ["another declared boolean key", { capabilityKey: "authenticity.seller-included" }, /support\.evidence\.any-case/],
    ["a missing admission", { admission: undefined }, /requires an administration admission/],
    [
      "an admission for another tenant",
      { admission: { ...admission, tenantId: "tnt_other" } },
      /does not match the request's tenant and administrator/,
    ],
    [
      "an admission for another administrator",
      { admission: { ...admission, administratorUserId: "usr_other" } },
      /does not match the request's tenant and administrator/,
    ],
  ])("rejects %s before any append", async (_name, overrides, error) => {
    const { eventStore, runtime, request } = setup();

    await expect(runtime.grantAccountCapability(request(0, overrides) as never, context)).rejects.toThrow(error);
    await expect(runtime.revokeAccountCapability(request(0, overrides) as never, context)).rejects.toThrow(error);
    expect([...eventStore.streams.keys()]).toEqual([]);
  });

  it("fails a stale request without appending", async () => {
    const { runtime, request, history } = setup();
    await runtime.grantAccountCapability(request(0), context);

    await expect(runtime.revokeAccountCapability(request(0), context)).rejects.toThrow(/expected version 0 is stale/);
    expect(history()).toEqual(["identity.account-capability.granted"]);
  });
});
