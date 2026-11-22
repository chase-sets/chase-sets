import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { consentActivationGuardAppendInput } from "@chase-sets/platform-policy/consent-activation-authority";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import { resolveOfferPaymentEnforcement } from "../api/enforcement";
import {
  OFFER_AUTOMATIC_CHARGE_V1,
  OFFER_PAYMENT_CONSENT_POLICY_KEY,
  offerPaymentConsentPublications,
} from "./consent-text";
import { marketplaceOfferPaymentConsentPolicy, offerPaymentConsentActivationPolicy } from "./policy";

const context = {
  tenantId: createId("tnt"),
  audit: { performedByUserId: createId("usr"), forAccountId: createId("acc") },
};
const document = {
  status: "active",
  effectiveFrom: "2026-11-21T00:00:00.000Z",
  effectiveUntil: null,
  actorUserId: context.audit.performedByUserId,
} as const;
const policy = marketplaceOfferPaymentConsentPolicy;

function setup() {
  const { eventStore } = createInMemoryEventStore();
  const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return createPolicyRuntime({ eventStore, db });
}

describe("Offer payment consent policy", () => {
  it.each([null, OFFER_AUTOMATIC_CHARGE_V1])(
    "leaves enforcement off when a first document sets %s and is then revised",
    async (approvedConsentVersion) => {
      const runtime = setup();
      const read = vi.fn(runtime.consentActivation.read);
      const { documentId } = await runtime.createPolicyDocument(
        policy,
        { ...document, value: { approvedConsentVersion } },
        context,
      );
      const initial = await resolveOfferPaymentEnforcement({ read });
      expect(read).toHaveBeenCalledExactlyOnceWith(OFFER_PAYMENT_CONSENT_POLICY_KEY);
      expect(initial).toMatchObject({ version: null, snapshot: { status: "never-activated", authorityVersion: 0 } });

      await runtime.revisePolicyDocument(
        policy,
        documentId,
        { ...document, value: { approvedConsentVersion: OFFER_AUTOMATIC_CHARGE_V1 } },
        context,
      );
      expect(await runtime.readPolicyDocumentState(documentId)).toMatchObject({
        version: 2,
        state: { value: { approvedConsentVersion: OFFER_AUTOMATIC_CHARGE_V1 } },
      });
      read.mockClear();
      const revised = await resolveOfferPaymentEnforcement({ read });
      expect(revised).toEqual(initial);
      expect(read).toHaveBeenCalledExactlyOnceWith(OFFER_PAYMENT_CONSENT_POLICY_KEY);
      expect(consentActivationGuardAppendInput(revised.snapshot.guard, context)).toMatchObject({
        streamId: revised.snapshot.streamId,
        expectedVersion: "no_stream",
        events: [],
      });
    },
  );

  it("decodes only declared non-null document versions for activation", () => {
    const adapter = offerPaymentConsentActivationPolicy(offerPaymentConsentPublications);
    expect(policy.defaultValue).toEqual({ approvedConsentVersion: null });
    expect(adapter.decodeValue({ approvedConsentVersion: OFFER_AUTOMATIC_CHARGE_V1 })).toEqual({
      version: OFFER_AUTOMATIC_CHARGE_V1,
    });
    for (const value of [
      { approvedConsentVersion: null },
      { approvedConsentVersion: "offer-automatic-charge-v999" },
      { approvedConsentVersion: "offer-automatic-charge-v01" },
      { approvedConsentVersion: OFFER_AUTOMATIC_CHARGE_V1, version: OFFER_AUTOMATIC_CHARGE_V1 },
    ]) {
      expect(() => adapter.decodeValue(value)).toThrow();
    }
  });

  it.each([
    [OFFER_AUTOMATIC_CHARGE_V1, OFFER_AUTOMATIC_CHARGE_V1],
    ["offer-automatic-charge-v999", null],
  ])("resolves only a declared active version (%s) with its exact guard", async (activeVersion, version) => {
    const { consentActivation } = setup();
    await consentActivation.register(policy, context);
    await consentActivation.activate(
      policy,
      { documentId: "synthetic-policy-document", actorUserId: document.actorUserId, version: activeVersion },
      context,
    );

    const read = vi.fn(consentActivation.read);
    const resolved = await resolveOfferPaymentEnforcement({ read });
    expect(read).toHaveBeenCalledExactlyOnceWith(OFFER_PAYMENT_CONSENT_POLICY_KEY);
    expect(resolved).toMatchObject({ version, snapshot: { activeVersion, authorityVersion: 2 } });
    expect(consentActivationGuardAppendInput(resolved.snapshot.guard, context)).toMatchObject({
      streamId: resolved.snapshot.streamId,
      expectedVersion: 2,
      events: [],
    });
  });
});
