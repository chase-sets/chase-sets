export type TaxJurisdictionCode =
  | "AL"
  | "AK"
  | "AZ"
  | "AR"
  | "CA"
  | "CO"
  | "CT"
  | "DC"
  | "DE"
  | "FL"
  | "GA"
  | "HI"
  | "ID"
  | "IL"
  | "IN"
  | "IA"
  | "KS"
  | "KY"
  | "LA"
  | "ME"
  | "MD"
  | "MA"
  | "MI"
  | "MN"
  | "MS"
  | "MO"
  | "MT"
  | "NE"
  | "NV"
  | "NH"
  | "NJ"
  | "NM"
  | "NY"
  | "NC"
  | "ND"
  | "OH"
  | "OK"
  | "OR"
  | "PA"
  | "RI"
  | "SC"
  | "SD"
  | "TN"
  | "TX"
  | "UT"
  | "VT"
  | "VA"
  | "WA"
  | "WV"
  | "WI"
  | "WY";

export type TaxRegistrationStatus = "not-registered" | "preparing" | "registered";
export type TaxCollectionStatus = "not-collecting" | "collecting";

export type TaxNexusRequirementStatus =
  | "not-applicable"
  | "monitoring"
  | "approaching-threshold"
  | "prepare-registration"
  | "registration-required"
  | "collection-required"
  | "collecting"
  | "manual-review";

export type TaxNexusThresholdPolicy = Readonly<{
  jurisdictionCode: TaxJurisdictionCode;
  jurisdictionName: string;
  salesThresholdAmount: string | null;
  transactionThreshold: number | null;
  reviewRequired: boolean;
  notes: readonly string[];
}>;

export type TaxNexusJurisdictionActivity = Readonly<{
  jurisdictionCode: TaxJurisdictionCode;
  currentYearGrossSalesAmount: string;
  previousYearGrossSalesAmount: string;
  currentYearTransactionCount: number;
  previousYearTransactionCount: number;
  registrationStatus: TaxRegistrationStatus;
  collectionStatus: TaxCollectionStatus;
  providerBackedQuotesReady?: boolean;
}>;

export type TaxNexusJurisdictionReadiness = Readonly<{
  jurisdictionCode: TaxJurisdictionCode;
  jurisdictionName: string;
  status: TaxNexusRequirementStatus;
  thresholdBasis: "sales" | "transactions" | "not-applicable" | "manual-review";
  salesThresholdAmount: string | null;
  transactionThreshold: number | null;
  currentYearGrossSalesAmount: string;
  previousYearGrossSalesAmount: string;
  currentYearTransactionCount: number;
  previousYearTransactionCount: number;
  thresholdProgressRatio: number | null;
  registrationStatus: TaxRegistrationStatus;
  collectionStatus: TaxCollectionStatus;
  providerBackedQuotesReady: boolean;
  providerBackedQuotesRequired: boolean;
  notes: readonly string[];
}>;

export type TaxNexusReadinessReport = Readonly<{
  asOf: string;
  providerBackedQuotesRequired: boolean;
  providerBackedQuotesMissing: boolean;
  collectionRequiredJurisdictions: readonly TaxJurisdictionCode[];
  registrationRequiredJurisdictions: readonly TaxJurisdictionCode[];
  preparationJurisdictions: readonly TaxJurisdictionCode[];
  manualReviewJurisdictions: readonly TaxJurisdictionCode[];
  jurisdictions: readonly TaxNexusJurisdictionReadiness[];
}>;

const stateNames: Readonly<Record<TaxJurisdictionCode, string>> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DC: "District of Columbia",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

const noStatewideSalesTaxJurisdictions = new Set<TaxJurisdictionCode>(["DE", "MT", "NH", "OR"]);
const manualReviewJurisdictions = new Set<TaxJurisdictionCode>(["AK", "CO", "LA"]);

const allJurisdictionCodes = Object.keys(stateNames) as TaxJurisdictionCode[];

