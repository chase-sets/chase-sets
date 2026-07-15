import { describe, expect, it } from "vitest";
import {
  assertCatalogNoConfusionUxAcceptancePacketIsComplete,
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
} from "../api/primary-workbench-admin-contracts";

describe("Catalog integration no-confusion UX acceptance gate", () => {
  it("builds a complete packet for the rebuilt import-to-promotion first slice", () => {
    const packet = safePacket();

    expect(packet).toMatchObject({
      schemaVersion: catalogNoConfusionUxAcceptanceSchemaVersion,
      checklistVersion: catalogNoConfusionUxAcceptanceChecklistVersion,
      telemetry: {
        primaryJourneyEventsRecorded: true,
        supportDetourMetricPathCovered: true,
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
      "observation.promote",
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

  it("fails closed when packet metadata or checklist coverage is incomplete", () => {
    const missingMetadata = {
      ...safePacket(),
      generatedAt: "",
      environment: "",
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(missingMetadata)).toThrow(
      "Catalog no-confusion UX acceptance packet must include the generated timestamp.",
    );

    const duplicateChecklist = {
      ...safePacket(),
      checklist: [...safePacket().checklist, safePacket().checklist[0]],
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(duplicateChecklist)).toThrow(
      "Catalog no-confusion UX acceptance checklist mismatch.",
    );
  });

  it("fails closed when the primary workflow matrix loses a step or preserves a current-page artifact", () => {
    const missingWorkflow = {
      ...safePacket(),
      workflows: safePacket().workflows.filter((workflow) => workflow.key !== "observation.promote"),
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(missingWorkflow)).toThrow(
      "Catalog no-confusion UX workflow matrix mismatch.",
    );

    const wrongPrimaryStep = {
      ...safePacket(),
      workflows: safePacket().workflows.map((workflow) =>
        workflow.key === "pull-provider-data" ? { ...workflow, primaryPathStep: 6 } : workflow,
      ),
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(wrongPrimaryStep)).toThrow(
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
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(oldPageArtifact)).toThrow(
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
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(viewOnlyWrites)).toThrow(
      "Catalog view-only acceptance must keep primary writes disabled.",
    );

    const missingAccessibility = {
      ...safePacket(),
      accessibility: safePacket().accessibility.filter((item) => item.key !== "keyboard-completion"),
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(missingAccessibility)).toThrow(
      "Catalog no-confusion UX accessibility matrix mismatch.",
    );

    const overlappingVisual = {
      ...safePacket(),
      visualQa: safePacket().visualQa.map((item) =>
        item.state === "dense-source-observation-table" ? { ...item, noOverlap: false } : item,
      ),
    } as unknown as CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(overlappingVisual)).toThrow(
      "Catalog no-confusion UX visual state 'dense-source-observation-table' is incomplete.",
    );

    const rawJsonResilience = {
      ...safePacket(),
      resilience: safePacket().resilience.map((item) =>
        item.key === "command-execution-failure" ? { ...item, rawJsonFallbackAvailable: true } : item,
      ),
    } as unknown as CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(rawJsonResilience)).toThrow(
      "Catalog no-confusion UX resilience check 'command-execution-failure' is incomplete.",
    );
  });

  it("fails closed when telemetry or provider-transport evidence is incomplete", () => {
    const missingTelemetryDimension = {
      ...safePacket(),
      telemetry: {
        ...safePacket().telemetry,
        dimensions: safePacket().telemetry.dimensions.filter((dimension) => dimension !== "route_context_preserved"),
      },
    } satisfies CatalogNoConfusionUxAcceptancePacket;
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(missingTelemetryDimension)).toThrow(
      "Catalog no-confusion UX telemetry dimensions mismatch.",
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
    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(missingBudget)).toThrow(
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

    expect(() => assertCatalogNoConfusionUxAcceptancePacketIsComplete(retainedLegacy)).toThrow(
      "Catalog no-confusion UX retirement evidence must prove complete deletion, not preserved compatibility.",
    );
  });
});

function safePacket(): CatalogNoConfusionUxAcceptancePacket {
  return buildCatalogNoConfusionUxAcceptancePacket({
    environment: "staging",
    generatedAt: "2026-06-11T00:00:00.000Z",
  });
}
