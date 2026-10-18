import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";

export type FeatureFlagDefinition = Readonly<{
  key: string;
  fallbackValue: boolean;
}>;

export type FeatureFlagEnvironmentState = Readonly<{
  enabled: boolean;
  accountAllowlist: readonly string[];
  badgeAnyOf: readonly string[];
  percentageBasisPoints: number;
  defaultValue: boolean;
}>;

export type FeatureFlagDocument = Readonly<{
  schemaVersion: 1;
  description: string;
  owner: string;
  removalCondition: string;
  environments: Readonly<{
    staging: FeatureFlagEnvironmentState;
    production: FeatureFlagEnvironmentState;
  }>;
}>;

export type FeatureFlagReadResult =
  | Readonly<{
      status: "found";
      documentId: string;
      updatedAt: IsoUtcTimestamp;
      schemaVersion: 1;
      environment: "staging" | "production";
      value: FeatureFlagEnvironmentState;
    }>
  | Readonly<{ status: "not-found" }>
  | Readonly<{
      status: "malformed";
      documentId: string;
      errorCode: "invalid-document";
    }>
  | Readonly<{ status: "unavailable"; errorCode: "store-unavailable" }>;

export type FeatureFlagDocumentReader = Readonly<{
  read: (definition: FeatureFlagDefinition, environment: "staging" | "production") => Promise<FeatureFlagReadResult>;
}>;

const INVALID_CONTRACT_VALUE = "Invalid feature flag contract value.";
const DEFINITION_KEYS = ["key", "fallbackValue"] as const;
const ENVIRONMENT_STATE_KEYS = [
  "enabled",
  "accountAllowlist",
  "badgeAnyOf",
  "percentageBasisPoints",
  "defaultValue",
] as const;
const DOCUMENT_KEYS = ["schemaVersion", "description", "owner", "removalCondition", "environments"] as const;
const READ_FOUND_KEYS = ["status", "documentId", "updatedAt", "schemaVersion", "environment", "value"] as const;
const READ_NOT_FOUND_KEYS = ["status"] as const;
const READ_MALFORMED_KEYS = ["status", "documentId", "errorCode"] as const;
const READ_UNAVAILABLE_KEYS = ["status", "errorCode"] as const;
const ENVIRONMENTS_KEYS = ["staging", "production"] as const;
const FEATURE_FLAG_KEY_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const BADGE_RE = /^[a-z][a-z0-9-]{0,63}$/;

type ContractRecord = Record<string, unknown>;

export function decodeFeatureFlagDefinition(raw: unknown): FeatureFlagDefinition {
  try {
    const value = recordWithExactKeys(raw, DEFINITION_KEYS);
    if (
      typeof value.key !== "string" ||
      value.key.trim() !== value.key ||
      value.key.length < 3 ||
      value.key.length > 128 ||
      !FEATURE_FLAG_KEY_RE.test(value.key) ||
      typeof value.fallbackValue !== "boolean"
    ) {
      return invalid();
    }

    return { key: value.key, fallbackValue: value.fallbackValue };
  } catch {
    return invalid();
  }
}

export function decodeFeatureFlagEnvironmentState(raw: unknown): FeatureFlagEnvironmentState {
  try {
    const value = recordWithExactKeys(raw, ENVIRONMENT_STATE_KEYS);
    const percentageBasisPoints = value.percentageBasisPoints;
    const accountAllowlist = boundedSortedUniqueStrings(value.accountAllowlist, 1_000, (item) => {
      parseStrictTypedUlid(item, "acc");
    });
    const badgeAnyOf = boundedSortedUniqueStrings(value.badgeAnyOf, 64, (item) => {
      if (!BADGE_RE.test(item)) invalid();
    });

    if (
      typeof value.enabled !== "boolean" ||
      typeof value.defaultValue !== "boolean" ||
      typeof percentageBasisPoints !== "number" ||
      !Number.isInteger(percentageBasisPoints) ||
      percentageBasisPoints < 0 ||
      percentageBasisPoints > 10_000 ||
      accountAllowlist === null ||
      badgeAnyOf === null
    ) {
      return invalid();
    }

    return {
      enabled: value.enabled,
      accountAllowlist: [...accountAllowlist],
      badgeAnyOf: [...badgeAnyOf],
      percentageBasisPoints,
      defaultValue: value.defaultValue,
    };
  } catch {
    return invalid();
  }
}

