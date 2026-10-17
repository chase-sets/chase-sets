import { describe, expect, expectTypeOf, it } from "vitest";
import {
  decodeFeatureFlagDefinition,
  decodeFeatureFlagDocument,
  decodeFeatureFlagEnvironmentState,
  decodeFeatureFlagReadResult,
} from "@chase-sets/platform-runtime/feature-flags/contract";
import type {
  FeatureFlagDefinition,
  FeatureFlagDocument,
  FeatureFlagDocumentReader,
  FeatureFlagEnvironmentState,
  FeatureFlagReadResult,
} from "@chase-sets/platform-runtime/feature-flags/contract";

const INVALID = "Invalid feature flag contract value.";
const accountA = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const accountB = "acc_01ARZ3NDEKTSV4RRFFQ69G5FB0";

function environmentState(overrides: Partial<FeatureFlagEnvironmentState> = {}): FeatureFlagEnvironmentState {
  return {
    enabled: true,
    accountAllowlist: [],
    badgeAnyOf: [],
    percentageBasisPoints: 2500,
    defaultValue: false,
    ...overrides,
  };
}

function documentValue(overrides: Partial<FeatureFlagDocument> = {}): FeatureFlagDocument {
  return {
    schemaVersion: 1,
    description: "Enable the new catalog view",
    owner: "catalog-team",
    removalCondition: "Remove after the new view is the only supported view.",
    environments: {
      staging: environmentState(),
      production: environmentState({ enabled: false }),
    },
    ...overrides,
  };
}

describe("feature flag contract signatures", () => {
  it("publishes exact decoder and reader signatures", () => {
    expectTypeOf<typeof decodeFeatureFlagDefinition>().toEqualTypeOf<(raw: unknown) => FeatureFlagDefinition>();
    expectTypeOf<typeof decodeFeatureFlagDocument>().toEqualTypeOf<(raw: unknown) => FeatureFlagDocument>();
    expectTypeOf<typeof decodeFeatureFlagEnvironmentState>().toEqualTypeOf<
      (raw: unknown) => FeatureFlagEnvironmentState
    >();
    expectTypeOf<typeof decodeFeatureFlagReadResult>().toEqualTypeOf<(raw: unknown) => FeatureFlagReadResult>();
    expectTypeOf<FeatureFlagDocumentReader["read"]>().toEqualTypeOf<
      (definition: FeatureFlagDefinition, environment: "staging" | "production") => Promise<FeatureFlagReadResult>
    >();
  });
});

describe("decodeFeatureFlagDefinition", () => {
  it("accepts the canonical key grammar and detaches the result", () => {
    const raw = { key: "catalog.new-view", fallbackValue: true };
    const decoded = decodeFeatureFlagDefinition(raw);

    expect(decoded).toEqual(raw);
    expect(decoded).not.toBe(raw);
  });

  it("rejects invalid, padded, bounded, and extra-key definitions", () => {
    const invalidValues: unknown[] = [
      null,
      [],
      { key: "ab", fallbackValue: true },
      { key: "catalog", fallbackValue: true },
      { key: "catalog.New-view", fallbackValue: true },
      { key: " catalog.new-view", fallbackValue: true },
      { key: "catalog.new-view ", fallbackValue: true },
      { key: "a".repeat(127) + ".b", fallbackValue: true },
      { key: "catalog.new-view", fallbackValue: "true" },
      { key: "catalog.new-view", fallbackValue: true, extra: false },
    ];

    for (const value of invalidValues) {
      expect(() => decodeFeatureFlagDefinition(value)).toThrow(INVALID);
    }
  });
});

