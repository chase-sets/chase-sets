import type { PublicPolicyValue, PublicPolicyValuesResponse } from "../api/public-policy-values";
import type { HelpArticle } from "../domain/article-model";
import { publicPolicyValueWhitelist } from "../domain/public-policy-value-whitelist.mjs";
import { resolveArticlePolicyValues } from "../domain/resolve-article-policy-values";
import {
  loadPublicPolicyValues,
  PublicPolicyValuesRequestError,
  type PublicPolicyValuesFailureClassification,
} from "./public-policy-values-client";

type PublicPolicyValueType = PublicPolicyValue["type"];
type UnavailableClassification = PublicPolicyValuesFailureClassification | "missing";
type PublicPolicyScalarContract =
  | Readonly<{ primitive: "integer"; minimum: number; maximum: number }>
  | Readonly<{ primitive: "money"; minimumCents: number }>;
type ExpectedPublicPolicyValue = Readonly<{
  type: PublicPolicyValueType;
  currency?: string;
  valueContract: PublicPolicyScalarContract;
}>;

const unavailablePolicyValues: PublicPolicyValuesResponse = {
  values: {},
  resolvedAt: "1970-01-01T00:00:00.000Z",
  propagationSeconds: 0,
  changeCalloutDays: 0,
};

const expectedPublicPolicyValues = new Map<string, ExpectedPublicPolicyValue>();
for (const permission of publicPolicyValueWhitelist) {
  if (!isPublicPolicyValueType(permission.type) || !isPublicPolicyScalarContract(permission.valueContract)) continue;
  const currency =
    "currency" in permission && typeof permission.currency === "string" ? permission.currency : undefined;
  expectedPublicPolicyValues.set(permission.key, {
    type: permission.type,
    valueContract: permission.valueContract,
    ...(currency ? { currency } : {}),
  });
}

export async function resolvePublicPolicyArticle(
  request: Request,
  article: HelpArticle,
  route: string,
): Promise<HelpArticle> {
  let loadedPolicyValues: PublicPolicyValuesResponse;
  try {
    loadedPolicyValues = await loadPublicPolicyValues(request);
  } catch (error) {
    const failure = classifyRequestFailure(error);
    const unresolvedKeys = uniqueSorted(article.policyValueKeys);
    logUnavailablePolicyValues(route, unresolvedKeys, failure.classification, failure.status);
    return renderUnavailablePolicyValues(article, unresolvedKeys);
  }

  const validation = validateReferencedPolicyValues(loadedPolicyValues, article.policyValueKeys);
  if (validation.unresolvedKeys.length > 0) {
    const degradedArticle = resolveArticlePolicyValues(article, validation.policyValues, {
      unavailableKeys: validation.unresolvedKeys,
    });
    logUnavailablePolicyValues(route, validation.unresolvedKeys, validation.classification);
    return degradedArticle;
  }

  return resolveArticlePolicyValues(article, validation.policyValues);
}

function validateReferencedPolicyValues(
  response: unknown,
  referencedKeys: readonly string[],
): Readonly<{
  policyValues: PublicPolicyValuesResponse;
  unresolvedKeys: readonly string[];
  classification: "missing" | "malformed";
}> {
  const keys = uniqueSorted(referencedKeys);
  if (!isValidResponseEnvelope(response)) {
    return {
      policyValues: unavailablePolicyValues,
      unresolvedKeys: keys,
      classification: "malformed",
    };
  }

  const values: Record<string, PublicPolicyValue> = {};
  const missingKeys: string[] = [];
  const malformedKeys: string[] = [];
  for (const key of keys) {
    if (!Object.hasOwn(response.values, key)) {
      missingKeys.push(key);
      continue;
    }

    const expected = expectedPublicPolicyValues.get(key);
    const value = expected ? validatePublicPolicyValue(response.values[key], expected, response.resolvedAt) : null;
    if (!value) {
      malformedKeys.push(key);
      continue;
    }
    values[key] = value;
  }

  return {
    policyValues: {
      values,
      resolvedAt: response.resolvedAt,
      propagationSeconds: response.propagationSeconds,
      changeCalloutDays: response.changeCalloutDays,
    },
    unresolvedKeys: [...missingKeys, ...malformedKeys].sort(),
    classification: malformedKeys.length > 0 ? "malformed" : "missing",
  };
}

