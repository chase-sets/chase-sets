import { describe, expect, it } from "vitest";
import { catalogIntegrationControlPlaneActionPolicies } from "../admin/admin-control-plane-rbac";
import { catalogIntegrationDataGovernancePolicies } from "./catalog-integration-data-governance";
import {
  assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe,
  buildCatalogSecurityPrivacyLaunchGatePacket,
  catalogSecurityPrivacyLaunchGateChecklist,
  catalogSecurityPrivacyLaunchGateChecklistVersion,
  catalogSecurityPrivacyLaunchGateSchemaVersion,
  type CatalogSecurityPrivacyLaunchGatePacket,
} from "./catalog-integration-security-privacy-launch-gate";

describe("Catalog integration security/privacy launch gate", () => {
  it("builds a launch-safe #1064 packet that covers RBAC, governance, reset/drop, and complete retirement", () => {
    const packet = safePacket();

    expect(packet).toMatchObject({
      schemaVersion: catalogSecurityPrivacyLaunchGateSchemaVersion,
      checklistVersion: catalogSecurityPrivacyLaunchGateChecklistVersion,
      signoff: {
        owner: "catalog-source-observations",
        reviewer: "catalog-release-lead",
        checklistVersion: catalogSecurityPrivacyLaunchGateChecklistVersion,
      },
      realProviderProof: {
        linkedGateIssue: "#1064",
        proofIssue: "#1062",
        productionSignoffIssue: "#1061",
        noConfusionAcceptanceIssue: "#1047",
      },
    });
    expect(packet.checklist.map((item) => item.key)).toEqual(
      catalogSecurityPrivacyLaunchGateChecklist.map((item) => item.key),
    );
    expect(packet.rbac.actionPolicies.map((policy) => policy.action)).toEqual(
      catalogIntegrationControlPlaneActionPolicies.map((policy) => policy.action),
    );
    expect(packet.governance.coveredDataClasses).toEqual(
      catalogIntegrationDataGovernancePolicies.map((policy) => policy.key),
    );
    expect(packet.resetDrop.targetTables).not.toEqual(expect.arrayContaining(["catalog_items", "orders"]));
    expect(packet.retirement.policy.surfaces).toEqual(
      expect.arrayContaining([
        "read-model contracts",
        "clients",
        "feature flags",
        "fallback branches",
        "compatibility aliases",
        "migration shims",
        "seeds",
        "documentation",
      ]),
    );
    expect(packet.retirement.policy.forbiddenOutcomes).toEqual(
      expect.arrayContaining([
        "soft deprecation",
        "support-only preserved route",
        "documentation-only deprecation",
        "hidden flag fallback",
      ]),
    );
  });

  it("fails closed when signoff does not name owner, reviewer, checklist version, and approval reference", () => {
    expect(() =>
      buildCatalogSecurityPrivacyLaunchGatePacket({
        generatedAt: "2026-06-11T00:00:00.000Z",
        signoff: {
          owner: "",
          reviewer: "catalog-release-lead",
          approvedAt: "2026-06-11T00:00:00.000Z",
          approvalReference: "https://github.com/chase-sets/chase-sets/issues/1064#issuecomment-launch-gate",
          checklistVersion: catalogSecurityPrivacyLaunchGateChecklistVersion,
        },
      }),
    ).toThrow("Catalog security/privacy launch gate signoff must name the owner.");

    const packet = {
      ...safePacket(),
      signoff: {
        ...safePacket().signoff,
        checklistVersion: "catalog-security-privacy-checklist/old",
      },
    } as unknown as CatalogSecurityPrivacyLaunchGatePacket;
    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(packet)).toThrow(
      "Catalog security/privacy launch gate signoff must name the checklist version.",
    );

    const missingPacketMetadata = {
      ...safePacket(),
      generatedAt: "",
      environment: "",
    } satisfies CatalogSecurityPrivacyLaunchGatePacket;
    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(missingPacketMetadata)).toThrow(
      "Catalog security/privacy launch gate packet must include the generated timestamp.",
    );
  });

  it("fails closed when destructive actions are visible to view-only actors", () => {
    const packet = safePacket();
    const unsafePacket = {
      ...packet,
      rbac: {
        ...packet.rbac,
        actionPolicies: packet.rbac.actionPolicies.map((policy) =>
          policy.action === "bulk-review-write" ? { ...policy, requiredPermission: "catalog.view" as const } : policy,
        ),
      },
    } satisfies CatalogSecurityPrivacyLaunchGatePacket;

    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(unsafePacket)).toThrow(
      "Catalog control-plane destructive action 'bulk-review-write' must require catalog.manage.",
    );
  });

  it("fails closed when the checklist or governed data-class coverage is incomplete", () => {
    const packet = safePacket();
    const missingChecklist = {
      ...packet,
      checklist: packet.checklist.filter((item) => item.key !== "complete-retirement"),
    } satisfies CatalogSecurityPrivacyLaunchGatePacket;
    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(missingChecklist)).toThrow(
      "Catalog security/privacy launch gate checklist mismatch.",
    );

    const duplicateChecklist = {
      ...packet,
      checklist: [...packet.checklist, packet.checklist[0]],
    } satisfies CatalogSecurityPrivacyLaunchGatePacket;
    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(duplicateChecklist)).toThrow(
      "Catalog security/privacy launch gate checklist mismatch.",
    );

    const missingDataClass = {
      ...packet,
      governance: {
        ...packet.governance,
        coveredDataClasses: packet.governance.coveredDataClasses.filter(
          (dataClass) => dataClass !== "raw-provider-payload",
        ),
      },
    } satisfies CatalogSecurityPrivacyLaunchGatePacket;
    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(missingDataClass)).toThrow(
      "Catalog security/privacy launch gate governed data-class coverage mismatch.",
    );
  });

  it("fails closed for retained provider evidence, full URL proof leakage, or proof-time writes", () => {
    const packet = safePacket();
    const retainedPayload = {
      ...packet,
      governance: {
        ...packet.governance,
        rawProviderPayloadRetained: true,
      },
    } as unknown as CatalogSecurityPrivacyLaunchGatePacket;
    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(retainedPayload)).toThrow(
      "Catalog security/privacy launch gate provider-data governance evidence is unsafe.",
    );

    const realProviderLeak = {
      ...packet,
      realProviderProof: {
        ...packet.realProviderProof,
        fullProviderUrlsRetained: true,
        writeExecutedDuringProof: true,
      },
    } as unknown as CatalogSecurityPrivacyLaunchGatePacket;
    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(realProviderLeak)).toThrow(
      "Catalog real-provider proof privacy evidence is unsafe for launch.",
    );
  });

  it("fails closed when reset/drop proof is not approval-gated and bounded", () => {
    const packet = safePacket();
    const unsafeReset = {
      ...packet,
      resetDrop: {
        ...packet.resetDrop,
        productionPrelaunchRequiresApproval: false,
        targetTables: [...packet.resetDrop.targetTables, "orders"],
      },
    } as unknown as CatalogSecurityPrivacyLaunchGatePacket;

    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(unsafeReset)).toThrow(
      "Catalog security/privacy launch gate reset/drop target table coverage mismatch.",
    );
  });

  it("fails closed when retirement preserves code, patterns, documentation, flags, aliases, shims, or support paths", () => {
    const packet = safePacket();
    const retainedDocumentation = {
      ...packet,
      retirement: {
        ...packet.retirement,
        retainedLegacyDocumentation: true,
        retainedCodePatternsOrDocs: true,
        migrationEvidenceUsedAsRetirementException: true,
      },
    } as unknown as CatalogSecurityPrivacyLaunchGatePacket;

    expect(() => assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(retainedDocumentation)).toThrow(
      "Catalog control-plane retirement evidence must prove complete deletion, not preserved compatibility.",
    );
  });
});

function safePacket(): CatalogSecurityPrivacyLaunchGatePacket {
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
