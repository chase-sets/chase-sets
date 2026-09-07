import type { ChannelEnvironment, ChannelProviderIdentity } from "@chase-sets/channels";
import {
  isCanonicalMoneyAmount,
  normalizeMoneyAmount,
  normalizeSignedMoneyAmount,
  type MoneyAmount,
  type SignedMoneyAmount,
} from "@chase-sets/primitives/money";
import { canonicalJson } from "./revision";

export const economicsFactNames = [
  "platformFeeRelativeBps",
  "platformFeeFixedPerUnitAmount",
  "platformFeeCapPerUnitAmount",
  "sellerHandlingRelativeBps",
  "sellerHandlingFixedPerUnitAmount",
  "sellerHandlingCapPerUnitAmount",
  "shippingAllowanceBps",
  "costBasisShareOfMarketBps",
  "costBasisCoverageBps",
  "costBasisDiscountPerUnitAmount",
  "turnaroundDays",
  "dailyReturnHurdle",
] as const;

export type EconomicsFactName = (typeof economicsFactNames)[number];

export const defaultReasons = [
  "insufficient-observed-history",
  "provider-unavailable",
  "terms-unavailable",
  "cost-basis-unavailable",
  "non-positive-cost",
  "non-positive-net-proceeds",
  "non-positive-cycle",
] as const;

export type DefaultReason = (typeof defaultReasons)[number];

export type Money = Readonly<{ amount: MoneyAmount; currency: string }>;
export type SignedMoney = Readonly<{ amount: SignedMoneyAmount; currency: string }>;

export type ResolvedChannelConnection = Readonly<{
  connectionId: string;
  providerKey: string;
  environment: ChannelEnvironment;
}>;

export type ResolveEconomicsRequest = Readonly<{
  accountId: string;
  connectionId: string;
  catalogItemId: string;
  inventoryItemId: string;
  marketUnitPrice: Money;
  quantity: number;
  effectiveAt: string;
}>;

export type ResolveEconomicsInput = Omit<ResolveEconomicsRequest, "accountId">;

export interface ChannelConnectionIdentityReader {
  resolve(input: Readonly<{ accountId: string; connectionId: string }>): Promise<ResolvedChannelConnection | null>;
}

export type FactSource =
  | Readonly<{ kind: "commercial-terms"; agreementId: string | null; revision: string }>
  | Readonly<{ kind: "inventory-observation"; revision: string }>
  | Readonly<{ kind: "pricing-observation"; policyRevision: string; sampleCount: number }>
  | Readonly<{ kind: "policy-owned"; policyRevision: string }>
  | Readonly<{ kind: "policy-default"; policyRevision: string; reason: DefaultReason }>;

export type EconomicsFactOverride<T> = Readonly<{
  value: T;
  revision: number;
  setAt: string;
}>;

export type EconomicsFact<T> = Readonly<{
  sourceValue: T;
  source: FactSource;
  effectiveValue: T;
  override: EconomicsFactOverride<T> | null;
  observedAt: string;
}>;

export type EconomicsFactValueMap = Readonly<{
  platformFeeRelativeBps: number;
  platformFeeFixedPerUnitAmount: Money;
  platformFeeCapPerUnitAmount: Money | null;
  sellerHandlingRelativeBps: number;
  sellerHandlingFixedPerUnitAmount: Money;
  sellerHandlingCapPerUnitAmount: Money | null;
  shippingAllowanceBps: number;
  costBasisShareOfMarketBps: number;
  costBasisCoverageBps: number;
  costBasisDiscountPerUnitAmount: SignedMoney;
  turnaroundDays: number;
  dailyReturnHurdle: number;
}>;

export type EconomicsFacts = Readonly<{
  [Name in EconomicsFactName]: EconomicsFact<EconomicsFactValueMap[Name]>;
}>;

export type Economics = Readonly<{
  accountId: string;
  channel: ResolvedChannelConnection;
  currency: string;
  effectiveAt: string;
  revision: string;
  facts: EconomicsFacts;
  diagnostics: Readonly<{
    observedHoldDays: number | null;
    capitalCycleDays: number | null;
    hurdleStatus: "derived" | "defaulted";
    hurdleReason: DefaultReason | null;
  }>;
}>;

