import { describe, expect, it } from "vitest";
import { SupportDomainError } from "./common";
import {
  assertRemedyPolicyLimit,
  decodePlatformRemedyPolicyValue,
  PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
  platformRemedyPolicy,
  strongestRemedyPolicyAuthority,
  type RemedyPolicyAuthority,
} from "./platform-remedy-policy";

const authorities: readonly RemedyPolicyAuthority[] = ["propose", "approve", "approveElevated"];

describe("platform remedy policy", () => {
  it("owns every configurable policy dimension with a versioned policy key", () => {
    expect(platformRemedyPolicy.policyKey).toBe("platform-operations.platform-remedies");
    expect(decodePlatformRemedyPolicyValue(PLATFORM_REMEDY_LAUNCH_POLICY_VALUE as never)).toEqual(
      PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
    );
  });

  it("resolves the strongest granted authority and enforces amount limits server-side", () => {
    expect(strongestRemedyPolicyAuthority(["support.remedies.propose", "support.remedies.approve-elevated"])).toBe(
      "approveElevated",
    );
    expect(() =>
      assertRemedyPolicyLimit({
        authority: "approve",
        amount: "250.01",
        eligibleAmount: "500.00",
        policy: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
      }),
    ).toThrow("exceeds the approve amount limit");
  });

  it("rejects unknown triggers and incomplete exception configuration", () => {
    expect(() =>
      decodePlatformRemedyPolicyValue({
        ...PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
        allowableRefundTriggers: ["provider-decides"],
      } as never),
    ).toThrow("unknown trigger");
  });

  it.each(authorities)("enforces remedy percentage limits exactly at the boundary (%s)", (authority) => {
    for (const [limit, amount, above, eligibleAmount] of [
      [57, "5.70", "5.71", "10.00"],
      [29, "0.29", "0.30", "1.00"],
      [33.33, "33.33", "33.34", "100.00"],
    ] as const) {
      const policy = {
        ...PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
        maximumPercentageByCapability: {
          ...PLATFORM_REMEDY_LAUNCH_POLICY_VALUE.maximumPercentageByCapability,
          [authority]: limit,
        },
      };
      expect(() => assertRemedyPolicyLimit({ authority, amount, eligibleAmount, policy })).not.toThrow();
      expect(() => assertRemedyPolicyLimit({ authority, amount: above, eligibleAmount, policy })).toThrow(
        new SupportDomainError(`Remedy amount exceeds the ${authority} percentage limit.`),
      );
    }
  });

  it.each([
    [0.005, "0.01", "100.00", false],
    [99.999, "10.00", "10.00", false],
    [5e-7, "0.01", "10000000.00", true],
    [5e-7, "0.06", "10000000.00", false],
    [1e-7, "0.01", "10000000.00", true],
    [1e-7, "0.02", "10000000.00", false],
    [0, "0.00", "100.00", true],
    [0, "0.01", "100.00", false],
    [Number.MIN_VALUE, "0.00", "100.00", true],
    [Number.MIN_VALUE, "0.01", "100.00", false],
  ] as const)(
    "keeps fractional and exponent-notation limits exact (%s, %s)",
    (limit, amount, eligibleAmount, allowed) => {
      const policy = {
        ...PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
        maximumPercentageByCapability: { propose: limit, approve: limit, approveElevated: limit },
      };
      const check = () => assertRemedyPolicyLimit({ authority: "approve", amount, eligibleAmount, policy });
      if (allowed) {
        expect(check).not.toThrow();
      } else {
        expect(check).toThrow(new SupportDomainError("Remedy amount exceeds the approve percentage limit."));
      }
    },
  );

  it.each(authorities)("keeps the zero-eligible and amount-limit rules (%s)", (authority) => {
    for (const amount of ["0.00", "5.70", "10.00"]) {
      expect(() =>
        assertRemedyPolicyLimit({
          authority,
          amount,
          eligibleAmount: "10.00",
          policy: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
        }),
      ).not.toThrow();
    }
    for (const amount of ["0.00", "10.00"]) {
      expect(() =>
        assertRemedyPolicyLimit({
          authority,
          amount,
          eligibleAmount: "0.00",
          policy: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
        }),
      ).not.toThrow();
      expect(() =>
        assertRemedyPolicyLimit({
          authority,
          amount,
          eligibleAmount: "0.00",
          policy: {
            ...PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
            maximumPercentageByCapability: { propose: 99.99, approve: 99.99, approveElevated: 99.99 },
          },
        }),
      ).toThrow(new SupportDomainError(`Remedy amount exceeds the ${authority} percentage limit.`));
    }
    expect(() =>
      assertRemedyPolicyLimit({
        authority,
        amount: "5000.01",
        eligibleAmount: "1.00",
        policy: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
      }),
    ).toThrow(new SupportDomainError(`Remedy amount exceeds the ${authority} amount limit.`));
  });

  it.each(["abc", "-1.00", "", "1.001", "10000000000.00"])("rejects an invalid remedy amount (%s)", (amount) => {
    expect(() =>
      assertRemedyPolicyLimit({
        authority: "approve",
        amount,
        eligibleAmount: "10.00",
        policy: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
      }),
    ).toThrow(new SupportDomainError("Remedy amount must be a valid money amount."));
  });

  it.each(["abc", "", "-1.00", "1.001", "10000000000.00"])(
    "rejects a non-canonical eligible amount instead of passing it (%s)",
    (eligibleAmount) => {
      expect(() =>
        assertRemedyPolicyLimit({
          authority: "approve",
          amount: "5.70",
          eligibleAmount,
          policy: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
        }),
      ).toThrow(new SupportDomainError("Remedy eligible amount must be a valid money amount."));
    },
  );

  it("keeps the amount-limit error ahead of an invalid eligible amount", () => {
    expect(() =>
      assertRemedyPolicyLimit({
        authority: "approve",
        amount: "250.01",
        eligibleAmount: "abc",
        policy: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
      }),
    ).toThrow(new SupportDomainError("Remedy amount exceeds the approve amount limit."));
  });
});
