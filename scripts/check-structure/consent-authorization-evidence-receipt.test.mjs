import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectOpenSchemaObjectPaths, validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import { repoRoot } from "../lib/repo.mjs";

globalThis.__CHASE_SETS_CONSENT_AUTHORIZATION_RECEIPT_VERIFIER__ = true;
const evidence = await import("./consent-authorization-mutation-evidence.mjs?receipt-verifier");
delete globalThis.__CHASE_SETS_CONSENT_AUTHORIZATION_RECEIPT_VERIFIER__;
const {
  ConsentAuthorizationEvidenceError,
  buildConsentAuthorizationEvidenceReceipt,
  canonicalConsentAuthorizationEvidence,
  consentAuthorizationEvidenceFailureCodes,
  consentAuthorizationEvidenceWorkUnitCeilings,
  deriveConsentAuthorizationEvidenceInventory,
  executeConsentAuthorizationMutationEvidence,
  mutationEvidenceCases,
  verifyConsentAuthorizationEvidenceReceipt,
} = evidence;

const receiptPath = "scripts/check-structure/consent-authorization-evidence-receipt.json";
const schemaPath = "scripts/check-structure/consent-authorization-evidence-receipt.schema.json";
const enumerationPath = "scripts/check-structure/consent-authorization-case-enumeration.json";
const analyzerPath = "scripts/check-structure/consent-authorization-sites.mjs";

function repoBytes(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath));
}

const receipt = JSON.parse(repoBytes(receiptPath).toString("utf8"));
const schema = JSON.parse(repoBytes(schemaPath).toString("utf8"));
const enumeration = JSON.parse(repoBytes(enumerationPath).toString("utf8"));
const trackedBytes = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "buffer",
  stdio: ["ignore", "pipe", "pipe"],
});
const trackedFiles = trackedBytes.toString("utf8").split("\0").filter(Boolean);

function clone(value) {
  return structuredClone(value);
}

function virtualDerivation({ additions = {}, replacements = {}, tracked = trackedFiles, controls = {} } = {}) {
  const virtualTracked = [...new Set([...tracked, ...Object.keys(additions)])];
  return {
    rootDir: repoRoot,
    execGitLsFiles: () => Buffer.from(`${virtualTracked.join("\0")}\0`),
    controls,
    readBytes: (relativePath) => {
      if (Object.hasOwn(replacements, relativePath)) return Buffer.from(replacements[relativePath]);
      if (Object.hasOwn(additions, relativePath)) return Buffer.from(additions[relativePath]);
      return repoBytes(relativePath);
    },
  };
}

function verify(candidate, derivationOptions = virtualDerivation()) {
  return verifyConsentAuthorizationEvidenceReceipt(
    candidate,
    enumeration,
    schema,
    validateAgainstSchema,
    derivationOptions,
  );
}

function capturedCode(action) {
  try {
    action();
    return "pass";
  } catch (error) {
    if (error instanceof ConsentAuthorizationEvidenceError) return error.code;
    throw error;
  }
}

function expectDiscriminatingRed(candidate, expectedCode, derivationOptions = virtualDerivation()) {
  expect(capturedCode(() => verify(receipt))).toBe("pass");
  expect(capturedCode(() => verify(candidate, derivationOptions))).toBe(expectedCode);
}

function appendWhitespace(relativePath) {
  return Buffer.concat([repoBytes(relativePath), Buffer.from(" ")]);
}

function nestedKeys(value) {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [key, ...nestedKeys(entry)]);
}

function rawReceiptsFromCommitted() {
  return receipt.digestBound.cases.map(({ caseId, evidence: caseEvidence }) => ({
    caseId,
    candidateSubrun: caseEvidence.candidate,
    mutantSubrun: caseEvidence.mutant,
    expected: caseEvidence.expected,
    firstFailingClauseId: caseEvidence.firstFailingClauseId,
    mutationActive: caseEvidence.mutationStatus === "active",
    noEarlierClause: caseEvidence.noEarlierClauseStatus === "proven",
    preservedVariableHashes: { candidate: {}, mutant: {} },
  }));
}

