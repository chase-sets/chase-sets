import { describe, expect, it } from "vitest";
import { decideCommercialAgreement, evolveCommercialAgreement, initialCommercialAgreementState } from "./domain";

describe("commercial terms agreements", () => {
  it("normalizes account-specific agreement fees and effective windows", () => {
    const [event] = decideCommercialAgreement(initialCommercialAgreementState, {
      type: "CreateAgreement",
      agreementId: " agreement-1 ",
      accountId: " acc_1 ",
      label: " Preferred Seller ",
      marketplaceSalesFeePercentageBps: 125,
      marketplaceSalesFeeFixedAmount: "0",
      status: "active",
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: "2027-04-30T00:00:00.000Z",
      createdByUserId: " usr_admin ",
    });

    expect(event).toMatchObject({
      data: {
        createdByUserId: "usr_admin",
      },
    });
    expect(evolveCommercialAgreement(initialCommercialAgreementState, event!)).toMatchObject({
      agreementId: "agreement-1",
      accountId: "acc_1",
      label: "Preferred Seller",
      marketplaceSalesFeeFixedAmount: "0.00",
      effectiveUntil: "2027-04-30T00:00:00.000Z",
    });
  });

  it("revises account-specific agreement economics without moving accounts", () => {
    const [created] = decideCommercialAgreement(initialCommercialAgreementState, {
      type: "CreateAgreement",
      agreementId: "cag_1",
      accountId: "acc_1",
      label: "Preferred Seller",
      marketplaceSalesFeePercentageBps: 700,
      marketplaceSalesFeeFixedAmount: "0.05",
      shippingAllowancePercentageBps: 500,
      status: "active",
      effectiveFrom: "2026-04-30T00:00:00.000Z",
      effectiveUntil: null,
      createdByUserId: "usr_admin",
    });
    const createdState = evolveCommercialAgreement(initialCommercialAgreementState, created!);

    const [revised] = decideCommercialAgreement(createdState, {
      type: "ReviseAgreement",
      label: "Preferred Seller Renewal",
      marketplaceSalesFeePercentageBps: 600,
      marketplaceSalesFeeFixedAmount: "0",
      shippingAllowancePercentageBps: 800,
      status: "active",
      effectiveFrom: "2026-05-01T00:00:00.000Z",
      effectiveUntil: "2027-05-01T00:00:00.000Z",
      revisedByUserId: " usr_reviser ",
    });

    expect(revised).toMatchObject({
      type: "commercial-terms.agreement.revised",
      data: {
        agreementId: "cag_1",
        label: "Preferred Seller Renewal",
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 800,
        revisedByUserId: "usr_reviser",
      },
    });
    expect(evolveCommercialAgreement(createdState, revised!)).toMatchObject({
      agreementId: "cag_1",
      accountId: "acc_1",
      label: "Preferred Seller Renewal",
      effectiveUntil: "2027-05-01T00:00:00.000Z",
    });
  });
});
