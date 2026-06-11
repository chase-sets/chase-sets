import { describe, expect, it } from "vitest";
import {
  assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe,
  buildCatalogNoConfusionUxAcceptancePacket,
  catalogNoConfusionUxAcceptanceChecklist,
  catalogNoConfusionUxAcceptanceChecklistVersion,
  catalogNoConfusionUxAcceptanceSchemaVersion,
  type CatalogNoConfusionUxAcceptancePacket,
} from "./catalog-integration-no-confusion-ux-acceptance";
import {
  catalogPrimaryWorkbenchActions,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  catalogPrimaryWorkbenchRetirementPolicy,
  catalogPrimaryWorkbenchSections,
} from "./primary-workbench-admin-contracts";

describe("Catalog integration no-confusion UX acceptance gate", () => {
  it("builds a launch-safe #1047 packet for the rebuilt import-to-promotion first slice", () => {
    const packet = safePacket();

    expect(packet).toMatchObject({
      schemaVersion: catalogNoConfusionUxAcceptanceSchemaVersion,
      checklistVersion: catalogNoConfusionUxAcceptanceChecklistVersion,
      signoff: {
        owner: "catalog-source-observations",
        reviewer: "catalog-release-lead",
        checklistVersion: catalogNoConfusionUxAcceptanceChecklistVersion,
      },
      telemetry: {
        issue: "#1059",
        primaryJourneyEventsRecorded: true,
        supportDetourMetricPathCovered: true,
      },
      proofHandoffs: {
        accessibilityProofIssue: "#1046",
        noConfusionIssue: "#1047",
        realProviderProofIssue: "#1062",
        durableJobEdgeCaseIssue: "#1063",
        securityPrivacyIssue: "#1064",
        providerTransportIssue: "#1065",
        productionRolloutIssue: "#1061",
      },
    });
    expect(packet.checklist.map((item) => item.key)).toEqual(
      catalogNoConfusionUxAcceptanceChecklist.map((item) => item.key),
    );
    expect(
      packet.workflows.filter((workflow) => workflow.primaryPathStep !== null).map((workflow) => workflow.key),
    ).toEqual([
      "choose-provider-unit-scope",
      "pull-provider-data",
      "monitor-import",
      "review-source-observations",
      "preview-promotion",
      "promote-to-catalog-items",
      "verify-audit-release-evidence",
    ]);
    expect(new Set(packet.workflows.flatMap((workflow) => workflow.sections))).toEqual(
      new Set(catalogPrimaryWorkbenchSections.map((section) => section.key)),
    );
    expect(new Set(packet.workflows.flatMap((workflow) => workflow.actions))).toEqual(
      new Set(catalogPrimaryWorkbenchActions.map((action) => action.key)),
    );
    expect(packet.telemetry.dimensions).toEqual(catalogPrimaryWorkbenchInstrumentationDimensions);
    expect(packet.retirement.policy).toBe(catalogPrimaryWorkbenchRetirementPolicy);
  });

  it("fails closed when signoff, packet metadata, or checklist coverage is incomplete", () => {
    expect(() =>
      buildCatalogNoConfusionUxAcceptancePacket({
        generatedAt: "2026-06-11T00:00:00.000Z",
        signoff: {
          owner: "",
          reviewer: "catalog-release-lead",
          approvedAt: "2026-06-11T00:00:00.000Z",
          approvalReference: "https://github.com/chase-sets/chase-sets/issues/1047#issuecomment-launch-gate",
        },
      }),
    ).toThrow("Catalog no-confusion UX acceptance signoff must name the owner.");

    const missingMetadata = {
      ...safePacket(),
      generatedAt: "",
      environment: "",
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(missingMetadata)).toThrow(
      "Catalog no-confusion UX acceptance packet must include the generated timestamp.",
    );

    const duplicateChecklist = {
      ...safePacket(),
      checklist: [...safePacket().checklist, safePacket().checklist[0]],
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(duplicateChecklist)).toThrow(
      "Catalog no-confusion UX acceptance checklist mismatch.",
    );
  });

  it("fails closed when the primary workflow matrix loses a step or preserves a current-page artifact", () => {
    const missingWorkflow = {
      ...safePacket(),
      workflows: safePacket().workflows.filter((workflow) => workflow.key !== "preview-promotion"),
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(missingWorkflow)).toThrow(
      "Catalog no-confusion UX workflow matrix mismatch.",
    );

    const wrongPrimaryStep = {
      ...safePacket(),
      workflows: safePacket().workflows.map((workflow) =>
        workflow.key === "pull-provider-data" ? { ...workflow, primaryPathStep: 6 } : workflow,
      ),
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(wrongPrimaryStep)).toThrow(
      "Catalog primary workflow order mismatch at step 2; expected 'pull-provider-data'.",
    );

    const oldPageArtifact = {
      ...safePacket(),
      workflows: safePacket().workflows.map((workflow) =>
        workflow.key === "review-source-observations"
          ? {
              ...workflow,
              currentTwoPageMigrationArtifact: true,
              rawJsonFallback: true,
            }
          : workflow,
      ),
    } as unknown as CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(oldPageArtifact)).toThrow(
      "Catalog no-confusion UX workflow 'review-source-observations' preserves a confusing or legacy artifact.",
    );
  });

  it("fails closed when role, accessibility, visual, or resilience coverage is incomplete", () => {
    const viewOnlyWrites = {
      ...safePacket(),
      roles: safePacket().roles.map((role) =>
        role.role === "view-only-operator" ? { ...role, canExecutePrimaryWrites: true } : role,
      ),
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(viewOnlyWrites)).toThrow(
      "Catalog view-only acceptance must keep primary writes disabled.",
    );

    const missingAccessibility = {
      ...safePacket(),
      accessibility: safePacket().accessibility.filter((item) => item.key !== "keyboard-completion"),
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(missingAccessibility)).toThrow(
      "Catalog no-confusion UX accessibility matrix mismatch.",
    );

    const overlappingVisual = {
      ...safePacket(),
      visualQa: safePacket().visualQa.map((item) =>
        item.state === "dense-source-observation-table" ? { ...item, noOverlap: false } : item,
      ),
    } as unknown as CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(overlappingVisual)).toThrow(
      "Catalog no-confusion UX visual state 'dense-source-observation-table' is incomplete.",
    );

    const rawJsonResilience = {
      ...safePacket(),
      resilience: safePacket().resilience.map((item) =>
        item.key === "command-execution-failure" ? { ...item, rawJsonFallbackAvailable: true } : item,
      ),
    } as unknown as CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(rawJsonResilience)).toThrow(
      "Catalog no-confusion UX resilience check 'command-execution-failure' is incomplete.",
    );
  });

  it("fails closed when telemetry, proof handoff, or provider-transport evidence is incomplete", () => {
    const missingTelemetryDimension = {
      ...safePacket(),
      telemetry: {
        ...safePacket().telemetry,
        dimensions: safePacket().telemetry.dimensions.filter((dimension) => dimension !== "route_context_preserved"),
      },
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(missingTelemetryDimension)).toThrow(
      "Catalog no-confusion UX telemetry dimensions mismatch.",
    );

    const staleHandoff = {
      ...safePacket(),
      proofHandoffs: {
        ...safePacket().proofHandoffs,
        securityPrivacyIssue: "#1047",
      },
    } as unknown as CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(staleHandoff)).toThrow(
      "Catalog no-confusion UX proof handoff issues are incomplete.",
    );

    const missingBudget = {
      ...safePacket(),
      providerTransport: {
        ...safePacket().providerTransport,
        budgetSurfaces: safePacket().providerTransport.budgetSurfaces.filter(
          (surface) => surface !== "promotion-preview",
        ),
      },
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(missingBudget)).toThrow(
      "Catalog no-confusion UX provider transport budget surfaces mismatch.",
    );
  });

  it("fails closed when retirement preserves code, patterns, documentation, fixtures, flags, aliases, or shims", () => {
    const retainedLegacy = {
      ...safePacket(),
      retirement: {
        ...safePacket().retirement,
        retainedCurrentTwoPageCode: true,
        retainedCurrentTwoPagePattern: true,
        retainedLegacyDocumentation: true,
        retainedFixtureScreenshotOrTest: true,
        retainedFlagAliasShimOrRedirect: true,
        migrationEvidenceUsedAsRetirementException: true,
      },
    } as unknown as CatalogNoConfusionUxAcceptancePacket;

    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsLaunchSafe(retainedLegacy)).toThrow(
      "Catalog no-confusion UX retirement evidence must prove complete deletion, not preserved compatibility.",
    );
  });
});

function safePacket(): CatalogNoConfusionUxAcceptancePacket {
  return buildCatalogNoConfusionUxAcceptancePacket({
    environment: "staging",
    generatedAt: "2026-06-11T00:00:00.000Z",
    signoff: {
      owner: "catalog-source-observations",
      reviewer: "catalog-release-lead",
      approvedAt: "2026-06-11T00:00:00.000Z",
      approvalReference: "https://github.com/chase-sets/chase-sets/issues/1047#issuecomment-launch-gate",
      checklistVersion: catalogNoConfusionUxAcceptanceChecklistVersion,
    },
  });
}