export function decodeFeatureFlagDocument(raw: unknown): FeatureFlagDocument {
  try {
    const value = recordWithExactKeys(raw, DOCUMENT_KEYS);
    const environments = recordWithExactKeys(value.environments, ENVIRONMENTS_KEYS);
    if (
      value.schemaVersion !== 1 ||
      !boundedTrimmedString(value.description, 1, 500) ||
      !boundedTrimmedString(value.owner, 1, 200) ||
      !boundedTrimmedString(value.removalCondition, 1, 1_000)
    ) {
      return invalid();
    }

    const staging = decodeFeatureFlagEnvironmentState(environments.staging);
    const production = decodeFeatureFlagEnvironmentState(environments.production);

    return {
      schemaVersion: 1,
      description: value.description as string,
      owner: value.owner as string,
      removalCondition: value.removalCondition as string,
      environments: { staging, production },
    };
  } catch {
    return invalid();
  }
}

export function decodeFeatureFlagReadResult(raw: unknown): FeatureFlagReadResult {
  try {
    const value = record(raw);
    if (typeof value.status !== "string") return invalid();

    switch (value.status) {
      case "found": {
        const found = recordWithExactKeys(value, READ_FOUND_KEYS);
        if (
          typeof found.documentId !== "string" ||
          typeof found.updatedAt !== "string" ||
          found.schemaVersion !== 1 ||
          (found.environment !== "staging" && found.environment !== "production")
        ) {
          return invalid();
        }

        let updatedAt: IsoUtcTimestamp;
        try {
          updatedAt = parseIsoUtcTimestamp(found.updatedAt);
        } catch {
          return invalid();
        }

        return {
          status: "found",
          documentId: found.documentId,
          updatedAt,
          schemaVersion: 1,
          environment: found.environment,
          value: decodeFeatureFlagEnvironmentState(found.value),
        };
      }
      case "not-found":
        recordWithExactKeys(value, READ_NOT_FOUND_KEYS);
        return { status: "not-found" };
      case "malformed": {
        const malformed = recordWithExactKeys(value, READ_MALFORMED_KEYS);
        if (typeof malformed.documentId !== "string" || malformed.errorCode !== "invalid-document") {
          return invalid();
        }
        return { status: "malformed", documentId: malformed.documentId, errorCode: "invalid-document" };
      }
      case "unavailable": {
        const unavailable = recordWithExactKeys(value, READ_UNAVAILABLE_KEYS);
        if (unavailable.errorCode !== "store-unavailable") return invalid();
        return { status: "unavailable", errorCode: "store-unavailable" };
      }
      default:
        return invalid();
    }
  } catch {
    return invalid();
  }
}

function record(raw: unknown): ContractRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalid();
  const snapshot: ContractRecord = {};
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !("value" in descriptor)) return invalid();
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return snapshot;
}

function recordWithExactKeys<const TKeys extends readonly string[]>(raw: unknown, expectedKeys: TKeys): ContractRecord {
  const value = record(raw);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return invalid();
  }
  const snapshot: ContractRecord = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return invalid();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function boundedTrimmedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length >= minimum && value.length <= maximum;
}

function boundedSortedUniqueStrings(
  value: unknown,
  maximum: number,
  validateItem: (item: string) => void,
): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return null;
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > maximum) return null;

  const copied: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) return null;
    copied.push(descriptor.value as string);
  }

  let previous: string | undefined;
  for (const item of copied) {
    if (typeof item !== "string") return null;
    try {
      validateItem(item);
    } catch {
      return null;
    }
    if (previous !== undefined && previous >= item) return null;
    previous = item;
  }

  return copied;
}

function invalid(): never {
  throw new TypeError(INVALID_CONTRACT_VALUE);
}