export const defaultTaxNexusThresholdPolicies: readonly TaxNexusThresholdPolicy[] = allJurisdictionCodes.map(
  (jurisdictionCode) => {
    const noStatewideSalesTax = noStatewideSalesTaxJurisdictions.has(jurisdictionCode);
    const manualReview = manualReviewJurisdictions.has(jurisdictionCode);

    return {
      jurisdictionCode,
      jurisdictionName: stateNames[jurisdictionCode],
      salesThresholdAmount: noStatewideSalesTax ? null : "100000.00",
      transactionThreshold: null,
      reviewRequired: manualReview,
      notes: [
        ...(noStatewideSalesTax ? ["No statewide sales tax; local or special marketplace rules may still apply."] : []),
        ...(manualReview
          ? ["Manual review required before launch or threshold reliance because local administration is complex."]
          : []),
        ...(!noStatewideSalesTax && !manualReview
          ? ["Conservative launch threshold; counsel/accounting should replace with reviewed jurisdiction policy."]
          : []),
      ],
    };
  },
);

function normalizeMoneyAmount(value: string, fieldName: string) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`${fieldName} must be a non-negative money amount.`);
  }

  return Number.parseFloat(normalized).toFixed(2);
}

function normalizeTransactionCount(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }

  return value;
}

function moneyRatio(numerator: string, denominator: string | null) {
  if (!denominator) {
    return null;
  }
  const basis = Number.parseFloat(denominator);
  if (basis <= 0) {
    return null;
  }

  return Number.parseFloat(numerator) / basis;
}

function transactionRatio(count: number, threshold: number | null) {
  if (!threshold || threshold <= 0) {
    return null;
  }

  return count / threshold;
}

function maxRatio(...ratios: readonly (number | null)[]) {
  const finite = ratios.filter((ratio): ratio is number => Number.isFinite(ratio));
  return finite.length > 0 ? Math.max(...finite) : null;
}

function thresholdBasis(
  policy: TaxNexusThresholdPolicy,
  salesRatio: number | null,
  transactionProgressRatio: number | null,
): TaxNexusJurisdictionReadiness["thresholdBasis"] {
  if (policy.reviewRequired) {
    return "manual-review";
  }
  if (!policy.salesThresholdAmount && !policy.transactionThreshold) {
    return "not-applicable";
  }
  if ((transactionProgressRatio ?? 0) > (salesRatio ?? 0)) {
    return "transactions";
  }

  return "sales";
}

function statusFor(
  params: Readonly<{
    policy: TaxNexusThresholdPolicy;
    progressRatio: number | null;
    registrationStatus: TaxRegistrationStatus;
    collectionStatus: TaxCollectionStatus;
  }>,
): TaxNexusRequirementStatus {
  if (params.collectionStatus === "collecting") {
    return "collecting";
  }
  if (params.policy.reviewRequired) {
    return "manual-review";
  }
  if (!params.policy.salesThresholdAmount && !params.policy.transactionThreshold) {
    return "not-applicable";
  }
  if ((params.progressRatio ?? 0) >= 1 && params.registrationStatus === "registered") {
    return "collection-required";
  }
  if ((params.progressRatio ?? 0) >= 1) {
    return "registration-required";
  }
  if ((params.progressRatio ?? 0) >= 0.95 || params.registrationStatus === "preparing") {
    return "prepare-registration";
  }
  if ((params.progressRatio ?? 0) >= 0.8) {
    return "approaching-threshold";
  }

  return "monitoring";
}

export function createEmptyTaxNexusActivity(jurisdictionCode: TaxJurisdictionCode): TaxNexusJurisdictionActivity {
  return {
    jurisdictionCode,
    currentYearGrossSalesAmount: "0.00",
    previousYearGrossSalesAmount: "0.00",
    currentYearTransactionCount: 0,
    previousYearTransactionCount: 0,
    registrationStatus: "not-registered",
    collectionStatus: "not-collecting",
    providerBackedQuotesReady: false,
  };
}

