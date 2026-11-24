import { describe, expect, it } from "vitest";
import { encodePolicyValue } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  decodeMarketplaceListingReportAutoUnlistPolicyValue,
  MarketplaceListingReportAutoUnlistPolicyError,
  marketplaceListingReportAutoUnlistPolicy,
} from "./listing-report-auto-unlist-policy";

describe("Listing Report Auto-Unlist Policy", () => {
  it("declares the Marketplace key and the terms in force before the policy existed", () => {
    expect(marketplaceListingReportAutoUnlistPolicy.policyKey).toBe("marketplace.listing-report-auto-unlist");
    expect(marketplaceListingReportAutoUnlistPolicy.contextName).toBe("marketplace");
    expect(marketplaceListingReportAutoUnlistPolicy.defaultValue).toEqual({
      distinctReporterThreshold: 3,
      windowDays: 7,
    });
    expect(marketplaceListingReportAutoUnlistPolicy.schemaSummary).toBe(
      "{ distinctReporterThreshold: integer 2-100, windowDays: integer 1-90 }",
    );
    expect(marketplaceListingReportAutoUnlistPolicy.decodeValue).toBe(
      decodeMarketplaceListingReportAutoUnlistPolicyValue,
    );
  });

  it("decodes its own default after a storage round trip", () => {
    const { defaultValue, decodeValue } = marketplaceListingReportAutoUnlistPolicy;
    expect(decodeValue(encodePolicyValue(defaultValue))).toEqual(defaultValue);
  });

  it.each([
    { distinctReporterThreshold: 2, windowDays: 1 },
    { distinctReporterThreshold: 100, windowDays: 90 },
    { windowDays: 30, distinctReporterThreshold: 5 },
  ])("decodes the in-bounds terms %o", (value) => {
    expect(decodeMarketplaceListingReportAutoUnlistPolicyValue(value)).toEqual({
      distinctReporterThreshold: value.distinctReporterThreshold,
      windowDays: value.windowDays,
    });
  });

  const valid = { distinctReporterThreshold: 3, windowDays: 7 };
  const rejected: readonly Readonly<{ name: string; value: JsonValue; message: string }>[] = [
    {
      name: "a threshold of 1, which would let one visitor unlist any Listing",
      value: { ...valid, distinctReporterThreshold: 1 },
      message: "Distinct reporter threshold must be between 2 and 100.",
    },
    {
      name: "a threshold of 0",
      value: { ...valid, distinctReporterThreshold: 0 },
      message: "Distinct reporter threshold must be between 2 and 100.",
    },
    {
      name: "a threshold above 100",
      value: { ...valid, distinctReporterThreshold: 101 },
      message: "Distinct reporter threshold must be between 2 and 100.",
    },
    {
      name: "a fractional threshold",
      value: { ...valid, distinctReporterThreshold: 2.5 },
      message: "Distinct reporter threshold must be a whole number.",
    },
    {
      name: "a numeric-string threshold",
      value: { ...valid, distinctReporterThreshold: "3" },
      message: "Distinct reporter threshold must be a whole number.",
    },
    {
      name: "a null threshold",
      value: { ...valid, distinctReporterThreshold: null },
      message: "Distinct reporter threshold must be a whole number.",
    },
    {
      name: "a missing threshold",
      value: { windowDays: 7 },
      message: "Distinct reporter threshold must be a whole number.",
    },
    {
      name: "a window of 0 days",
      value: { ...valid, windowDays: 0 },
      message: "Window in days must be between 1 and 90.",
    },
    {
      name: "a negative window",
      value: { ...valid, windowDays: -7 },
      message: "Window in days must be between 1 and 90.",
    },
    {
      name: "a window above 90 days",
      value: { ...valid, windowDays: 91 },
      message: "Window in days must be between 1 and 90.",
    },
    {
      name: "a fractional window",
      value: { ...valid, windowDays: 0.5 },
      message: "Window in days must be a whole number.",
    },
    {
      name: "a numeric-string window",
      value: { ...valid, windowDays: "7" },
      message: "Window in days must be a whole number.",
    },
    {
      name: "a missing window",
      value: { distinctReporterThreshold: 3 },
      message: "Window in days must be a whole number.",
    },
    {
      name: "a window given in milliseconds under another name",
      value: { ...valid, windowMs: 604_800_000 },
      message: "Listing Report Auto-Unlist Policy does not accept windowMs.",
    },
    {
      name: "an inherited object key",
      value: { ...valid, constructor: 3 },
      message: "Listing Report Auto-Unlist Policy does not accept constructor.",
    },
    { name: "an array", value: [3, 7], message: "Listing Report Auto-Unlist Policy value must be an object." },
    { name: "null", value: null, message: "Listing Report Auto-Unlist Policy value must be an object." },
    { name: "a bare threshold", value: 3, message: "Listing Report Auto-Unlist Policy value must be an object." },
  ];

  it.each(rejected)("rejects $name", ({ value, message }) => {
    const decode = () => decodeMarketplaceListingReportAutoUnlistPolicyValue(value);
    expect(decode).toThrow(MarketplaceListingReportAutoUnlistPolicyError);
    expect(decode).toThrow(message);
  });
});
