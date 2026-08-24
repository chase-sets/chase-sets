import { describe, expect, it } from "vitest";
import type { BcAccountCapabilityDeclaration } from "@chase-sets/bounded-context-module";
import {
  buildAccountCapabilityRegistry,
  type AccountCapabilityModuleRegistration,
  type AccountCapabilityRegistryEntry,
} from "./account-capability-registry";

const booleanDeclaration = {
  key: "authenticity.seller-included",
  description: "Seller-included authenticity evidence",
  kind: "boolean",
  defaultValue: false,
} as const satisfies BcAccountCapabilityDeclaration;

const limitDeclaration = {
  key: "inventory.locations",
  description: "Inventory location limit",
  kind: "limit",
  defaultValue: 0,
} as const satisfies BcAccountCapabilityDeclaration;

const tierDeclaration = {
  key: "mcp.rate-tier",
  description: "MCP rate tier",
  kind: "tier",
  allowedValues: ["standard", "priority"],
  defaultValue: "standard",
} as const satisfies BcAccountCapabilityDeclaration;

function registration(
  contextName: string,
  accountCapabilities?: readonly BcAccountCapabilityDeclaration[],
): AccountCapabilityModuleRegistration {
  return {
    contextName,
    module: accountCapabilities === undefined ? {} : { accountCapabilities },
  };
}

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) {
    return [values];
  }

  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]),
  );
}

