import { describe, expect, it } from "vitest";
import {
  decideCommercialAgreement,
  evolveCommercialAgreement,
  initialCommercialAgreementState,
} from "./domain";

describe("commercial terms agreements", () => {
  it("normalizes account-specific agreement fees and effective windows", () => {
    const [event] = decideCommercialAgreement(initialCommercialAgreementState, {
      type: "CreateAgreement",
      agreementId: " agreement-1 ",
      accountId: " acc_1 ",
      label: " Preferred Seller ",
      marketplaceFeePercentageBps: 125,
      marketplaceFeeFixedAmount: "0",
      paymentFeePercentageBps: 290,
      paymentFeeFixedAmount: "0.30",
      status: "active",
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: "2027-04-30T00:00:00.000Z",
    });

    expect(evolveCommercialAgreement(initialCommercialAgreementState, event!)).toMatchObject({
      agreementId: "agreement-1",
      accountId: "acc_1",
      label: "Preferred Seller",
      marketplaceFeeFixedAmount: "0.00",
      effectiveUntil: "2027-04-30T00:00:00.000Z",
    });
  });
});
