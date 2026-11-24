import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  findPolicyConsoleRegistrationViolations,
  findPolicyDeclarations,
  findRegisteredPolicyNames,
  isPolicyDeclarationGuardedFile,
  policyConsoleCrossContextRegistrationFile,
  policyConsoleOwnRegistrationFile,
  validatePolicyConsoleRegistration,
} from "./policy-console-registration.mjs";
import { policyConsoleRegistrationExceptions } from "./policy-console-registration-exceptions.mjs";

const probeFile = "bounded-contexts/settlement/features/probe/domain/policy.ts";
const exceptionListFile = "scripts/check-structure/policy-console-registration-exceptions.mjs";

const registeredCrossContextSource = `
export const registeredCrossContextPolicy: PolicyDefinition<ProbeValue> = definePolicy({
  policyKey: "settlement.registered-probe",
});
`;
const registeredOwnSource = `
export const registeredOwnPolicy = definePolicy({ policyKey: "platform-operations.registered-probe" });
`;

// A composition root and a Platform Operations service module shaped like the
// real ones: one cross-context `definitions` array, one own list, and a public
// policy source that mentions a policy without registering it.
function consoleSources({ crossContext = ["registeredCrossContextPolicy"], own = ["registeredOwnPolicy"] } = {}) {
  return [
    {
      relativePath: policyConsoleCrossContextRegistrationFile,
      source: `
        policyConsoleCrossContextSources.push({
          contextName: "settlement",
          db: settlementPool,
          definitions: [
            ${crossContext.join(",\n            ")},
          ] as unknown as readonly PolicyDefinition<JsonValue>[],
        });
        publicPolicySources.push(createPublicPolicySource(settlementPool, mentionedOnlyPolicy));
      `,
    },
    {
      relativePath: policyConsoleOwnRegistrationFile,
      source: `
        const ownPolicyDefinitions = [
          ${own.join(",\n          ")},
        ] as unknown as readonly PolicyDefinition<JsonValue>[];
      `,
    },
    {
      relativePath: "bounded-contexts/settlement/features/registered/domain/policy.ts",
      source: registeredCrossContextSource,
    },
    {
      relativePath: "bounded-contexts/platform-operations/features/registered/domain/policy.ts",
      source: registeredOwnSource,
    },
  ];
}

function check(extraSources, { exceptions = [], ...registration } = {}) {
  return findPolicyConsoleRegistrationViolations([...consoleSources(registration), ...extraSources], { exceptions });
}

const declarationForms = [
  {
    form: "plain constant",
    symbol: "plainProbePolicy",
    source: `
export const plainProbePolicy = definePolicy({
  policyKey: "settlement.plain-probe",
});
`,
  },
  {
    form: "annotated constant",
    symbol: "annotatedProbePolicy",
    source: `
export const annotatedProbePolicy: PolicyDefinition<Readonly<{ limit: number; halted: boolean }>> =
  definePolicy({
    policyKey: "settlement.annotated-probe",
  });
`,
  },
  {
    form: "factory",
    symbol: "factoryProbePolicy",
    source: `
const PROBE_SCHEMA_SUMMARY = "{ limit: integer }";

export function factoryProbePolicy(accountId: string): PolicyDefinition<ProbeValue> {
  const normalizedAccountId = normalizeAccountId(accountId);
  return definePolicy({
    policyKey: \`settlement.factory-probe.\${normalizedAccountId}\`,
    schemaSummary: PROBE_SCHEMA_SUMMARY,
  });
}
`,
  },
  {
    form: "nested type argument",
    symbol: "nestedProbePolicy",
    source: `
export const nestedProbePolicy = definePolicy<Readonly<{ approvedConsentVersion: string | null }>>({
  policyKey: "settlement.nested-probe",
});
`,
  },
  {
    form: "type argument that spans lines",
    symbol: "multiLineProbePolicy",
    source: `
export const multiLineProbePolicy = definePolicy<
  Readonly<{
    decode: (raw: JsonValue) => Readonly<Record<string, number>>;
    limit: number;
  }>
>({
  policyKey: "settlement.multi-line-probe",
});
`,
  },
];