export type SourceEconomics =
  | Readonly<{
      kind: "resolved";
      providerIdentity: ChannelProviderIdentity;
      facts: Pick<
        EconomicsFacts,
        | "platformFeeRelativeBps"
        | "platformFeeFixedPerUnitAmount"
        | "platformFeeCapPerUnitAmount"
        | "sellerHandlingRelativeBps"
        | "sellerHandlingFixedPerUnitAmount"
        | "sellerHandlingCapPerUnitAmount"
        | "shippingAllowanceBps"
      >;
    }>
  | Readonly<{
      kind: "unavailable";
      providerIdentity: ChannelProviderIdentity;
      reason: "provider-unavailable" | "terms-unavailable";
    }>;

export interface EconomicsProvider {
  readonly identity: ChannelProviderIdentity;
  resolve(request: ResolveEconomicsRequest): Promise<SourceEconomics>;
}

export interface EconomicsProviderRegistry {
  registerExact(provider: EconomicsProvider): void;
  registerExternalFallback(provider: EconomicsProvider): void;
  resolve(identity: ChannelProviderIdentity): EconomicsProvider;
}

const REQUEST_KEYS = [
  "accountId",
  "catalogItemId",
  "connectionId",
  "effectiveAt",
  "inventoryItemId",
  "marketUnitPrice",
  "quantity",
] as const;

const REQUEST_INPUT_KEYS = [
  "catalogItemId",
  "connectionId",
  "effectiveAt",
  "inventoryItemId",
  "marketUnitPrice",
  "quantity",
] as const;

export function parseResolveEconomicsRequest(raw: unknown): ResolveEconomicsRequest {
  const record = requireClosedRecord(raw, REQUEST_KEYS, "Economics request");
  return {
    accountId: requireNonEmptyString(record.accountId, "accountId"),
    ...parseResolveEconomicsFields(record),
  };
}

export function parseResolveEconomicsInput(raw: unknown): ResolveEconomicsInput {
  return parseResolveEconomicsFields(requireClosedRecord(raw, REQUEST_INPUT_KEYS, "Economics input"));
}

function parseResolveEconomicsFields(
  record: Record<(typeof REQUEST_INPUT_KEYS)[number], unknown>,
): ResolveEconomicsInput {
  return {
    connectionId: requireNonEmptyString(record.connectionId, "connectionId"),
    catalogItemId: requireNonEmptyString(record.catalogItemId, "catalogItemId"),
    inventoryItemId: requireNonEmptyString(record.inventoryItemId, "inventoryItemId"),
    marketUnitPrice: parseMoney(record.marketUnitPrice, "marketUnitPrice"),
    quantity: requirePositiveInteger(record.quantity, "quantity", Number.MAX_SAFE_INTEGER),
    effectiveAt: requireRfc3339Instant(record.effectiveAt, "effectiveAt"),
  };
}

export function parseMoney(raw: unknown, fieldName: string): Money {
  const record = requireClosedRecord(raw, ["amount", "currency"] as const, fieldName);
  const amount = requireNonEmptyString(record.amount, `${fieldName}.amount`);
  if (!isCanonicalMoneyAmount(amount)) {
    throw new EconomicsContractError(`${fieldName}.amount must be canonical non-negative fixed-decimal money.`);
  }
  return { amount: normalizeMoneyAmount(amount), currency: requireCurrency(record.currency, `${fieldName}.currency`) };
}

export function parseSignedMoney(raw: unknown, fieldName: string): SignedMoney {
  const record = requireClosedRecord(raw, ["amount", "currency"] as const, fieldName);
  const amount = requireNonEmptyString(record.amount, `${fieldName}.amount`);
  let normalized: SignedMoneyAmount;
  try {
    normalized = normalizeSignedMoneyAmount(amount);
  } catch {
    throw new EconomicsContractError(`${fieldName}.amount must be canonical signed fixed-decimal money.`);
  }
  if (normalized !== amount) {
    throw new EconomicsContractError(`${fieldName}.amount must be canonical signed fixed-decimal money.`);
  }
  return { amount: normalized, currency: requireCurrency(record.currency, `${fieldName}.currency`) };
}