export function evaluateTaxNexusReadiness(
  activity: readonly TaxNexusJurisdictionActivity[],
  options: Readonly<{
    asOf?: string;
    policies?: readonly TaxNexusThresholdPolicy[];
  }> = {},
): TaxNexusReadinessReport {
  const policies = options.policies ?? defaultTaxNexusThresholdPolicies;
  const activityByJurisdiction = new Map(activity.map((row) => [row.jurisdictionCode, row]));

  const jurisdictions = policies.map<TaxNexusJurisdictionReadiness>((policy) => {
    const row =
      activityByJurisdiction.get(policy.jurisdictionCode) ?? createEmptyTaxNexusActivity(policy.jurisdictionCode);
    const currentYearGrossSalesAmount = normalizeMoneyAmount(
      row.currentYearGrossSalesAmount,
      "Current year gross sales",
    );
    const previousYearGrossSalesAmount = normalizeMoneyAmount(
      row.previousYearGrossSalesAmount,
      "Previous year gross sales",
    );
    const currentYearTransactionCount = normalizeTransactionCount(
      row.currentYearTransactionCount,
      "Current year transaction count",
    );
    const previousYearTransactionCount = normalizeTransactionCount(
      row.previousYearTransactionCount,
      "Previous year transaction count",
    );
    const salesProgressRatio = maxRatio(
      moneyRatio(currentYearGrossSalesAmount, policy.salesThresholdAmount),
      moneyRatio(previousYearGrossSalesAmount, policy.salesThresholdAmount),
    );
    const transactionProgressRatio = maxRatio(
      transactionRatio(currentYearTransactionCount, policy.transactionThreshold),
      transactionRatio(previousYearTransactionCount, policy.transactionThreshold),
    );
    const thresholdProgressRatio = maxRatio(salesProgressRatio, transactionProgressRatio);
    const status = statusFor({
      policy,
      progressRatio: thresholdProgressRatio,
      registrationStatus: row.registrationStatus,
      collectionStatus: row.collectionStatus,
    });
    const providerBackedQuotesRequired = status === "collection-required" || status === "collecting";

    return {
      jurisdictionCode: policy.jurisdictionCode,
      jurisdictionName: policy.jurisdictionName,
      status,
      thresholdBasis: thresholdBasis(policy, salesProgressRatio, transactionProgressRatio),
      salesThresholdAmount: policy.salesThresholdAmount,
      transactionThreshold: policy.transactionThreshold,
      currentYearGrossSalesAmount,
      previousYearGrossSalesAmount,
      currentYearTransactionCount,
      previousYearTransactionCount,
      thresholdProgressRatio,
      registrationStatus: row.registrationStatus,
      collectionStatus: row.collectionStatus,
      providerBackedQuotesReady: Boolean(row.providerBackedQuotesReady),
      providerBackedQuotesRequired,
      notes: policy.notes,
    };
  });

  return {
    asOf: options.asOf ?? new Date().toISOString(),
    providerBackedQuotesRequired: jurisdictions.some((row) => row.providerBackedQuotesRequired),
    providerBackedQuotesMissing: jurisdictions.some(
      (row) => row.providerBackedQuotesRequired && !row.providerBackedQuotesReady,
    ),
    collectionRequiredJurisdictions: jurisdictions
      .filter((row) => row.status === "collection-required" || row.status === "collecting")
      .map((row) => row.jurisdictionCode),
    registrationRequiredJurisdictions: jurisdictions
      .filter((row) => row.status === "registration-required")
      .map((row) => row.jurisdictionCode),
    preparationJurisdictions: jurisdictions
      .filter((row) => row.status === "approaching-threshold" || row.status === "prepare-registration")
      .map((row) => row.jurisdictionCode),
    manualReviewJurisdictions: jurisdictions
      .filter((row) => row.status === "manual-review")
      .map((row) => row.jurisdictionCode),
    jurisdictions,
  };
}