describe("decodeFeatureFlagEnvironmentState", () => {
  it("accepts valid bounds and detaches both arrays", () => {
    const raw = environmentState({
      accountAllowlist: [accountA, accountB],
      badgeAnyOf: ["beta", "new-view"],
      percentageBasisPoints: 10_000,
    });
    const decoded = decodeFeatureFlagEnvironmentState(raw);

    expect(decoded).toEqual(raw);
    expect(decoded).not.toBe(raw);
    expect(decoded.accountAllowlist).not.toBe(raw.accountAllowlist);
    expect(decoded.badgeAnyOf).not.toBe(raw.badgeAnyOf);
  });

  it("rejects unsorted, duplicate, permissive-ID, and unknown nested values", () => {
    const invalidValues: unknown[] = [
      environmentState({ accountAllowlist: [accountB, accountA] }),
      environmentState({ accountAllowlist: [accountA, accountA] }),
      environmentState({ accountAllowlist: ["acc_not-a-canonical-ulid"] }),
      environmentState({ badgeAnyOf: ["new-view", "beta"] }),
      environmentState({ badgeAnyOf: ["beta", "beta"] }),
      environmentState({ badgeAnyOf: ["Beta"] }),
      environmentState({ badgeAnyOf: ["a".repeat(65)] }),
      environmentState({ percentageBasisPoints: -1 }),
      environmentState({ percentageBasisPoints: 10_001 }),
      environmentState({ percentageBasisPoints: 1.5 }),
      { ...environmentState(), extra: true },
      { ...environmentState(), accountAllowlist: [accountA, 4] },
    ];

    for (const value of invalidValues) {
      expect(() => decodeFeatureFlagEnvironmentState(value)).toThrow(INVALID);
    }
  });

  it("enforces the account and badge count limits", () => {
    const accounts = Array.from({ length: 1_001 }, (_, index) => {
      const suffix = index.toString(36).toUpperCase().padStart(26, "0");
      return `acc_${suffix}`;
    });
    const badges = Array.from({ length: 65 }, (_, index) => `badge-${index.toString().padStart(2, "0")}`);

    expect(() => decodeFeatureFlagEnvironmentState(environmentState({ accountAllowlist: accounts }))).toThrow(INVALID);
    expect(() => decodeFeatureFlagEnvironmentState(environmentState({ badgeAnyOf: badges }))).toThrow(INVALID);
  });
});

describe("decodeFeatureFlagDocument", () => {
  it("closes nested objects, bounds authored text, and detaches values", () => {
    const raw = documentValue();
    const decoded = decodeFeatureFlagDocument(raw);

    expect(decoded).toEqual(raw);
    expect(decoded).not.toBe(raw);
    expect(decoded.environments).not.toBe(raw.environments);
    expect(decoded.environments.staging).not.toBe(raw.environments.staging);

    (raw.environments.staging.accountAllowlist as string[]).push(accountA);
    expect(decoded.environments.staging.accountAllowlist).toEqual([]);
  });

  it("rejects schema, text, nested-extra, and environment-shape mutations", () => {
    const invalidValues: unknown[] = [
      { ...documentValue(), schemaVersion: 2 },
      { ...documentValue(), description: "" },
      { ...documentValue(), description: " padded " },
      { ...documentValue(), description: "x".repeat(501) },
      { ...documentValue(), owner: "x".repeat(201) },
      { ...documentValue(), removalCondition: "x".repeat(1_001) },
      { ...documentValue(), extra: true },
      {
        ...documentValue(),
        environments: { ...documentValue().environments, staging: { ...environmentState(), extra: true } },
      },
      { ...documentValue(), environments: { staging: environmentState(), production: environmentState(), test: {} } },
    ];

    for (const value of invalidValues) {
      expect(() => decodeFeatureFlagDocument(value)).toThrow(INVALID);
    }
  });
});

describe("decodeFeatureFlagReadResult", () => {
  it("decodes each closed tagged result", () => {
    const value = environmentState({ accountAllowlist: [accountA] });
    expect(
      decodeFeatureFlagReadResult({
        status: "found",
        documentId: "revision-1",
        updatedAt: "2026-10-17T12:00:00.000Z",
        schemaVersion: 1,
        environment: "production",
        value,
      }),
    ).toMatchObject({ status: "found", documentId: "revision-1", schemaVersion: 1, environment: "production", value });
    expect(decodeFeatureFlagReadResult({ status: "not-found" })).toEqual({ status: "not-found" });
    expect(
      decodeFeatureFlagReadResult({ status: "malformed", documentId: "revision-1", errorCode: "invalid-document" }),
    ).toEqual({ status: "malformed", documentId: "revision-1", errorCode: "invalid-document" });
    expect(decodeFeatureFlagReadResult({ status: "unavailable", errorCode: "store-unavailable" })).toEqual({
      status: "unavailable",
      errorCode: "store-unavailable",
    });
  });

  it("rejects invalid instants, values, tags, and extra fields", () => {
    const found = {
      status: "found",
      documentId: "revision-1",
      updatedAt: "2026-10-17T12:00:00.000Z",
      schemaVersion: 1,
      environment: "staging",
      value: environmentState(),
    };
    const invalidValues: unknown[] = [
      { ...found, updatedAt: "2026-10-17" },
      { ...found, updatedAt: "2026-10-17T12:00:00" },
      { ...found, value: { ...environmentState(), extra: true } },
      { ...found, schemaVersion: 2 },
      { ...found, extra: true },
      { status: "not-found", extra: false },
      { status: "malformed", documentId: "revision-1", errorCode: "store-unavailable" },
      { status: "unavailable", errorCode: "invalid-document" },
      { status: "unknown" },
    ];

    for (const value of invalidValues) {
      expect(() => decodeFeatureFlagReadResult(value)).toThrow(INVALID);
    }
  });
});