export function parseFactValue<Name extends EconomicsFactName>(
  factName: Name,
  raw: unknown,
  currency: string,
): EconomicsFactValueMap[Name] {
  const expectedCurrency = requireCurrency(currency, "currency");
  switch (factName) {
    case "platformFeeRelativeBps":
    case "sellerHandlingRelativeBps":
    case "shippingAllowanceBps":
    case "costBasisShareOfMarketBps":
    case "costBasisCoverageBps":
      return requireBasisPoints(raw, factName) as EconomicsFactValueMap[Name];
    case "platformFeeFixedPerUnitAmount":
    case "sellerHandlingFixedPerUnitAmount": {
      const value = parseMoney(raw, factName);
      requireMatchingCurrency(value.currency, expectedCurrency, factName);
      return value as EconomicsFactValueMap[Name];
    }
    case "platformFeeCapPerUnitAmount":
    case "sellerHandlingCapPerUnitAmount": {
      if (raw === null) return null as EconomicsFactValueMap[Name];
      const value = parseMoney(raw, factName);
      requireMatchingCurrency(value.currency, expectedCurrency, factName);
      return value as EconomicsFactValueMap[Name];
    }
    case "costBasisDiscountPerUnitAmount": {
      const value = parseSignedMoney(raw, factName);
      requireMatchingCurrency(value.currency, expectedCurrency, factName);
      return value as EconomicsFactValueMap[Name];
    }
    case "turnaroundDays":
      return requireFiniteNonNegative(raw, factName) as EconomicsFactValueMap[Name];
    case "dailyReturnHurdle":
      return requireFiniteNumber(raw, factName) as EconomicsFactValueMap[Name];
  }
}

export function assertProviderIdentity(identity: ChannelProviderIdentity): void {
  const record = requireClosedRecord(identity, ["environment", "providerKey"] as const, "provider identity");
  const providerKey = requireNonEmptyString(record.providerKey, "providerKey");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(providerKey) || [...providerKey].length > 64) {
    throw new EconomicsContractError("providerKey must be lower-kebab and contain at most 64 Unicode scalars.");
  }
  if (record.environment !== "sandbox" && record.environment !== "production") {
    throw new EconomicsContractError("environment must be sandbox or production.");
  }
}

export function assertFactSourceForName(factName: EconomicsFactName, source: FactSource): void {
  assertClosedFactSource(source);
  const allowed = allowedSourcesByFact[factName];
  if (!allowed.includes(source.kind)) {
    throw new EconomicsContractError(`${factName} cannot use ${source.kind} provenance.`);
  }
  if (source.kind !== "policy-default") return;
  const reasons = allowedDefaultReasonsByFact[factName];
  if (!reasons.includes(source.reason)) {
    throw new EconomicsContractError(`${factName} cannot default for ${source.reason}.`);
  }
}

export function assertEconomicsFacts(facts: EconomicsFacts, currency: string): void {
  requireClosedRecord(facts, economicsFactNames, "Economics facts");
  for (const factName of economicsFactNames) {
    assertEconomicsFact(factName, facts[factName], currency);
  }
  assertCrossFactSourceBindings(facts);
}

export function assertSourceEconomics(source: SourceEconomics, currency: string): void {
  if (source.kind === "unavailable") {
    requireClosedRecord(source, ["kind", "providerIdentity", "reason"] as const, "unavailable source Economics");
    assertProviderIdentity(source.providerIdentity);
    if (source.reason !== "provider-unavailable" && source.reason !== "terms-unavailable") {
      throw new EconomicsContractError("Unknown source Economics unavailable reason.");
    }
    return;
  }
  if (source.kind !== "resolved") throw new EconomicsContractError("Unknown source Economics outcome.");
  requireClosedRecord(source, ["facts", "kind", "providerIdentity"] as const, "resolved source Economics");
  assertProviderIdentity(source.providerIdentity);
  const names = [
    "platformFeeRelativeBps",
    "platformFeeFixedPerUnitAmount",
    "platformFeeCapPerUnitAmount",
    "sellerHandlingRelativeBps",
    "sellerHandlingFixedPerUnitAmount",
    "sellerHandlingCapPerUnitAmount",
    "shippingAllowanceBps",
  ] as const;
  requireClosedRecord(source.facts, names, "source Economics facts");
  for (const name of names) assertEconomicsFact(name, source.facts[name], currency);
  assertSameSourceBinding(
    source.facts,
    ["platformFeeRelativeBps", "platformFeeFixedPerUnitAmount", "platformFeeCapPerUnitAmount", "shippingAllowanceBps"],
    "Commercial Terms",
  );
  assertSamePolicyRevision(source.facts, names.slice(3, 6), "seller handling");
}

