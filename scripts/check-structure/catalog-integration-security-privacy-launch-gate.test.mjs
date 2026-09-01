import assert from "node:assert/strict";

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
  it("builds a launch-safe #1064 packet covering RBAC, governance, reset/drop, and retirement", () => {
    const packet = safePacket();
    assert.equal(packet.schemaVersion, catalogSecurityPrivacyLaunchGateSchemaVersion);
    assert.equal(packet.checklistVersion, catalogSecurityPrivacyLaunchGateChecklistVersion);
    assert.equal(packet.signoff.owner, "catalog-source-observations");
    assert.equal(packet.signoff.reviewer, "catalog-release-lead");
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
    assert.equal(packet.resetDrop.targetTables.includes("orders"), false);
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

  it("fails closed when reset/drop proof is not bounded", () => {
    const packet = safePacket();
    assert.throws(
      () =>
        assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe({
          ...packet,
          resetDrop: {
            ...packet.resetDrop,
            productionPrelaunchRequiresApproval: false,
            targetTables: [...packet.resetDrop.targetTables, "orders"],
          },
        }),
      /reset\/drop target table coverage mismatch/,
    );
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

function safePacket() {
  return buildCatalogSecurityPrivacyLaunchGatePacket({
    environment: "staging",
    generatedAt: "2026-06-11T00:00:00.000Z",
    signoff: {
      owner: "catalog-source-observations",
      reviewer: "catalog-release-lead",
      approvedAt: "2026-06-11T00:00:00.000Z",
      approvalReference: "https://github.com/chase-sets/chase-sets/issues/1064#issuecomment-launch-gate",
      checklistVersion: catalogSecurityPrivacyLaunchGateChecklistVersion,
    },
  });
}