describe("Account Capability registry", () => {
  it("accepts the complete key grammar independently of owning context and sorts entries by key", () => {
    const registry = buildAccountCapabilityRegistry([
      registration("platform-operations", [
        tierDeclaration,
        {
          key: "platform-operations.mcp-rate-tier",
          description: "Platform Operations MCP rate tier",
          kind: "tier",
          allowedValues: ["standard"],
          defaultValue: "standard",
        },
      ]),
      registration("inventory", [limitDeclaration]),
      registration("authenticity", [booleanDeclaration]),
    ]);

    expect(registry.map(({ key, owningContext }) => [key, owningContext])).toEqual([
      ["authenticity.seller-included", "authenticity"],
      ["inventory.locations", "inventory"],
      ["mcp.rate-tier", "platform-operations"],
      ["platform-operations.mcp-rate-tier", "platform-operations"],
    ]);
  });

  it("returns identical immutable entries for every permutation of module input", () => {
    const registrations = [
      registration("platform-operations", [tierDeclaration]),
      registration("authenticity", [booleanDeclaration]),
      registration("inventory", [limitDeclaration]),
    ];
    const expected = buildAccountCapabilityRegistry(registrations);

    for (const permutation of permutations(registrations)) {
      expect(buildAccountCapabilityRegistry(permutation)).toEqual(expected);
    }

    expect(Object.isFrozen(expected)).toBe(true);
    expect(expected.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(expected.find((entry) => entry.kind === "tier")?.allowedValues)).toBe(true);
  });

  it("settles deep immutability for typed, as-never, and Reflect.apply consumers", () => {
    const sourceAllowedValues = ["standard", "priority"];
    const registry = buildAccountCapabilityRegistry([
      registration("platform-operations", [
        {
          key: "mcp.rate-tier",
          description: "MCP rate tier",
          kind: "tier",
          allowedValues: sourceAllowedValues,
          defaultValue: "standard",
        },
      ]),
    ]);
    const entry = registry[0];
    if (!entry || entry.kind !== "tier") {
      throw new Error("Expected the tier fixture in the registry.");
    }

    sourceAllowedValues.push("enterprise");
    expect(entry.allowedValues).toEqual(["standard", "priority"]);
    expect(() => (registry as never as AccountCapabilityRegistryEntry[]).push(entry)).toThrow(TypeError);
    expect(() => Reflect.apply(Array.prototype.push, registry, [entry])).toThrow(TypeError);
    expect(() => (entry.allowedValues as never as string[]).push("enterprise")).toThrow(TypeError);
    expect(() => {
      (entry as never as { defaultValue: string }).defaultValue = "priority";
    }).toThrow(TypeError);
    expect(entry.defaultValue).toBe("standard");
  });

  it("keeps allowed tier values distinct from the declared default", () => {
    const [entry] = buildAccountCapabilityRegistry([registration("platform-operations", [tierDeclaration])]);

    expect(entry).toEqual({
      owningContext: "platform-operations",
      ...tierDeclaration,
    });
    expect(entry?.kind === "tier" && entry.allowedValues.includes("priority")).toBe(true);
    expect(entry?.defaultValue).toBe("standard");
  });

  it.each(["Rate Tier", "mcp.", ".rate-tier", "mcp..rate-tier", "mcp.rate_tier"])("rejects invalid key %s", (key) => {
    expect(() =>
      buildAccountCapabilityRegistry([
        {
          contextName: "platform-operations",
          module: {
            accountCapabilities: [
              {
                key,
                description: "Invalid key",
                kind: "boolean",
                defaultValue: false,
              },
            ],
          },
        },
      ] as never),
    ).toThrow(/platform-operations.*invalid key/);
  });

  it.each([
    ["blank description", { key: "account.test", description: " ", kind: "boolean", defaultValue: false }],
    ["unknown kind", { key: "account.test", description: "Test", kind: "meter", defaultValue: 0 }],
    ["boolean mismatch", { key: "account.test", description: "Test", kind: "boolean", defaultValue: 0 }],
    ["negative limit", { key: "account.test", description: "Test", kind: "limit", defaultValue: -1 }],
    ["infinite limit", { key: "account.test", description: "Test", kind: "limit", defaultValue: Infinity }],
    [
      "empty tier list",
      { key: "account.test", description: "Test", kind: "tier", allowedValues: [], defaultValue: "standard" },
    ],
    [
      "empty tier value",
      { key: "account.test", description: "Test", kind: "tier", allowedValues: [""], defaultValue: "" },
    ],
    [
      "duplicate tier value",
      {
        key: "account.test",
        description: "Test",
        kind: "tier",
        allowedValues: ["standard", "standard"],
        defaultValue: "standard",
      },
    ],
    [
      "default outside tier list",
      {
        key: "account.test",
        description: "Test",
        kind: "tier",
        allowedValues: ["standard"],
        defaultValue: "priority",
      },
    ],
    [
      "extra field",
      {
        key: "account.test",
        description: "Test",
        kind: "boolean",
        defaultValue: false,
        grant: true,
      },
    ],
  ])("rejects malformed declaration: %s", (_name, declaration) => {
    expect(() =>
      buildAccountCapabilityRegistry([
        {
          contextName: "identity",
          module: { accountCapabilities: [declaration] },
        },
      ] as never),
    ).toThrow(/identity.*account\.test/);
  });

  it("rejects duplicates with both owning contexts named", () => {
    expect(() =>
      buildAccountCapabilityRegistry([
        registration("authenticity", [booleanDeclaration]),
        registration("marketplace", [booleanDeclaration]),
      ]),
    ).toThrow(/authenticity\.seller-included.*authenticity.*marketplace/);
  });

  it("fails closed when Reflect.apply bypasses the TypeScript input contract", () => {
    expect(() =>
      Reflect.apply(buildAccountCapabilityRegistry, undefined, [
        [
          {
            contextName: "inventory",
            module: {
              accountCapabilities: [
                {
                  key: "inventory.locations",
                  description: "Inventory location limit",
                  kind: "limit",
                  defaultValue: Number.NaN,
                },
              ],
            },
          },
        ],
      ]),
    ).toThrow(/inventory\.locations.*finite non-negative/);
  });

  it("returns a required immutable empty catalog when no declarations exist", () => {
    const registry = buildAccountCapabilityRegistry([registration("identity")]);

    expect(registry).toEqual([]);
    expect(Object.isFrozen(registry)).toBe(true);
  });
});