describe("policy console registration guard", () => {
  describe("the repository", () => {
    const result = validatePolicyConsoleRegistration({ repoRoot });
    const symbols = result.declarations.map(({ symbol }) => symbol);

    it("reports no violation", () => {
      expect(result.violations).toEqual([]);
    });

    it("registers the six policies that had no authoring path, without excepting them", () => {
      const registered = new Set(result.registered.map(({ symbol }) => symbol));
      const excepted = new Set(policyConsoleRegistrationExceptions.map(({ symbol }) => symbol));
      for (const symbol of [
        "riskAlertThresholdPolicy",
        "walletAdjustmentLimitsPolicy",
        "walletAdjustmentControlsPolicy",
        "accountLinkageFlagPolicy",
        "bulkRepriceIngestionPolicy",
        "marketplaceListingBulkPriceUpdatePolicy",
      ]) {
        expect(registered.has(symbol), `${symbol} is registered`).toBe(true);
        expect(excepted.has(symbol), `${symbol} is not excepted`).toBe(false);
      }
    });

    it("registers the Card Authentication Policy in the Payments source, without excepting it", () => {
      const symbol = "cardAuthenticationPolicy";
      expect(result.registered.map((declaration) => declaration.symbol)).toContain(symbol);
      expect(policyConsoleRegistrationExceptions.map((exception) => exception.symbol)).not.toContain(symbol);
      const compositionRoot = readFileSync(path.join(repoRoot, policyConsoleCrossContextRegistrationFile), "utf8");
      const paymentsSource = compositionRoot.slice(
        compositionRoot.indexOf('contextName: "payments"'),
        compositionRoot.indexOf('contextName: "identity"'),
      );
      expect(paymentsSource).toMatch(/definitions: \[[^\]]*\bcardAuthenticationPolicy\b[^\]]*\]/);
    });

    it("registers the Listing Report Auto-Unlist Policy in the Marketplace source, without excepting it", () => {
      const symbol = "marketplaceListingReportAutoUnlistPolicy";
      expect(result.registered).toContainEqual(
        expect.objectContaining({
          symbol,
          file: "bounded-contexts/marketplace/features/reports/domain/listing-report-auto-unlist-policy.ts",
        }),
      );
      expect(policyConsoleRegistrationExceptions.map((exception) => exception.symbol)).not.toContain(symbol);
      const compositionRoot = readFileSync(path.join(repoRoot, policyConsoleCrossContextRegistrationFile), "utf8");
      const marketplaceSource = compositionRoot.slice(
        compositionRoot.indexOf('contextName: "marketplace"'),
        compositionRoot.indexOf('contextName: "pricing"'),
      );
      expect(marketplaceSource).toMatch(/definitions: \[[^\]]*\bmarketplaceListingReportAutoUnlistPolicy\b[^\]]*\]/);
    });

    it("registers the Query Vocabulary policy in a Discovery source of its own, without excepting it", () => {
      const symbol = "queryVocabularyPolicy";
      expect(result.registered).toContainEqual(
        expect.objectContaining({
          symbol,
          file: "bounded-contexts/discovery/features/search/domain/query-vocabulary-policy.ts",
        }),
      );
      expect(policyConsoleRegistrationExceptions.map((exception) => exception.symbol)).not.toContain(symbol);
      const compositionRoot = readFileSync(path.join(repoRoot, policyConsoleCrossContextRegistrationFile), "utf8");
      const discoverySource = compositionRoot.slice(
        compositionRoot.indexOf('contextName: "discovery"'),
        compositionRoot.indexOf('contextName: "ordering"'),
      );
      expect(discoverySource).toMatch(/db: discoveryPool,/);
      expect(discoverySource).toMatch(/definitions: \[[^\]]*\bqueryVocabularyPolicy\b[^\]]*\]/);
      expect(discoverySource).toMatch(/runtime\?\.services\.discovery\b/);
    });

    it("registers the Shipping Rates Policy in an Ordering source of its own, without excepting it", () => {
      const symbol = "shippingRatesPolicy";
      expect(result.registered).toContainEqual(
        expect.objectContaining({
          symbol,
          file: "bounded-contexts/ordering/features/orders/domain/shipping-rates.ts",
        }),
      );
      expect(policyConsoleRegistrationExceptions.map((exception) => exception.symbol)).not.toContain(symbol);
      const compositionRoot = readFileSync(path.join(repoRoot, policyConsoleCrossContextRegistrationFile), "utf8");
      const orderingSource = compositionRoot.slice(
        compositionRoot.indexOf('contextName: "ordering"'),
        compositionRoot.indexOf("const policyConsoleCrossContext:"),
      );
      expect(orderingSource).toMatch(/db: orderingPool,/);
      expect(orderingSource).toMatch(/definitions: \[[^\]]*\bshippingRatesPolicy\b[^\]]*\]/);
      expect(orderingSource).toMatch(/runtime\?\.services\.ordering\b/);
    });

    // The inventory is the omission check: a declaration the scanner misses
    // lowers the first number, and one counted twice breaks the uniqueness
    // assertion. A change that adds or removes a declaration updates the
    // numbers with its registration or exception.
    it("counts every declaration once, as registered or excepted", () => {
      expect(new Set(symbols).size).toBe(symbols.length);
      expect(symbols.filter((symbol) => symbol === "marketplaceOfferPaymentConsentPolicy")).toHaveLength(1);
      expect({
        declarations: result.declarations.length,
        registered: result.registered.length,
        excepted: result.excepted.length,
      }).toEqual({ declarations: 56, registered: 37, excepted: 19 });
      expect(result.excepted).toHaveLength(policyConsoleRegistrationExceptions.length);
    });

    it("runs inside check:structure", () => {
      const runSource = readFileSync(path.join(repoRoot, "scripts/check-structure/run.mjs"), "utf8");
      expect(runSource).toContain('from "./policy-console-registration.mjs"');
      expect(runSource).toContain(
        "const policyConsoleRegistrationResult = validatePolicyConsoleRegistration({ repoRoot });",
      );
      expect(runSource).toContain("violations.push(...policyConsoleRegistrationResult.violations);");
    });
  });

  describe("an unregistered, unexcepted declaration", () => {
    it.each(declarationForms)("fails for a $form, naming file and symbol", ({ symbol, source }) => {
      const result = check([{ relativePath: probeFile, source }]);

      expect(result.declarations.map((declaration) => declaration.symbol)).toContain(symbol);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain(`${probeFile}:`);
      expect(result.violations[0]).toContain(`policy declaration ${symbol} is neither registered`);
    });

    it.each(declarationForms)("passes for a $form once it is registered", ({ symbol, source }) => {
      const result = check([{ relativePath: probeFile, source }], {
        crossContext: ["registeredCrossContextPolicy", symbol],
      });

      expect(result.violations).toEqual([]);
      expect(result.registered.map((declaration) => declaration.symbol)).toContain(symbol);
    });

    it.each(declarationForms)("passes for a $form with a reasoned exception", ({ symbol, source }) => {
      const result = check([{ relativePath: probeFile, source }], {
        exceptions: [{ file: probeFile, symbol, reason: "Authored on its own admin surface." }],
      });

      expect(result.violations).toEqual([]);
      expect(result.excepted.map((declaration) => declaration.symbol)).toEqual([symbol]);
    });

    it("reports the line of the declaration", () => {
      const result = check([
        { relativePath: probeFile, source: "\n\n\nexport const lateProbePolicy = definePolicy({});\n" },
      ]);

      expect(result.violations).toEqual([
        expect.stringContaining(`${probeFile}:4: policy declaration lateProbePolicy`),
      ]);
    });

    it("does not treat a mention outside the registration lists as registered", () => {
      const result = check([
        { relativePath: probeFile, source: "export const mentionedOnlyPolicy = definePolicy({});\n" },
      ]);

      expect(result.violations).toEqual([expect.stringContaining("policy declaration mentionedOnlyPolicy")]);
    });

    it("reads the own registration list as well as the cross-context arrays", () => {
      const result = check(
        [{ relativePath: probeFile, source: "export const ownedProbePolicy = definePolicy({});\n" }],
        {
          own: ["registeredOwnPolicy", "ownedProbePolicy"],
        },
      );

      expect(result.violations).toEqual([]);
    });
  });

  describe("the exception list", () => {
    const source = "export const exceptedProbePolicy = definePolicy({});\n";
    const exception = { file: probeFile, symbol: "exceptedProbePolicy", reason: "Authored on its own admin surface." };

    it("fails for an exception whose declaration no longer exists", () => {
      const result = check([], { exceptions: [exception] });

      expect(result.violations).toEqual([
        `${exceptionListFile}: exception for exceptedProbePolicy in ${probeFile} matches no definePolicy declaration; delete the stale entry`,
      ]);
    });

    it("fails for an exception whose declaration moved to another file", () => {
      const result = check([{ relativePath: probeFile.replace("probe", "moved"), source }], {
        exceptions: [exception],
      });

      expect(result.violations).toHaveLength(2);
      expect(result.violations.join("\n")).toContain("matches no definePolicy declaration");
      expect(result.violations.join("\n")).toContain("policy declaration exceptedProbePolicy is neither registered");
    });

    it("fails for an exception whose declaration is now registered", () => {
      const result = check([{ relativePath: probeFile, source }], {
        crossContext: ["registeredCrossContextPolicy", "exceptedProbePolicy"],
        exceptions: [exception],
      });

      expect(result.violations).toEqual([
        `${exceptionListFile}: exception for exceptedProbePolicy in ${probeFile} is now registered in the platform policy console; delete the entry`,
      ]);
    });

    it.each([[""], ["   "], [undefined]])("fails for an exception with an empty reason (%j)", (reason) => {
      const result = check([{ relativePath: probeFile, source }], { exceptions: [{ ...exception, reason }] });

      expect(result.violations).toEqual([
        `${exceptionListFile}: exception for exceptedProbePolicy in ${probeFile} has an empty reason; say where the policy is authored instead`,
      ]);
    });

    it("fails for an exception listed twice", () => {
      const result = check([{ relativePath: probeFile, source }], { exceptions: [exception, exception] });

      expect(result.violations).toEqual([expect.stringContaining("is listed more than once")]);
    });

    it("gives every reviewed exception a reason", () => {
      for (const { reason } of policyConsoleRegistrationExceptions) {
        expect(reason.trim().length).toBeGreaterThan(20);
      }
    });
  });

  describe("the scanner", () => {
    it("does not count the shared machinery's own function, imports, or prose", () => {
      const { declarations, violations } = findPolicyDeclarations({
        relativeFile: "infrastructure/platform-policy/define-policy.ts",
        content: `
import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";

/**
 * Bounds live with the file that calls definePolicy(...) for the value.
 */
// A policy's owning file is anything that calls \`definePolicy(\`.
export function definePolicy<Value>(config: DefinePolicyConfig<Value>): PolicyDefinition<Value> {
  return Object.freeze(config);
}
export type Declared = ReturnType<typeof definePolicy>;
`,
      });

      expect(declarations).toEqual([]);
      expect(violations).toEqual([]);
    });

    it("reads a call after a closed block comment or a quoted URL as code, not as prose", () => {
      const { declarations, violations } = findPolicyDeclarations({
        relativeFile: probeFile,
        content: [
          "export const afterBlockCommentPolicy = /* fallback */ definePolicy({});",
          'export const afterUrlPolicy = withDocs("https://example.test/policies", definePolicy({}));',
        ].join("\n"),
      });

      expect(declarations).toEqual([]);
      expect(violations).toEqual([
        expect.stringContaining(`${probeFile}:1: definePolicy call is neither the initializer of a constant`),
        expect.stringContaining(`${probeFile}:2: definePolicy call is neither the initializer of a constant`),
      ]);
    });

    it("fails closed on a call it cannot name", () => {
      const result = check([
        {
          relativePath: probeFile,
          source: "export const buildProbePolicy = (accountId: string) => definePolicy({ policyKey: accountId });\n",
        },
      ]);

      expect(result.declarations.map(({ symbol }) => symbol)).not.toContain("buildProbePolicy");
      expect(result.violations).toEqual([
        expect.stringContaining(`${probeFile}:1: definePolicy call is neither the initializer of a constant`),
      ]);
    });

    it("fails closed on a type-argument list that never closes", () => {
      const result = check([
        { relativePath: probeFile, source: "export const brokenProbePolicy = definePolicy<Readonly<{ a: 1 }>({});\n" },
      ]);

      expect(result.violations).toEqual([expect.stringContaining("type-argument list that never closes")]);
    });

    it.each([
      ["an alias", "const declare = definePolicy;\nexport const aliasedProbePolicy = declare({});\n"],
      ["a renamed import", 'import { definePolicy as declare } from "@chase-sets/platform-policy/define-policy";\n'],
      ["an optional call", "export const optionalProbePolicy = definePolicy?.({});\n"],
      ["a comment before the call", "export const commentedProbePolicy = definePolicy/* why */({});\n"],
      [
        "a quoted bracket that ends the type-argument list early",
        'export const quotedProbePolicy = definePolicy<{ op: ">" }>({});\n',
      ],
    ])("fails closed on %s, which it cannot read as a direct call", (_shape, source) => {
      const { declarations, violations } = findPolicyDeclarations({ relativeFile: probeFile, content: source });

      expect(declarations).toEqual([]);
      expect(violations).toEqual([
        expect.stringContaining(`${probeFile}:1: definePolicy is used here without being called directly`),
      ]);
    });

    it("passes a plain export specifier unread", () => {
      const { declarations, violations } = findPolicyDeclarations({
        relativeFile: "infrastructure/platform-policy/index.ts",
        content:
          'export {\n  createPolicyCache,\n  definePolicy,\n  type PolicyDefinition,\n} from "./define-policy";\n',
      });

      expect(declarations).toEqual([]);
      expect(violations).toEqual([]);
    });

    it("names two declarations in one file separately", () => {
      const { declarations } = findPolicyDeclarations({
        relativeFile: probeFile,
        content: `
export const firstProbePolicy: PolicyDefinition<ProbeValue> = definePolicy({ policyKey: "a" });

export const secondProbePolicy: PolicyDefinition<ProbeValue> = definePolicy({ policyKey: "b" });
`,
      });

      expect(declarations).toEqual([
        { file: probeFile, symbol: "firstProbePolicy", line: 2 },
        { file: probeFile, symbol: "secondProbePolicy", line: 4 },
      ]);
    });

    it("fails when two declarations share a name, because registration is matched by name", () => {
      const result = check(
        [
          { relativePath: probeFile, source: "export const sharedProbePolicy = definePolicy({});\n" },
          {
            relativePath: probeFile.replace("settlement", "pricing"),
            source: "export const sharedProbePolicy = definePolicy({});\n",
          },
        ],
        { crossContext: ["registeredCrossContextPolicy", "sharedProbePolicy"] },
      );

      expect(result.violations).toEqual([expect.stringContaining("sharedProbePolicy is declared more than once")]);
    });

    it("fails for a registered name that matches no declaration", () => {
      const result = check([], { crossContext: ["registeredCrossContextPolicy", "aliasedProbePolicy"] });

      expect(result.violations).toEqual([
        expect.stringContaining(
          `${policyConsoleCrossContextRegistrationFile}: registered policy name aliasedProbePolicy matches no definePolicy declaration`,
        ),
      ]);
    });

    it("fails when a registration list is no longer where the guard reads it", () => {
      const result = findPolicyConsoleRegistrationViolations(
        [
          { relativePath: policyConsoleCrossContextRegistrationFile, source: "const sources = [];\n" },
          { relativePath: policyConsoleOwnRegistrationFile, source: "const policies = [];\n" },
        ],
        { exceptions: [] },
      );

      expect(result.violations).toEqual([
        expect.stringContaining(
          `${policyConsoleOwnRegistrationFile}: expected exactly one \`ownPolicyDefinitions = [...]\``,
        ),
        expect.stringContaining(`${policyConsoleCrossContextRegistrationFile}: no \`definitions: [...]\` array found`),
      ]);
    });

    it("fails closed on an unreadable tracked file", () => {
      const result = check([{ relativePath: probeFile, readError: "could not read tracked file (EACCES)" }]);

      expect(result.violations).toEqual([
        expect.stringContaining(`${probeFile}: could not read tracked file (EACCES)`),
      ]);
    });

    it("reads registered names past comments and ignores other arrays", () => {
      const registration = findRegisteredPolicyNames({
        crossContextSource: `
          sources.push({ definitions: [walletFundingLimitsPolicy] });
          sources.push({
            definitions: [
              settlementClearancePolicy, // public
              /* kill switch */ walletAdjustmentLimitsPolicy,
            ] as unknown as readonly PolicyDefinition<JsonValue>[],
          });
          const unrelated = [notAPolicy];
        `,
        ownSource: "const ownPolicyDefinitions = [rateLimitPolicy];",
      });

      expect([...registration.fileByName.keys()]).toEqual([
        "walletFundingLimitsPolicy",
        "settlementClearancePolicy",
        "walletAdjustmentLimitsPolicy",
        "rateLimitPolicy",
      ]);
      expect(registration.crossContextArrayCount).toBe(2);
      expect(registration.ownArrayCount).toBe(1);
    });

    it("does not count a commented-out registration list", () => {
      const registration = findRegisteredPolicyNames({
        crossContextSource: `
          sources.push({ definitions: [walletFundingLimitsPolicy] });
          // sources.push({ definitions: [lineCommentedPolicy] });
          /* sources.push({ definitions: [blockCommentedPolicy] }); */
          /**
           * sources.push({ definitions: [docCommentedPolicy] });
           */
        `,
        ownSource: "// const ownPolicyDefinitions = [retiredPolicy];\nconst ownPolicyDefinitions = [rateLimitPolicy];",
      });

      expect([...registration.fileByName.keys()]).toEqual(["walletFundingLimitsPolicy", "rateLimitPolicy"]);
      expect(registration.crossContextArrayCount).toBe(1);
      expect(registration.ownArrayCount).toBe(1);
    });

    it("scans production TypeScript only", () => {
      expect(isPolicyDeclarationGuardedFile(probeFile)).toBe(true);
      expect(isPolicyDeclarationGuardedFile("infrastructure/platform-policy/examples/grace-period-policy.ts")).toBe(
        true,
      );
      expect(isPolicyDeclarationGuardedFile("infrastructure/platform-policy/resolver.test.ts")).toBe(false);
      expect(isPolicyDeclarationGuardedFile("bounded-contexts/settlement/tests/policy-fixture.ts")).toBe(false);
      expect(isPolicyDeclarationGuardedFile("infrastructure/platform-policy/test-support.ts")).toBe(false);
      expect(isPolicyDeclarationGuardedFile("infrastructure/platform-policy/define-policy.d.ts")).toBe(false);
      expect(isPolicyDeclarationGuardedFile("scripts/check-structure/business-literal-guard.mjs")).toBe(false);

      const result = check([
        {
          relativePath: "bounded-contexts/settlement/features/probe/domain/policy.test.ts",
          source: "export const testOnlyPolicy = definePolicy({});\n",
        },
      ]);
      expect(result.violations).toEqual([]);
    });
  });
});