describe("Consent authorization evidence receipt", () => {
  it("regenerates a byte-identical receipt from an unchanged tree", () => {
    const inventoryResult = deriveConsentAuthorizationEvidenceInventory(virtualDerivation());
    const input = {
      aggregate: {
        counts: receipt.digestBound.aggregate.counts,
        reconciliation: receipt.digestBound.aggregate.reconciliation,
        valid: true,
      },
      receipts: rawReceiptsFromCommitted(),
      inventoryResult,
      floatingProvenance: receipt.floatingProvenance,
      previousReceipt: receipt,
    };
    const first = `${JSON.stringify(buildConsentAuthorizationEvidenceReceipt(input), null, 2)}\n`;
    const second = `${JSON.stringify(buildConsentAuthorizationEvidenceReceipt(input), null, 2)}\n`;
    expect(second).toBe(first);
    expect(first).toBe(repoBytes(receiptPath).toString("utf8"));
    const generatedDigestBound = JSON.parse(first).digestBound;
    expect(canonicalConsentAuthorizationEvidence(generatedDigestBound)).not.toMatch(/(?:[A-Z]:\\\\|\/tmp\/)/);
    expect(nestedKeys(generatedDigestBound)).not.toEqual(
      expect.arrayContaining(["generatedAt", "completedAt", "environment", "generationHead"]),
    );
  });

  it("derives the governing-input inventory from the real dependency closure", () => {
    const result = verify(receipt);
    const paths = result.inventory.map(({ path: relativePath }) => relativePath);
    expect(result.importClosure).toEqual([
      "packages/typescript-compiler-api/index.mjs",
      "scripts/check-structure/consent-authorization-mutation-evidence.mjs",
      "scripts/check-structure/consent-authorization-sites.mjs",
      "scripts/check-structure/guard-candidate-provenance.mjs",
      "scripts/check-structure/identity-creation-path-registry.mjs",
      "scripts/check-structure/typescript-owner-context-derivation.mjs",
      "scripts/lib/repo.mjs",
    ]);
    for (const requiredPath of [
      "scripts/lib/repo.mjs",
      "scripts/check-structure/typescript-owner-contexts.json",
      "scripts/check-structure/typescript-owner-context-partition.json",
      "scripts/check-structure/typescript-owner-contexts-v1.schema.json",
      "scripts/check-structure/fixtures/guard-candidate-provenance/plain.json",
      "scripts/check-structure/fixtures/guard-candidate-provenance/pull-request-merge-ref.json",
      "scripts/check-structure/fixtures/guard-candidate-provenance/merge-group.json",
      "scripts/check-structure/guard-candidate-provenance-v1.schema.json",
      "scripts/check-structure/identity-creation-path-registry.json",
      "scripts/check-structure/identity-creation-path-registry.schema.json",
      "packages/typescript-compiler-api/index.mjs",
      "packages/typescript-compiler-api/index.d.ts",
      "packages/typescript-compiler-api/package.json",
    ]) {
      expect(paths).toContain(requiredPath);
    }
    expect(paths).not.toContain(receiptPath);
    expect(paths).not.toContain(schemaPath);
    expect(paths).not.toContain("scripts/check-structure/consent-authorization-sites.test.mjs");
    expect(paths).not.toContain("scripts/check-structure/consent-authorization-evidence-receipt.test.mjs");
    expect(result.reconciliation).toEqual({
      derivedOutsideTracked: [],
      trackedFootprintMissingFromDerived: [],
    });
    process.stdout.write(`consent-authorization-evidence-inventory=${JSON.stringify(result.inventory)}\n`);
    process.stdout.write(`consent-authorization-evidence-reconciliation=${JSON.stringify(result.reconciliation)}\n`);
  });

  it("enters a planted fixture and a planted import into the derived inventory", () => {
    const plantedFixture = "scripts/check-structure/fixtures/guard-candidate-provenance/planted.json";
    expectDiscriminatingRed(
      receipt,
      consentAuthorizationEvidenceFailureCodes.stale,
      virtualDerivation({ additions: { [plantedFixture]: "{}\n" } }),
    );

    const plantedModule = "scripts/check-structure/consent-authorization-planted.mjs";
    expectDiscriminatingRed(
      receipt,
      consentAuthorizationEvidenceFailureCodes.stale,
      virtualDerivation({
        additions: { [plantedModule]: "export const planted = true;\n" },
        replacements: {
          [analyzerPath]: Buffer.concat([
            repoBytes(analyzerPath),
            Buffer.from(`\nimport \"./consent-authorization-planted.mjs\";\n`),
          ]),
        },
      }),
    );
  });

  it("fails closed when the derived inventory disagrees with the independent enumeration", () => {
    const missingTrackedModule = trackedFiles.filter(
      (relativePath) => relativePath !== "scripts/check-structure/guard-candidate-provenance.mjs",
    );
    expectDiscriminatingRed(
      receipt,
      consentAuthorizationEvidenceFailureCodes.inventory,
      virtualDerivation({ tracked: missingTrackedModule }),
    );
    expectDiscriminatingRed(
      receipt,
      consentAuthorizationEvidenceFailureCodes.inventory,
      virtualDerivation({ controls: { suppressExportedRoot: evidence.provenanceFixtureRoot } }),
    );
  });

  it("admits the committed receipt only on an exact recomputed digest match", () => {
    const result = verify(receipt);
    expect(result.inventorySha256).toBe(receipt.digestBound.governingInputs.inventorySha256);
    expect(result.inventory).toEqual(receipt.digestBound.governingInputs.inventory);
    expect(result.workUnits).toEqual(receipt.digestBound.workUnits);
  });

  it("surfaces each receipt failure class under its named terminal code", () => {
    const stale = clone(receipt);
    stale.digestBound.governingInputs.inventory[0].sha256 = "0".repeat(64);

    const malformed = clone(receipt);
    malformed.digestBound.cases[0].evidence.candidate.exitCode = "zero";

    const tampered = clone(receipt);
    tampered.digestBound.cases[0].evidence.expected.violation += " edited";

    const enumerationMismatch = clone(receipt);
    enumerationMismatch.digestBound.cases[0].caseId = "MUT-SYNTHETIC-UNAUTHORIZED";

    const controls = [
      [stale, consentAuthorizationEvidenceFailureCodes.stale, virtualDerivation()],
      [malformed, consentAuthorizationEvidenceFailureCodes.malformed, virtualDerivation()],
      [tampered, consentAuthorizationEvidenceFailureCodes.tampered, virtualDerivation()],
      [enumerationMismatch, consentAuthorizationEvidenceFailureCodes.enumeration, virtualDerivation()],
      [
        receipt,
        consentAuthorizationEvidenceFailureCodes.inventory,
        virtualDerivation({ controls: { suppressExportedRoot: evidence.provenanceFixtureRoot } }),
      ],
    ];
    for (const [candidate, expectedCode, derivationOptions] of controls) {
      expectDiscriminatingRed(candidate, expectedCode, derivationOptions);
    }
  });

  it("rejects each tampered receipt variant through its named code", () => {
    const editedVerdict = clone(receipt);
    editedVerdict.digestBound.cases[0].evidence.expected.surface += " edited";

    const droppedCase = clone(receipt);
    droppedCase.digestBound.cases.pop();

    const duplicatedCase = clone(receipt);
    duplicatedCase.digestBound.cases.at(-1).caseId = duplicatedCase.digestBound.cases[0].caseId;

    const staleDigest = clone(receipt);
    staleDigest.digestBound.governingInputs.inventory[0].sha256 = "a".repeat(64);

    const nestedUnknown = clone(receipt);
    nestedUnknown.digestBound.aggregate.counts.unknown = 30;

    const removedInventoryEntry = clone(receipt);
    removedInventoryEntry.digestBound.governingInputs.inventory.pop();

    const enumerationMismatch = clone(receipt);
    enumerationMismatch.digestBound.cases[0].caseId = "MUT-SYNTHETIC-UNAUTHORIZED";

    for (const [name, candidate, code] of [
      ["edited-verdict", editedVerdict, consentAuthorizationEvidenceFailureCodes.tampered],
      ["dropped-case", droppedCase, consentAuthorizationEvidenceFailureCodes.tampered],
      ["duplicated-case", duplicatedCase, consentAuthorizationEvidenceFailureCodes.tampered],
      ["stale-digest", staleDigest, consentAuthorizationEvidenceFailureCodes.stale],
      ["nested-unknown", nestedUnknown, consentAuthorizationEvidenceFailureCodes.malformed],
      ["removed-inventory-entry", removedInventoryEntry, consentAuthorizationEvidenceFailureCodes.stale],
      ["enumeration-mismatch", enumerationMismatch, consentAuthorizationEvidenceFailureCodes.enumeration],
    ]) {
      const observed = capturedCode(() => verify(candidate));
      process.stdout.write(`consent-authorization-evidence-mutant=${name}:${observed}\n`);
      expect(observed).toBe(code);
    }
    expect(capturedCode(() => verify({ contractVersion: receipt.contractVersion }))).toBe(
      consentAuthorizationEvidenceFailureCodes.malformed,
    );
  });

  it("fails stale on a one-byte perturbation of every governing input class", () => {
    const fixture = trackedFiles.find(
      (relativePath) =>
        relativePath.startsWith("scripts/check-structure/fixtures/consent-authorization-sites/") &&
        relativePath.endsWith(".ts"),
    );
    const cases = {
      analyzer: analyzerPath,
      fixture,
      enumeration: enumerationPath,
      schema:
        "scripts/check-structure/fixtures/consent-authorization-sites/consent-authorization-mutation-v1.schema.json",
      compilerShim: "packages/typescript-compiler-api/index.mjs",
      sharedRepoLibrary: "scripts/lib/repo.mjs",
      ownerContextRuntimeData: "scripts/check-structure/typescript-owner-contexts.json",
      provenanceEnvironmentFixture: "scripts/check-structure/fixtures/guard-candidate-provenance/plain.json",
    };
    for (const [name, relativePath] of Object.entries(cases)) {
      const observed = capturedCode(() =>
        verify(receipt, virtualDerivation({ replacements: { [relativePath]: appendWhitespace(relativePath) } })),
      );
      process.stdout.write(`consent-authorization-evidence-byte-perturbation=${name}:${observed}\n`);
      expect(observed).toBe(consentAuthorizationEvidenceFailureCodes.stale);
    }
  });

  it("rejects nested unknown, out-of-range, and malformed receipt data", () => {
    const nestedUnknown = clone(receipt);
    nestedUnknown.floatingProvenance.roles.analyzedTree.unknown = "closed";

    const wrongType = clone(receipt);
    wrongType.floatingProvenance.generationHead = 42;

    const outOfRange = clone(receipt);
    outOfRange.digestBound.cases[0].evidence.mutant.exitCode = 0;

    const dateOnly = clone(receipt);
    dateOnly.floatingProvenance.generatedAt = "2026-08-07";

    for (const candidate of [nestedUnknown, wrongType, outOfRange, dateOnly]) {
      expect(capturedCode(() => verify(candidate))).toBe(consentAuthorizationEvidenceFailureCodes.malformed);
    }
    expect(collectOpenSchemaObjectPaths(schema)).toEqual([]);
  });

  it("asserts the committed verifier work-unit budget from instrumented counters", () => {
    const live = deriveConsentAuthorizationEvidenceInventory(virtualDerivation());
    expect(live.workUnits).toEqual(receipt.digestBound.workUnits);
    for (const [counter, ceiling] of Object.entries(consentAuthorizationEvidenceWorkUnitCeilings)) {
      expect(live.workUnits[counter]).toBeLessThanOrEqual(ceiling);

      const widened = clone(receipt);
      widened.digestBound.workUnits[counter] += 1;
      expect(capturedCode(() => verify(widened))).toBe(consentAuthorizationEvidenceFailureCodes.stale);
    }

    const secondParse = deriveConsentAuthorizationEvidenceInventory(
      virtualDerivation({ controls: { secondParsePath: analyzerPath } }),
    );
    expect(secondParse.workUnits.compilerSurfaceSourceParses).toBe(live.workUnits.compilerSurfaceSourceParses + 1);
    expect(
      capturedCode(() => verify(receipt, virtualDerivation({ controls: { secondParsePath: analyzerPath } }))),
    ).toBe(consentAuthorizationEvidenceFailureCodes.stale);

    const doubleDigestPath = live.inventory[0].path;
    const doubleDigest = deriveConsentAuthorizationEvidenceInventory(
      virtualDerivation({ controls: { doubleDigestPath } }),
    );
    expect(doubleDigest.workUnits.trackedFilesDigested).toBe(live.workUnits.trackedFilesDigested + 1);
    expect(capturedCode(() => verify(receipt, virtualDerivation({ controls: { doubleDigestPath } })))).toBe(
      consentAuthorizationEvidenceFailureCodes.stale,
    );

    process.stdout.write(
      `consent-authorization-evidence-work-units=${JSON.stringify({ observed: live.workUnits, ceilings: consentAuthorizationEvidenceWorkUnitCeilings })}\n`,
    );
  });

  it("keeps the battery verifier outside the real mutation harness", () => {
    expect(mutationEvidenceCases).toEqual([]);
    expect(executeConsentAuthorizationMutationEvidence).toBeUndefined();
    expect(receipt.digestBound.cases).toHaveLength(39);
    expect(receipt.digestBound.aggregate.counts).toEqual({
      total: 39,
      candidateGreen: 39,
      mutantRed: 39,
      active: 39,
      preserved: 39,
    });
  });
});
