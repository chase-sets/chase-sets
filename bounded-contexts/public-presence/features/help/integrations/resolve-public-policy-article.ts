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
type ExpectedPublicPolicyValue = Readonly<{
  type: PublicPolicyValueType;
  currency?: string;
}>;

const unavailablePolicyValues: PublicPolicyValuesResponse = {
  values: {},
  resolvedAt: "1970-01-01T00:00:00.000Z",
  propagationSeconds: 0,
  changeCalloutDays: 0,
};

const expectedPublicPolicyValues = new Map<string, ExpectedPublicPolicyValue>();
for (const permission of publicPolicyValueWhitelist) {
  if (!isPublicPolicyValueType(permission.type)) continue;
  const currency =
    "currency" in permission && typeof permission.currency === "string" ? permission.currency : undefined;
  expectedPublicPolicyValues.set(permission.key, {
    type: permission.type,
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
    const value = expected ? validatePublicPolicyValue(response.values[key], expected) : null;
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

function validatePublicPolicyValue(value: unknown, expected: ExpectedPublicPolicyValue): PublicPolicyValue | null {
  if (
    !isRecord(value) ||
    value.type !== expected.type ||
    !isNullableTimestamp(value.effectiveFrom) ||
    !Array.isArray(value.upcoming) ||
    !isScalar(value.value) ||
    !isValidPolicyPayload(value.value, expected.type)
  ) {
    return null;
  }

  if (expected.type === "money") {
    if (!expected.currency || value.currency !== expected.currency) return null;
  } else if (value.currency !== undefined) {
    return null;
  }

  const upcoming: { value: string | number; effectiveFrom: string }[] = [];
  for (const candidate of value.upcoming) {
    if (
      !isRecord(candidate) ||
      !isTimestamp(candidate.effectiveFrom) ||
      !isScalar(candidate.value) ||
      !isValidPolicyPayload(candidate.value, expected.type)
    ) {
      return null;
    }
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
    isRecord(value.values) &&
    isTimestamp(value.resolvedAt) &&
    isNonNegativeSafeInteger(value.propagationSeconds) &&
    isNonNegativeSafeInteger(value.changeCalloutDays)
  );
}

function isValidPolicyPayload(value: string | number, type: PublicPolicyValueType): boolean {
  if (type === "money") {
    if (typeof value === "string" && !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return false;
    const numeric = toFiniteNumber(value);
    if (numeric === null || numeric < 0) return false;
    const cents = numeric * 100;
    const roundedCents = Math.round(cents);
    return Number.isSafeInteger(roundedCents) && Math.abs(cents - roundedCents) < 1e-8;
  }

  const numeric = toFiniteNumber(value);
  if (numeric === null || !Number.isSafeInteger(numeric) || numeric < 0) return false;
  return type !== "bps" || numeric <= 10_000;
}

function toFiniteNumber(value: string | number): number | null {
  if (typeof value === "string" && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

function isScalar(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
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
