import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");
if (!process.env.VITEST) await import("tsx/esm");

const {
  assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe,
  buildCatalogSecurityPrivacyLaunchGatePacket,
  catalogSecurityPrivacyLaunchGateChecklist,
  catalogSecurityPrivacyLaunchGateChecklistVersion,
  catalogSecurityPrivacyLaunchGateSchemaVersion,
} = await import("./catalog-integration-security-privacy-launch-gate.ts");
const { catalogIntegrationControlPlaneActionPolicies } =
  await import("../../bounded-contexts/catalog/features/source-observations/api/admin/admin-control-plane-rbac.ts");
const { catalogIntegrationDataGovernancePolicies } =
  await import("../../bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-data-governance.ts");

describe("Catalog integration security/privacy launch gate", () => {
  it("builds a launch-safe #1064 packet covering RBAC, governance and retirement", () => {
    const packet = safePacket();
    assert.equal(packet.schemaVersion, catalogSecurityPrivacyLaunchGateSchemaVersion);
    assert.equal(packet.checklistVersion, catalogSecurityPrivacyLaunchGateChecklistVersion);
    assert.equal(packet.signoff.owner, "catalog-source-observations");
    assert.equal(packet.signoff.reviewer, "catalog-release-lead");
    assert.equal(packet.realProviderProof.linkedGateIssue, "#1064");
    assert.deepEqual(
      packet.checklist.map((item) => item.key),
      catalogSecurityPrivacyLaunchGateChecklist.map((item) => item.key),
    );
    assert.deepEqual(
      packet.rbac.actionPolicies.map((policy) => policy.action),
      catalogIntegrationControlPlaneActionPolicies.map((policy) => policy.action),
    );
    assert.deepEqual(
      packet.governance.coveredDataClasses,
      catalogIntegrationDataGovernancePolicies.map((policy) => policy.key),
    );
    assert.equal(packet.integrationResetDisposition.productionApply, "NOT RUN");
    assert.equal(packet.integrationResetDisposition.decidedAt, "2026-11-22");
    assert.match(packet.integrationResetDisposition.decision, /#issuecomment-7074059802$/);
    assert.match(packet.integrationResetDisposition.productionReadOnlyDryRun, /\/44984051710$/);
    for (const surface of [
      "read-model contracts",
      "clients",
      "feature flags",
      "fallback branches",
      "compatibility aliases",
      "migration shims",
      "seeds",
      "documentation",
    ]) {
      assert.ok(packet.retirement.policy.surfaces.includes(surface), surface);
    }
    for (const outcome of [
      "soft deprecation",
      "support-only preserved route",
      "documentation-only deprecation",
      "hidden flag fallback",
    ]) {
      assert.ok(packet.retirement.policy.forbiddenOutcomes.includes(outcome), outcome);
    }
  });

  it("fails closed when signoff or packet metadata is incomplete", () => {
    assert.throws(
      () =>
        buildCatalogSecurityPrivacyLaunchGatePacket({
          generatedAt: "2026-06-11T00:00:00.000Z",
          signoff: {
            owner: "",
            reviewer: "catalog-release-lead",
            approvedAt: "2026-06-11T00:00:00.000Z",
            approvalReference: "#1064",
            checklistVersion: catalogSecurityPrivacyLaunchGateChecklistVersion,
          },
        }),
      /must name the owner/,
    );
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...safePacket(),
          signoff: { ...safePacket().signoff, checklistVersion: "catalog-security-privacy-checklist\/old" },
        }),
      /must name the checklist version/,
    );
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({ ...safePacket(), generatedAt: "", environment: "" }),
      /must include the generated timestamp/,
    );
  });

  it("fails closed when destructive actions are visible to view-only actors", () => {
    const packet = safePacket();
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          rbac: {
            ...packet.rbac,
            actionPolicies: packet.rbac.actionPolicies.map((policy) =>
              policy.action === "bulk-review-write" ? { ...policy, requiredPermission: "catalog.view" } : policy,
            ),
          },
        }),
      /destructive action 'bulk-review-write' must require catalog\.manage/,
    );
  });

  it("fails closed when checklist or governed data-class coverage is incomplete", () => {
    const packet = safePacket();
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          checklist: packet.checklist.filter((item) => item.key !== "complete-retirement"),
        }),
      /checklist mismatch/,
    );
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          checklist: [...packet.checklist, packet.checklist[0]],
        }),
      /checklist mismatch/,
    );
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          governance: {
            ...packet.governance,
            coveredDataClasses: packet.governance.coveredDataClasses.filter((key) => key !== "raw-provider-payload"),
          },
        }),
      /governed data-class coverage mismatch/,
    );
  });

  it("fails closed for retained provider evidence, proof leakage, or proof-time writes", () => {
    const packet = safePacket();
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          governance: { ...packet.governance, rawProviderPayloadRetained: true },
        }),
      /provider-data governance evidence is unsafe/,
    );
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          realProviderProof: {
            ...packet.realProviderProof,
            fullProviderUrlsRetained: true,
            writeExecutedDuringProof: true,
          },
        }),
      /real-provider proof privacy evidence is unsafe/,
    );
  });

  it("refuses a packet that reports production apply as PASS", () => {
    const packet = safePacket();
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          integrationResetDisposition: { ...packet.integrationResetDisposition, productionApply: "PASS" },
        }),
      /launch packet must record.*NOT RUN/,
    );
  });

  it("refuses a missing or tampered archive even for a previously valid packet", () => {
    const packet = safePacket();
    withResetRetirementFixture((root, archive, write) => {
      assert.doesNotThrow(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(packet, root));
      rmSync(archive);
      assert.throws(() => safePacket(root), /disposition is missing or unreadable/);
      assert.throws(
        () => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(packet, root),
        /disposition is missing or unreadable/,
      );
      for (const patch of [
        { productionApply: "PASS" },
        { productionReadOnlyDryRun: "" },
        { stagingSmoke: null },
        { decision: "https://example.invalid/not-the-host-decision" },
      ]) {
        write(dispositionPath, JSON.stringify({ ...packet.integrationResetDisposition, ...patch }));
        assert.throws(() => safePacket(root), /must match the archived NOT RUN decision and evidence/);
      }
    });
  });

  it("refuses a restored workflow, CLI, governance module, or ops alias", () => {
    const packet = safePacket();
    withResetRetirementFixture((root, _archive, write) => {
      for (const path of [
        ".github/workflows/catalog-integration-staging-reset.yml",
        "scripts/run-catalog-integration-reset.mjs",
        "scripts/catalog-integration-reset.ts",
        "bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-data-migration-reset.ts",
      ]) {
        write(path, "");
        assert.throws(
          () => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(packet, root),
          /Retired Catalog Integration reset path is present/,
        );
        rmSync(join(root, path));
      }
      write("scripts/ops.mjs", 'const ops = { "catalog:integration-reset": {} };');
      assert.throws(() => safePacket(root), /Retired Catalog Integration reset command is present/);
    });
  });

  it("fails closed when retirement preserves compatibility surfaces", () => {
    const packet = safePacket();
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          retirement: {
            ...packet.retirement,
            retainedLegacyDocumentation: true,
            retainedCodePatternsOrDocs: true,
            migrationEvidenceUsedAsRetirementException: true,
          },
        }),
      /must prove complete deletion/,
    );
  });
});

const dispositionPath = "bounded-contexts/catalog/docs/catalog-integration-production-reset-disposition.json";

function withResetRetirementFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "catalog-reset-retirement-"));
  const archive = join(root, dispositionPath);
  const write = (path, content) => {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  try {
    write("scripts/ops.mjs", "");
    mkdirSync(dirname(archive), { recursive: true });
    copyFileSync(new URL(`../../${dispositionPath}`, import.meta.url), archive);
    run(root, archive, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function safePacket(repositoryRoot) {
  return buildCatalogSecurityPrivacyLaunchGatePacket(
    {
      environment: "staging",
      generatedAt: "2026-06-11T00:00:00.000Z",
      signoff: {
        owner: "catalog-source-observations",
        reviewer: "catalog-release-lead",
        approvedAt: "2026-06-11T00:00:00.000Z",
        approvalReference: "https://github.com/chase-sets/chase-sets/issues/1064#issuecomment-launch-gate",
        checklistVersion: catalogSecurityPrivacyLaunchGateChecklistVersion,
      },
    },
    repositoryRoot,
  );
}