export function requireRfc3339Instant(value: unknown, fieldName: string): string {
  const text = requireNonEmptyString(value, fieldName);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new EconomicsContractError(`${fieldName} must be a timezone-bearing RFC3339 instant.`);
  }
  if (!Number.isFinite(Date.parse(text))) {
    throw new EconomicsContractError(`${fieldName} must be a valid instant.`);
  }
  return text;
}

export function requireCurrency(value: unknown, fieldName: string): string {
  const currency = requireNonEmptyString(value, fieldName);
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new EconomicsContractError(`${fieldName} must be a canonical lowercase ISO-style currency code.`);
  }
  return currency;
}

export function requireBasisPoints(value: unknown, fieldName: string): number {
  return requireIntegerInRange(value, fieldName, 0, 10_000);
}

export function requirePositiveInteger(value: unknown, fieldName: string, maximum: number): number {
  return requireIntegerInRange(value, fieldName, 1, maximum);
}

export function requireFiniteNonNegative(value: unknown, fieldName: string): number {
  const number = requireFiniteNumber(value, fieldName);
  if (number < 0) throw new EconomicsContractError(`${fieldName} must be non-negative.`);
  return number;
}

export function requireFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EconomicsContractError(`${fieldName} must be a finite number.`);
  }
  return value;
}

export class EconomicsContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EconomicsContractError";
  }
}

export function requireClosedRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  fieldName: string,
): Record<Keys[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EconomicsContractError(`${fieldName} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set<string>(keys);
  const actualKeys = Object.keys(record);
  const unknown = actualKeys.filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new EconomicsContractError(
      `${fieldName} has an invalid shape (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"}).`,
    );
  }
  return record as Record<Keys[number], unknown>;
}

function assertEconomicsFact<Name extends EconomicsFactName>(factName: Name, raw: unknown, currency: string): void {
  const fact = requireClosedRecord(
    raw,
    ["effectiveValue", "observedAt", "override", "source", "sourceValue"] as const,
    factName,
  );
  const sourceValue = parseFactValue(factName, fact.sourceValue, currency);
  const effectiveValue = parseFactValue(factName, fact.effectiveValue, currency);
  assertFactSourceForName(factName, fact.source as FactSource);
  requireRfc3339Instant(fact.observedAt, `${factName}.observedAt`);
  if (fact.override === null) {
    if (!factValuesEqual(sourceValue, effectiveValue)) {
      throw new EconomicsContractError(`${factName}.effectiveValue must equal sourceValue without an override.`);
    }
    return;
  }
  const override = requireClosedRecord(fact.override, ["revision", "setAt", "value"] as const, `${factName}.override`);
  const overrideValue = parseFactValue(factName, override.value, currency);
  requirePositiveInteger(override.revision, `${factName}.override.revision`, Number.MAX_SAFE_INTEGER);
  requireRfc3339Instant(override.setAt, `${factName}.override.setAt`);
  if (!factValuesEqual(overrideValue, effectiveValue)) {
    throw new EconomicsContractError(`${factName}.effectiveValue must equal its override value.`);
  }
}

function assertCrossFactSourceBindings(facts: EconomicsFacts): void {
  assertSameSourceBinding(
    facts,
    ["platformFeeRelativeBps", "platformFeeFixedPerUnitAmount", "platformFeeCapPerUnitAmount", "shippingAllowanceBps"],
    "Commercial Terms",
  );
  assertSamePolicyRevision(facts, economicsFactNames, "Pricing policy");
  if (
    facts.costBasisShareOfMarketBps.source.kind === "inventory-observation" &&
    facts.costBasisCoverageBps.source.kind === "inventory-observation" &&
    facts.costBasisShareOfMarketBps.source.revision !== facts.costBasisCoverageBps.source.revision
  ) {
    throw new EconomicsContractError("Cost-basis facts must carry one Inventory revision.");
  }
}

function assertSameSourceBinding(
  facts: Partial<EconomicsFacts>,
  names: readonly EconomicsFactName[],
  label: string,
): void {
  const sources = names.map((name) => facts[name]!.source);
  const first = sources[0]!;
  for (const source of sources.slice(1)) {
    if (!factValuesEqual(first, source)) {
      throw new EconomicsContractError(`${label} facts must carry one source binding.`);
    }
  }
}

