import { describe, expect, it } from "vitest";
import { decideRecoveredItem, evolveRecoveredItem, initialRecoveredItemState } from "./recovered-item";

const created = {
  type: "CreateRecoveredItem" as const,
  recoveredItemId: "rcv_1",
  returnShipmentId: "rsh_1",
  remedyId: "rmd_1",
  custodyLocationId: "facility-1:station-2",
  custodyIdentifier: "CUST-1",
  evidenceReferences: ["att_1"],
  intakeDisposition: "completed" as const,
  hasDiscrepancy: false,
  observedItemReference: "order-line-1",
  policyVersion: "returns-2026-07",
  receivedAt: "2026-07-15T02:00:00.000Z",
};

function stateAfter(...commands: Parameters<typeof decideRecoveredItem>[1][]) {
  let state = initialRecoveredItemState;
  for (const command of commands) {
    for (const event of decideRecoveredItem(state, command)) {
      state = evolveRecoveredItem(state, event);
    }
  }
  return state;
}

describe("RecoveredItem", () => {
  it("creates one quarantined item idempotently from facility intake", () => {
    const events = decideRecoveredItem(initialRecoveredItemState, created);
    const state = evolveRecoveredItem(initialRecoveredItemState, events[0]!);

    expect(events).toHaveLength(1);
    expect(state.status).toBe("quarantined");
    expect(decideRecoveredItem(state, created)).toEqual([]);
    expect(() => decideRecoveredItem(state, { ...created, returnShipmentId: "rsh_other" })).toThrow(
      "Recovered item id was reused",
    );
  });

  it("keeps unidentified or discrepant intake unavailable", () => {
    const state = stateAfter({
      ...created,
      observedItemReference: null,
      hasDiscrepancy: true,
      intakeDisposition: "quarantine",
    });

    expect(state.status).toBe("awaiting-identification");
    expect(state.sellableAt).toBeNull();
  });

  it("requires identification, inspection, explicit ownership authority, and authenticity policy completion before resale", () => {
    const identified = {
      type: "IdentifyRecoveredItem" as const,
      catalogItemId: "cat_1",
      productId: "product-1",
      selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
      identifiedByUserId: "usr_1",
      evidenceReferences: ["att_identity"],
      identifiedAt: "2026-07-15T03:00:00.000Z",
    };
    const inspected = {
      type: "CompleteRecoveredItemInspection" as const,
      conditionGrade: "near-mint",
      inspectedByUserId: "usr_1",
      evidenceReferences: ["att_condition"],
      inspectedAt: "2026-07-15T04:00:00.000Z",
    };
    const authRequired = {
      type: "RequireRecoveredItemAuthenticityReview" as const,
      policyVersion: "returns-2026-07",
      reasonCode: "high-value-card",
      requestedByUserId: "usr_1",
      evidenceReferences: ["att_policy"],
      requestedAt: "2026-07-15T05:00:00.000Z",
    };
    const authority = {
      type: "RecordRecoveredItemDispositionAuthority" as const,
      legalOwner: "platform" as const,
      authorityKind: "terms-acceptance" as const,
      allowedDispositions: ["platform-resale"] as const,
      policyVersion: "returns-2026-07",
      authorizedByUserId: "usr_2",
      evidenceReferences: ["att_terms"],
      authorizedAt: "2026-07-15T06:00:00.000Z",
    };
    const resale = {
      type: "DecideRecoveredItemDisposition" as const,
      disposition: "platform-resale" as const,
      targetAccountId: null,
      storageLocationId: "loc_1",
      policyVersion: "returns-2026-07",
      decidedByUserId: "usr_2",
      evidenceReferences: ["att_disposition"],
      reasonCode: "approved-for-resale",
      decidedAt: "2026-07-15T07:00:00.000Z",
    };

    const beforeReview = stateAfter(created, identified, inspected, authRequired, authority);
    const requested = decideRecoveredItem(stateAfter(created, identified, inspected), authRequired)[0]!;
    expect(requested.data).toMatchObject({
      recoveredItemId: "rcv_1",
      remedyId: "rmd_1",
      catalogItemId: "cat_1",
      productId: "product-1",
    });
    expect(() => decideRecoveredItem(beforeReview, resale)).toThrow("Authenticity review must be complete");

    const ready = stateAfter(
      created,
      identified,
      inspected,
      authRequired,
      {
        type: "CompleteRecoveredItemAuthenticityReview",
        outcome: "authentic",
        reviewReference: "auth-review-1",
        reviewedByUserId: "usr_3",
        evidenceReferences: ["att_auth"],
        reviewedAt: "2026-07-15T05:30:00.000Z",
      },
      authority,
    );
    const events = decideRecoveredItem(ready, resale);

    expect(events.map((event) => event.type)).toEqual([
      "inventory.recovered-item.disposition-decided.v1",
      "inventory.recovered-item.sellable.v1",
    ]);
  });

  it.each([
    "return-to-original-seller",
    "return-to-buyer",
    "platform-resale",
    "liquidation",
    "donation",
    "destruction",
    "carrier-claim",
  ] as const)("requires matching policy authority before %s", (disposition) => {
    const state = stateAfter(
      created,
      {
        type: "IdentifyRecoveredItem",
        catalogItemId: "cat_1",
        productId: "product-1",
        selectedOptions: [],
        identifiedByUserId: "usr_1",
        evidenceReferences: ["att_identity"],
        identifiedAt: "2026-07-15T03:00:00.000Z",
      },
      {
        type: "CompleteRecoveredItemInspection",
        conditionGrade: "damaged",
        inspectedByUserId: "usr_1",
        evidenceReferences: ["att_condition"],
        inspectedAt: "2026-07-15T04:00:00.000Z",
      },
    );

    expect(() =>
      decideRecoveredItem(state, {
        type: "DecideRecoveredItemDisposition",
        disposition,
        targetAccountId: disposition.startsWith("return-to-") ? "acc_target" : null,
        storageLocationId: disposition === "platform-resale" ? "loc_1" : null,
        policyVersion: "returns-2026-07",
        decidedByUserId: "usr_2",
        evidenceReferences: ["att_disposition"],
        reasonCode: "operator-decision",
        decidedAt: "2026-07-15T05:00:00.000Z",
      }),
    ).toThrow("Disposition requires explicit ownership and policy authority");
  });

  it("allows lost or unresolved custody truth with evidence while ownership is unresolved", () => {
    const state = stateAfter(created);
    const events = decideRecoveredItem(state, {
      type: "DecideRecoveredItemDisposition",
      disposition: "lost-unresolved",
      targetAccountId: null,
      storageLocationId: null,
      policyVersion: "returns-2026-07",
      decidedByUserId: "usr_2",
      evidenceReferences: ["att_loss"],
      reasonCode: "custody-location-unresolved",
      decidedAt: "2026-07-15T05:00:00.000Z",
    });

    expect(events.map((event) => event.type)).toEqual([
      "inventory.recovered-item.disposition-decided.v1",
      "inventory.recovered-item.disposed.v1",
    ]);
  });

  it("reports gross value and costs as an immutable, idempotent recovery fact", () => {
    const state = stateAfter(created, {
      type: "DecideRecoveredItemDisposition",
      disposition: "lost-unresolved",
      targetAccountId: null,
      storageLocationId: null,
      policyVersion: "returns-2026-07",
      decidedByUserId: "usr_2",
      evidenceReferences: ["att_loss"],
      reasonCode: "carrier-confirmed-loss",
      decidedAt: "2026-07-15T05:00:00.000Z",
    });
    const command = {
      type: "RecordRecoveredItemValue" as const,
      recoveryId: "recovery-1",
      recoveryType: "carrier-claim" as const,
      grossAmount: "42.00",
      costAmount: "5.25",
      currencyCode: "usd",
      policyVersion: "returns-2026-07",
      evidenceReferences: ["claim-1"],
      recordedByUserId: "usr_2",
      recordedAt: "2026-07-15T06:00:00.000Z",
    };
    expect(() => decideRecoveredItem(stateAfter(created), command)).toThrow(
      "Recovered value requires a recorded disposition",
    );
    const event = decideRecoveredItem(state, command)[0]!;
    const updated = evolveRecoveredItem(state, event);

    expect(event.type).toBe("inventory.recovered-item.value-reported.v1");
    expect(event.data).toMatchObject({ grossAmount: "42.00", costAmount: "5.25", currencyCode: "USD" });
    expect(decideRecoveredItem(updated, command)).toEqual([]);
    expect(() => decideRecoveredItem(updated, { ...command, grossAmount: "43.00" })).toThrow("Recovery id was reused");
  });

  it("supports append-only source correction and duplicate merge", () => {
    const corrected = decideRecoveredItem(stateAfter(created), {
      type: "CorrectRecoveredItemSource",
      correctedReturnShipmentId: "rsh_2",
      reason: "Package was matched to the wrong label",
      correctedByUserId: "usr_2",
      evidenceReferences: ["att_correction"],
      correctedAt: "2026-07-15T06:00:00.000Z",
    })[0]!;
    const merged = decideRecoveredItem(evolveRecoveredItem(stateAfter(created), corrected), {
      type: "MergeRecoveredItem",
      canonicalRecoveredItemId: "rcv_canonical",
      reason: "Duplicate package record",
      mergedByUserId: "usr_2",
      evidenceReferences: ["att_merge"],
      mergedAt: "2026-07-15T07:00:00.000Z",
    });

    expect(corrected.type).toBe("inventory.recovered-item.source-corrected.v1");
    expect(merged[0]!.type).toBe("inventory.recovered-item.merged.v1");
  });
});