function validatePublicPolicyValue(
  value: unknown,
  expected: ExpectedPublicPolicyValue,
  resolvedAt: string,
): PublicPolicyValue | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      expected.type === "money"
        ? ["type", "value", "currency", "effectiveFrom", "upcoming"]
        : ["type", "value", "effectiveFrom", "upcoming"],
    ) ||
    value.type !== expected.type ||
    !isNullableTimestamp(value.effectiveFrom) ||
    !Array.isArray(value.upcoming) ||
    !isValidPolicyPayload(value.value, expected.valueContract)
  ) {
    return null;
  }

  const resolvedAtMs = parseRfc3339Timestamp(resolvedAt);
  const effectiveFromMs = value.effectiveFrom === null ? null : parseRfc3339Timestamp(value.effectiveFrom);
  if (resolvedAtMs === null || (effectiveFromMs !== null && effectiveFromMs > resolvedAtMs)) return null;

  if (expected.type === "money") {
    if (!expected.currency || value.currency !== expected.currency) return null;
  } else if (value.currency !== undefined) {
    return null;
  }

  const upcoming: { value: string | number; effectiveFrom: string }[] = [];
  let previousUpcomingAt = resolvedAtMs;
  for (const candidate of value.upcoming) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["value", "effectiveFrom"]) ||
      !isTimestamp(candidate.effectiveFrom) ||
      !isValidPolicyPayload(candidate.value, expected.valueContract)
    ) {
      return null;
    }
    const upcomingAt = parseRfc3339Timestamp(candidate.effectiveFrom);
    if (upcomingAt === null || upcomingAt <= previousUpcomingAt) return null;
    previousUpcomingAt = upcomingAt;
    upcoming.push({ value: candidate.value, effectiveFrom: candidate.effectiveFrom });
  }

  return {
    type: expected.type,
    value: value.value,
    ...(expected.currency ? { currency: expected.currency } : {}),
    effectiveFrom: value.effectiveFrom,
    upcoming,
  };
}

function isValidResponseEnvelope(value: unknown): value is Readonly<{
  values: Readonly<Record<string, unknown>>;
  resolvedAt: string;
  propagationSeconds: number;
  changeCalloutDays: number;
}> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["values", "resolvedAt", "propagationSeconds", "changeCalloutDays"]) &&
    isRecord(value.values) &&
    isTimestamp(value.resolvedAt) &&
    isNonNegativeSafeInteger(value.propagationSeconds) &&
    isNonNegativeSafeInteger(value.changeCalloutDays)
  );
}

function isValidPolicyPayload(value: unknown, contract: PublicPolicyScalarContract): value is string | number {
  if (contract.primitive === "money") {
    if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) return false;
    const [whole = "0", fraction = "00"] = value.split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction);
    return cents >= BigInt(contract.minimumCents) && cents <= BigInt(Number.MAX_SAFE_INTEGER);
  }

  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= contract.minimum && value <= contract.maximum
  );
}

function classifyRequestFailure(error: unknown): Readonly<{
  classification: PublicPolicyValuesFailureClassification;
  status?: number;
}> {
  if (error instanceof PublicPolicyValuesRequestError) {
    return {
      classification: error.classification,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { classification: "transport" };
}

function renderUnavailablePolicyValues(article: HelpArticle, unresolvedKeys: readonly string[]): HelpArticle {
  return resolveArticlePolicyValues(article, unavailablePolicyValues, { unavailableKeys: unresolvedKeys });
}

function logUnavailablePolicyValues(
  route: string,
  unresolvedKeys: readonly string[],
  classification: UnavailableClassification,
  status?: number,
) {
  console.error("[public-presence] Public policy values are unavailable.", {
    event: "public-policy-values.unavailable",
    route,
    unresolvedKeys: uniqueSorted(unresolvedKeys),
    classification,
    ...(status === undefined ? {} : { status }),
  });
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseRfc3339Timestamp(value) !== null;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPublicPolicyValueType(value: unknown): value is PublicPolicyValueType {
  return (
    value === "bps" ||
    value === "money" ||
    value === "days" ||
    value === "hours" ||
    value === "minutes" ||
    value === "number"
  );
}

function isPublicPolicyScalarContract(value: unknown): value is PublicPolicyScalarContract {
  if (!isRecord(value)) return false;
  if (value.primitive === "money") {
    return hasOnlyKeys(value, ["primitive", "minimumCents"]) && isNonNegativeSafeInteger(value.minimumCents);
  }
  return (
    value.primitive === "integer" &&
    hasOnlyKeys(value, ["primitive", "minimum", "maximum"]) &&
    typeof value.minimum === "number" &&
    typeof value.maximum === "number" &&
    Number.isSafeInteger(value.minimum) &&
    Number.isSafeInteger(value.maximum) &&
    value.minimum <= value.maximum
  );
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function parseRfc3339Timestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