function assertSamePolicyRevision(
  facts: Partial<EconomicsFacts>,
  names: readonly EconomicsFactName[],
  label: string,
): void {
  const revisions = names
    .map((name) => facts[name]!.source)
    .filter((source): source is Extract<FactSource, { policyRevision: string }> => "policyRevision" in source)
    .map((source) => source.policyRevision);
  if (new Set(revisions).size > 1) {
    throw new EconomicsContractError(`${label} facts must carry one policy revision.`);
  }
}

function factValuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" || typeof right === "number") return Object.is(left, right);
  if (left === null || right === null) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new EconomicsContractError(`${fieldName} must be a non-empty, already-trimmed string.`);
  }
  return value;
}

function requireIntegerInRange(value: unknown, fieldName: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EconomicsContractError(`${fieldName} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requireMatchingCurrency(actual: string, expected: string, fieldName: string): void {
  if (actual !== expected) throw new EconomicsContractError(`${fieldName} currency must match ${expected}.`);
}

function assertClosedFactSource(source: FactSource): void {
  switch (source.kind) {
    case "commercial-terms":
      requireClosedRecord(source, ["agreementId", "kind", "revision"] as const, "commercial-terms source");
      if (source.agreementId !== null) requireNonEmptyString(source.agreementId, "agreementId");
      requireNonEmptyString(source.revision, "revision");
      return;
    case "inventory-observation":
      requireClosedRecord(source, ["kind", "revision"] as const, "inventory-observation source");
      requireNonEmptyString(source.revision, "revision");
      return;
    case "pricing-observation":
      requireClosedRecord(source, ["kind", "policyRevision", "sampleCount"] as const, "pricing-observation source");
      requireNonEmptyString(source.policyRevision, "policyRevision");
      requirePositiveInteger(source.sampleCount, "sampleCount", Number.MAX_SAFE_INTEGER);
      return;
    case "policy-owned":
      requireClosedRecord(source, ["kind", "policyRevision"] as const, "policy-owned source");
      requireNonEmptyString(source.policyRevision, "policyRevision");
      return;
    case "policy-default":
      requireClosedRecord(source, ["kind", "policyRevision", "reason"] as const, "policy-default source");
      requireNonEmptyString(source.policyRevision, "policyRevision");
      if (!defaultReasons.includes(source.reason)) throw new EconomicsContractError("Unknown policy-default reason.");
      return;
    default:
      throw new EconomicsContractError("Unknown fact source kind.");
  }
}

const allowedSourcesByFact: Readonly<Record<EconomicsFactName, readonly FactSource["kind"][]>> = {
  platformFeeRelativeBps: ["commercial-terms", "policy-default"],
  platformFeeFixedPerUnitAmount: ["commercial-terms", "policy-default"],
  platformFeeCapPerUnitAmount: ["commercial-terms", "policy-default"],
  sellerHandlingRelativeBps: ["policy-owned"],
  sellerHandlingFixedPerUnitAmount: ["policy-owned"],
  sellerHandlingCapPerUnitAmount: ["policy-owned"],
  shippingAllowanceBps: ["commercial-terms", "policy-default"],
  costBasisShareOfMarketBps: ["inventory-observation", "policy-default"],
  costBasisCoverageBps: ["inventory-observation"],
  costBasisDiscountPerUnitAmount: ["policy-owned"],
  turnaroundDays: ["pricing-observation", "policy-default"],
  dailyReturnHurdle: ["pricing-observation", "policy-default"],
};

const allowedDefaultReasonsByFact: Readonly<Record<EconomicsFactName, readonly DefaultReason[]>> = {
  platformFeeRelativeBps: ["provider-unavailable", "terms-unavailable"],
  platformFeeFixedPerUnitAmount: ["provider-unavailable", "terms-unavailable"],
  platformFeeCapPerUnitAmount: ["provider-unavailable", "terms-unavailable"],
  sellerHandlingRelativeBps: [],
  sellerHandlingFixedPerUnitAmount: [],
  sellerHandlingCapPerUnitAmount: [],
  shippingAllowanceBps: ["provider-unavailable", "terms-unavailable"],
  costBasisShareOfMarketBps: ["cost-basis-unavailable"],
  costBasisCoverageBps: [],
  costBasisDiscountPerUnitAmount: [],
  turnaroundDays: ["insufficient-observed-history"],
  dailyReturnHurdle: defaultReasons,
};
