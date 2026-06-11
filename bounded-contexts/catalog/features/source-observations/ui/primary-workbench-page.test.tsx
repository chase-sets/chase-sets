// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import { tcgdexPokemonTcgProviderProfile } from "../api/provider-integration-profiles";
import { catalogProviderProfileEditableSectionKeys } from "../api/provider-profile-section-registry";
import { buildCatalogPrimaryWorkbenchReadModel } from "./primary-workbench-read-model";
import { CatalogPrimaryWorkbenchPage } from "./primary-workbench-page";
import {
  controlPlaneOverview,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "./primary-workbench-test-fixtures";

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("CatalogPrimaryWorkbenchPage", () => {
  afterEach(() => {
    cleanup();
    window.history.pushState({}, "", "/catalog/integrations");
  });

  it("puts provider import, Source Observation review, and promotion ahead of support workflows", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(
      screen.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Pull provider data/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("cell", { name: /Review Source Observations/i })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /Preview Catalog promotion impact/i })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /Promote into Catalog Items/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Promotion command plan" })).toBeTruthy();
    expect(screen.getByText("Matching filtered observations")).toBeTruthy();
    expect(screen.getByText("Reject requires a reason")).toBeTruthy();
    expect(screen.getByText("Defer keeps observations in review")).toBeTruthy();
    expect(screen.getByText("Reapply uses current active profile")).toBeTruthy();
    expect(screen.getByText("Replay uses original source profile version")).toBeTruthy();
    expect(
      screen.getByText("Rejects stale observation, profile, rollout, permission, and command input changes"),
    ).toBeTruthy();

    const navigation = screen.getByRole("navigation", { name: "Catalog control plane workflows" });
    expect(within(navigation).getByText("Primary workflow")).toBeTruthy();
    expect(within(navigation).getByText("Unblock provider data")).toBeTruthy();
    expect(within(navigation).getByText("Govern and recover")).toBeTruthy();
    expect(within(navigation).getByText("Verify release evidence")).toBeTruthy();
    expect(screen.queryByText("Old integrations surface")).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("honors a direct supporting workflow section without changing the default primary route", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=triage",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("link", { name: /Health triage/i }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Integration health triage" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Import to promotion workbench/i }).getAttribute("href")).toContain(
      "/catalog/integrations?",
    );
  });

  it("renders dense health triage with distinct semantic, transport, rollout, job, and audit evidence", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=triage",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: healthTriageStressOverview(),
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Integration health triage" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to import workbench" }).getAttribute("href")).toContain(
      "section=workbench",
    );
    expect(screen.getAllByText("Catalog semantic readiness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Provider transport readiness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCGdex semantic mapping").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCGdex sealed import").length).toBeGreaterThan(0);
    expect(screen.getAllByText("catalog.integration.semantic_readiness.blocked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("catalog.integration.provider_transport.blocked").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Resolve Catalog semantic mapping readiness before previewing promotion/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Fix provider adapter transport or wait for retry recovery/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Provider pagination cursor failed after page 18/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Catalog integration imports stopped by launch kill switch/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/ops-release owns catalog.integration.rollout.stop; issue #801/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("import job job_failed failed after provider pagination drift.").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/Open the durable job evidence, resolve the failure group/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("import-job-started").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Provider import started for health triage.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Provider import operations" })).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("renders governance controls with RBAC, kill switches, observability, and complete-removal evidence", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=controls",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: healthTriageStressOverview(),
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("link", { name: /Governance controls/i }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Governance controls" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Rollout and worker controls" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "RBAC action matrix" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Operational observability" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retired compatibility removal" })).toBeTruthy();
    expect(screen.getAllByText("Provider emergency stop").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Worker pause/resume state").length).toBeGreaterThan(0);
    expect(screen.getAllByText("catalog.integration.rollout.stop").length).toBeGreaterThan(0);
    expect(screen.getAllByText("issue #801").length).toBeGreaterThan(0);
    expect(screen.getAllByText("start-provider-import").length).toBeGreaterThan(0);
    expect(screen.getAllByText("execute-promotion").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Alert catalog.integration.jobs.failure_rate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Runbook Projection freshness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Payload escape hatch").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Broad patch compatibility").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/documentation, runbooks, release notes, and operator instructions/i).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/holding area/i)).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("renders profile authoring overview and draft creation as a focused support workspace", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=profile-work",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Provider profile authoring" })).toBeTruthy();
    expect(screen.getByText("Selected profile is ready")).toBeTruthy();
    expect(screen.getAllByText("TCGdex Pokemon cards").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex-pokemon-card@2026.06.04").length).toBeGreaterThan(0);
    expect(screen.getByText("Draft required for active profiles")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Guided section workspaces" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Profile section groups" })).toBeTruthy();
    expect(screen.getByLabelText("Profile section")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Save section" })).toHaveLength(
      catalogProviderProfileEditableSectionKeys.length,
    );
    expect(screen.getByText("Immutable identity facts")).toBeTruthy();
    expect(screen.getByLabelText("Draft profile version")).toHaveProperty("value", "2026.06.04-draft");
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false);

    const draftForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="clone-provider-profile"]',
    );
    expect(draftForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("clone-provider-profile");
    expect(draftForm?.querySelector<HTMLInputElement>('input[name="sourceProviderKey"]')?.value).toBe("tcgdex");
    expect(draftForm?.querySelector<HTMLInputElement>('input[name="sourceProfileVersion"]')?.value).toBe("2026.06.04");
    expect(draftForm?.getAttribute("action")).toContain("section=profile-work");
    expect(screen.queryByRole("heading", { name: "Provider import operations" })).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
    expect(screen.queryByText(/Profile JSON|Candidate JSON|Active JSON/i)).toBeNull();
  });

  it("renders validation readiness as a focused fixture, dry-run, compare, and activation workspace", () => {
    const profile = profileReview({
      active: true,
      lifecycle: "active",
      executableMappingContract: jsonClone(tcgdexPokemonCardSourceObservationMappingContract),
      profile: {
        providerKey: "tcgdex",
        supportedScopes: ["pokemon/card"],
        selectedOptionMapping: {
          dimensions: [
            {
              dimensionKey: "foil-treatment",
              sourcePath: "card.variant.displayName",
            },
          ],
        },
      },
      fixtures: {
        fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
        coveredFlows: [
          "normal",
          "partial",
          "stale",
          "changed",
          "ambiguous",
          "replay",
          "sealed-product",
          "unknown-option",
        ],
        liveProviderCallsAllowed: false,
      },
    });
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04&section=readiness",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({ review: profile }),
      controlPlaneOverview: {
        ...overview,
        readiness: {
          ...overview.readiness,
          units: [
            {
              ...overview.readiness.units[0],
              dryRunEvidence: [
                {
                  externalKey: "en:sv01-001",
                  sourceUrl: "fixture://tcgdex/normal.json",
                  sourceHash: "sha256:tcgdex-normal",
                  normalizedFacts: {
                    name: "Sprigatito",
                    cardNumber: "001",
                    cardVariantKey: "standard",
                  },
                },
              ],
            },
          ],
        },
      },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Validation readiness" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Fixture flow proof" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Dry-run evidence" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Semantic compare" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Activation readiness" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Activation decision" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Migration evidence" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Fixture run" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save migration evidence" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Activate profile" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Migration evidence missing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reference impact review required").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open audit evidence" }).getAttribute("href")).toContain(
      "section=evidence",
    );
    expect(screen.getAllByText(/Sprigatito/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/sha256:candidate-mapping/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Changes the card variant merge identity.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Promotion Plan").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Back to import workbench" }).getAttribute("href")).toContain(
      "section=workbench",
    );

    const migrationEvidenceForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-validation-evidence-form="true"]',
    );
    expect(migrationEvidenceForm?.getAttribute("action")).toContain("section=readiness");
    expect(migrationEvidenceForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "update-provider-profile-section",
    );
    expect(migrationEvidenceForm?.querySelector<HTMLInputElement>('input[name="sectionKey"]')?.value).toBe(
      "migration-evidence",
    );
    expect(migrationEvidenceForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(migrationEvidenceForm?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe(
      "2026.06.04",
    );

    const activationForm = document.querySelector<HTMLFormElement>('form[data-catalog-activate-profile-form="true"]');
    expect(activationForm?.getAttribute("action")).toContain("section=readiness");
    expect(activationForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "activate-provider-profile",
    );
    expect(activationForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(activationForm?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe("2026.06.04");

    fireEvent.click(screen.getAllByRole("button", { name: "Inspect proof" })[0]!);

    expect(screen.getByRole("heading", { name: "Duplicate candidates" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Selected options" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Promotion command preview" })).toBeTruthy();
    expect(screen.getByText("Option dimension: foil-treatment")).toBeTruthy();
    expect(screen.getAllByText("CreateCatalogItem").length).toBeGreaterThan(0);
    expect(screen.getByText("Payload body")).toBeTruthy();
    expect(screen.getByText("not retained")).toBeTruthy();
    expect(screen.queryByText(/raw JSON|Profile JSON|Candidate JSON|Active JSON/i)).toBeNull();
  });

  it("renders lifecycle recovery with rollback, deprecation, retirement, and complete-removal evidence", () => {
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04&section=lifecycle",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: true, lifecycle: "active", referenceCount: 2 })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          ...overview.unitActivity,
          units: overview.unitActivity.units.map((unit) => ({ ...unit, recentJobs: [] })),
        },
      },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Lifecycle recovery" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open activation readiness" }).getAttribute("href")).toContain(
      "section=readiness",
    );
    expect(screen.getByRole("heading", { name: "Rollback profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Deprecate profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retire profile" })).toBeTruthy();
    expect(screen.getByText("Retire means complete removal")).toBeTruthy();
    expect(screen.getAllByText(/complete removal of code, product patterns/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Profile retirement references").length).toBeGreaterThan(0);

    const rollbackForm = document.querySelector<HTMLFormElement>('form[data-catalog-lifecycle-command="rollback"]');
    const deprecateForm = document.querySelector<HTMLFormElement>('form[data-catalog-lifecycle-command="deprecate"]');
    const retireForm = document.querySelector<HTMLFormElement>('form[data-catalog-lifecycle-command="retire"]');

    expect(rollbackForm?.getAttribute("action")).toContain("section=lifecycle");
    expect(deprecateForm?.getAttribute("action")).toContain("section=lifecycle");
    expect(retireForm?.getAttribute("action")).toContain("section=lifecycle");
    expect(rollbackForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "rollback-provider-profile",
    );
    expect(deprecateForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "deprecate-provider-profile",
    );
    expect(retireForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("retire-provider-profile");
    expect(screen.getByLabelText(/I confirm rollback profile impact and audit evidence/i)).toBeTruthy();
    expect(screen.getByLabelText(/I confirm deprecate profile impact and audit evidence/i)).toBeTruthy();
    expect(
      screen.getByLabelText(/I confirm retirement means complete removal and all impact evidence is clear/i),
    ).toBeTruthy();
    expect(retireForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(retireForm?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe("2026.06.04");
    expect(screen.queryByText(/raw JSON|Profile JSON|Candidate JSON|Active JSON/i)).toBeNull();
  });

  it("renders conflict resolution as a focused evidence workspace without exposing compatibility overrides", () => {
    const baseObservation = sourceObservationListItem({
      observation_id: "obs_conflict",
      promoted_catalog_item_id: "cat_001",
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_conflict&promotionPreviewId=preview_001&section=conflicts",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        auditLifecycle: {
          ...controlPlaneOverview().auditLifecycle,
          entries: [
            {
              eventId: "aud_conflict_001",
              occurredAt: "2026-06-09T01:05:00.000Z",
              eventName: "profile-section-edited",
              category: "profile-section",
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:card:import",
              profileVersion: "2026.06.04",
              actorUserId: "user_admin",
              relatedJobId: null,
              summary: "Promotion mapping reviewed for conflicting Catalog item.",
              diagnosticCodes: [],
            },
          ],
        },
      }),
      reviewObservations: {
        items: [
          {
            ...baseObservation,
            normalized: {
              ...baseObservation.normalized,
              mergeIdentity: undefined,
              externalCatalogItemReferences: [],
            },
          },
        ],
        total: 1,
        count: 1,
      },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("link", { name: /Conflict resolution/i }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Conflict resolution" })).toBeTruthy();
    expect(screen.getByText("Conflicts are blocking promotion")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Fact conflicts" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Precedence rules" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Override policy" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Conflict audit evidence" })).toBeTruthy();
    expect(screen.getAllByText("promotion-command.conflict-blocking.v1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Promotion blocking").length).toBeGreaterThan(0);
    expect(screen.getByText("Overrides fail closed until rebuilt")).toBeTruthy();
    expect(screen.getByText(/compatibility override paths are retired/i)).toBeTruthy();
    expect(screen.getAllByText("Promotion mapping reviewed for conflicting Catalog item.").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Back to import workbench" }).getAttribute("href")).toContain(
      "section=workbench",
    );
    expect(screen.queryByText(/raw JSON|Profile JSON|Candidate JSON|Active JSON/i)).toBeNull();
  });

  it("renders option-query, import-scope, and mapping authoring detail panels without reviving raw profile editors", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [
          profileReview({
            active: false,
            lifecycle: "draft",
            profileVersion: "2026.06.04-draft",
            profile: jsonClone(tcgdexPokemonTcgProviderProfile),
            executableMappingContract: jsonClone(tcgdexPokemonCardSourceObservationMappingContract),
            capabilities: [...tcgdexPokemonTcgProviderProfile.capabilities],
            supportedScopes: [...tcgdexPokemonTcgProviderProfile.supportedScopes],
            languageOptions: [...tcgdexPokemonTcgProviderProfile.languageOptions],
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview({
        providerReadiness: {
          ...baseOverview.providerReadiness,
          providers: [
            {
              ...baseOverview.providerReadiness.providers[0]!,
              optionQueryHealth: {
                status: "degraded",
                diagnosticCodes: ["provider-option-query-stale-cache-used"],
                message: "Stale provider option query cache used during adapter recovery.",
              },
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Provider option queries" })).toBeTruthy();
    expect(screen.getAllByText("tcgdex-list-expansions").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex-expansion-card-count").length).toBeGreaterThan(0);
    expect(screen.getAllByText("symbolUrl").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Option queries degraded").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Stale provider option query cache used/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Import-scope controls" })).toBeTruthy();
    expect(screen.getAllByText("Product / Card").length).toBeGreaterThan(0);
    expect(screen.getAllByText("en:3:base:base1").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Mapping expression rows" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Observation id").length).toBeGreaterThan(0);
    expect(screen.getAllByText("catalog-merge-evidence").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Preview").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Duplicate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reorder").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Remove").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Inline diagnostics").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Long paths").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Profile JSON|Candidate JSON|Active JSON|raw JSON/i)).toBeNull();
  });

  it("renders section forms as editable typed controls for draft profiles", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    const forms = document.querySelectorAll<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="update-provider-profile-section"]',
    );
    expect(forms).toHaveLength(catalogProviderProfileEditableSectionKeys.length);

    const basics = document.querySelector<HTMLElement>('[data-catalog-profile-section-workspace="basics"]');
    expect(within(basics!).getByLabelText("Display name")).toHaveProperty("value", "TCGdex Pokemon cards");
    expect(within(basics!).getByRole("button", { name: "Save section" }).hasAttribute("disabled")).toBe(false);
    expect(basics?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "update-provider-profile-section",
    );
    expect(basics?.querySelector<HTMLInputElement>('input[name="sectionKey"]')?.value).toBe("basics");
    expect(basics?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe("2026.06.04-draft");
    expect(screen.queryByRole("textbox", { name: /raw json/i })).toBeNull();
  });

  it("keeps profile overview inspectable but disables draft creation for view-only operators", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: false,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Provider profile authoring" })).toBeTruthy();
    expect(screen.getAllByText("TCGdex Pokemon cards").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Permission denied").length).toBeGreaterThan(0);
    expect(
      screen.getByText("View-only operators can inspect profile evidence but cannot create draft profiles."),
    ).toBeTruthy();
  });

  it("renders stale selected-profile state without falling back to another version", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=missing-version",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByText("Profile selection is stale")).toBeTruthy();
    expect(screen.getByText("Select an available version")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Selected profile is ready")).toBeNull();
  });

  it("opens health triage from mobile workflow navigation without burying the primary provider pull", () => {
    window.history.pushState(
      {},
      "",
      "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&section=workbench",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: window.location.href,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: healthTriageStressOverview(),
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.queryByRole("heading", { name: "Integration health triage" })).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Choose Catalog workflow" }), {
      target: { value: "health-triage" },
    });

    expect(screen.getByRole("heading", { name: "Integration health triage" })).toBeTruthy();
    expect(window.location.pathname).toBe("/catalog/integrations");
    expect(window.location.search).toContain("section=triage");
    expect(window.location.search).toContain("providerKey=tcgdex");
    expect(window.location.search).toContain("unitKey=tcgdex%3Apokemon%3Acard%3Aimport");
    expect(screen.getAllByRole("button", { name: /Pull provider data/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Import to promotion workbench" })).toBeNull();
  });

  it("opens profile authoring from mobile workflow navigation while preserving provider context", () => {
    window.history.pushState(
      {},
      "",
      "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&section=workbench",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: window.location.href,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Choose Catalog workflow" }), {
      target: { value: "profile-authoring" },
    });

    expect(screen.getByRole("heading", { name: "Provider profile authoring" })).toBeTruthy();
    expect(window.location.pathname).toBe("/catalog/integrations");
    expect(window.location.search).toContain("section=profile-work");
    expect(window.location.search).toContain("providerKey=tcgdex");
    expect(window.location.search).toContain("unitKey=tcgdex%3Apokemon%3Acard%3Aimport");
    expect(window.location.search).toContain("filter.status=changed");
    expect(screen.getAllByRole("button", { name: /Pull provider data/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Provider import operations" })).toBeNull();
  });

  it("updates the browser URL from mobile workflow navigation while preserving route context", () => {
    window.history.pushState(
      {},
      "",
      "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&section=workbench",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: window.location.href,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Choose Catalog workflow" }), {
      target: { value: "audit-evidence" },
    });

    const auditEvidenceLink = screen
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.includes("section=evidence"));
    expect(auditEvidenceLink?.getAttribute("aria-current")).toBe("page");
    expect(window.location.pathname).toBe("/catalog/integrations");
    expect(window.location.search).toContain("section=evidence");
    expect(window.location.search).toContain("providerKey=tcgdex");
    expect(window.location.search).toContain("unitKey=tcgdex%3Apokemon%3Acard%3Aimport");
    expect(window.location.search).toContain("filter.status=changed");
    expect(window.location.search).toContain("returnPath=");
  });

  it("renders scoped durable import monitoring without hiding the primary provider pull", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Provider import operations" })).toBeTruthy();
    expect(screen.getByText("Expected observations")).toBeTruthy();
    expect(screen.getAllByText("142").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getAllByText("import job job_001 is running (7/24).").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7/24 work units, 29% complete").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Pull provider data/i })[0]?.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("button", { name: "Cancel" }).length).toBeGreaterThan(0);

    const cancelForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="cancel-import-job"]',
    );
    expect(cancelForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("cancel-import-job");
    expect(cancelForm?.querySelector<HTMLInputElement>('input[name="jobId"]')?.value).toBe("job_001");

    const reviewLinks = screen.getAllByRole("link", { name: "Review observations" });
    expect(reviewLinks.some((link) => link.getAttribute("href")?.includes("section=source-observation-review"))).toBe(
      true,
    );
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("renders provider transport blockers with operator reason and next step copy", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              transportReadiness: "blocked",
              diagnostics: [
                {
                  code: "provider-timeout",
                  severity: "error",
                  message: "Provider timeout while fetching payloads.",
                  unitKey: "tcgdex:pokemon:card:import",
                  retryAfterSeconds: null,
                  source: "provider-adapter",
                },
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getAllByText("Provider timeout").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/The adapter timed out before receiving a complete provider response/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Next: Retry the provider pull after checking health triage/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("provider-transport-timeout")).toBeNull();
  });

  it("renders Source Observation evidence rows, drawer details, and bulk selection without raw payloads", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: {
        items: [
          sourceObservationListItem({
            normalized: {
              ...sourceObservationListItem().normalized,
              name: "A very long provider supplied Charizard display name with release diagnostics attached",
            },
            status_reason: "Provider changed rarity evidence during the latest pull.",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();
    expect(screen.getAllByText(/A very long provider supplied Charizard/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Provider payload withheld; normalized facts and provenance are redaction-safe.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", {
        name: /Preview promotion: A very long provider supplied Charizard/i,
      }).length,
    ).toBeGreaterThan(0);

    const reviewModule = screen.getByRole("heading", { name: "Source Observation review" }).closest("section");
    expect(reviewModule).toBeTruthy();
    const checkbox = within(reviewModule as HTMLElement).getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);

    expect(screen.getByText("1 observation(s) selected")).toBeTruthy();

    const evidenceButtons = screen.getAllByRole("button", { name: "Evidence" });
    fireEvent.click(evidenceButtons[evidenceButtons.length - 1]!);

    expect(screen.getByText(/Source provenance, normalized facts/)).toBeTruthy();
    expect(screen.getByText("Provider changed rarity evidence during the latest pull.")).toBeTruthy();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("submits primary workbench commands with clean intent and selected-observation context", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    const importForm = document.querySelector('form[data-catalog-primary-workbench-command="start-provider-import"]');
    expect(importForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("start-provider-import");
    expect(importForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(importForm?.getAttribute("action")).toContain("/catalog/integrations?");
    expect(importForm?.getAttribute("action")).not.toMatch(/raw-json|legacy|compat/i);

    const reviewModule = screen.getByRole("heading", { name: "Source Observation review" }).closest("section");
    const checkbox = within(reviewModule as HTMLElement).getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);

    const selectedPreviewForm = Array.from(
      document.querySelectorAll<HTMLFormElement>('form[data-catalog-primary-workbench-command="preview-promotion"]'),
    ).find((form) => form.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value === "obs_001");
    const rejectForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="reject-source-observations"]',
    );
    const deferForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="defer-source-observations"]',
    );

    expect(selectedPreviewForm).toBeTruthy();
    expect(rejectForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe("obs_001");
    expect(rejectForm?.querySelector<HTMLInputElement>('input[name="reason"]')?.required).toBe(true);
    expect(deferForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe("obs_001");
    expect(deferForm?.querySelector<HTMLInputElement>('input[name="reason"]')?.value).toBe(
      "Deferred from the primary workbench; observation remains in review.",
    );
  });

  it("submits reapply and replay commands for promoted Source Observations as durable jobs", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=promoted",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "obs_promoted",
            status: "promoted",
            promoted_catalog_item_id: "cat_001",
            promoted_at: "2026-06-09T01:05:00.000Z",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    const reapplyForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-reapply"]',
    );
    const replayForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-replay"]',
    );

    expect(reapplyForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("start-reapply");
    expect(reapplyForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe(
      "obs_promoted",
    );
    expect(replayForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("start-replay");
    expect(replayForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe(
      "obs_promoted",
    );
  });

  it("keeps replay available for promoted Source Observations when the current active profile is missing", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=promoted",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: false, lifecycle: "retired" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "obs_promoted",
            status: "promoted",
            promoted_catalog_item_id: "cat_001",
            promoted_at: "2026-06-09T01:05:00.000Z",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(
      screen.getAllByRole("button", { name: /Reapply: Charizard/i }).every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      screen.getAllByRole("button", { name: /Replay: Charizard/i }).every((button) => button.hasAttribute("disabled")),
    ).toBe(false);

    const replayForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-replay"]',
    );
    expect(replayForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe(
      "obs_promoted",
    );
  });

  it("blocks replay for promoted Source Observations with missing original profile evidence", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=promoted",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "obs_promoted",
            status: "promoted",
            source_profile_version: "",
            promoted_catalog_item_id: "cat_001",
            promoted_at: "2026-06-09T01:05:00.000Z",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(
      screen.getAllByRole("button", { name: /Replay: Charizard/i }).every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getAllByText("Profile version missing").length).toBeGreaterThan(0);
  });

  it("renders explicit-row command scope and stale-preview blockers before promotion execution", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.03&filter.status=changed&selectedObservationIds=obs_missing&promotionPreviewId=preview_old",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Promotion command plan" })).toBeTruthy();
    expect(screen.getByText("Explicit selected observations")).toBeTruthy();
    expect(screen.getAllByText("Stale").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale promotion preview").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("button", { name: "Promote Catalog facts" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("clears route-provided Source Observation selections when the review context changes", async () => {
    const selectedReadModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_001",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });
    const clearedReadModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    const { rerender } = render(<CatalogPrimaryWorkbenchPage readModel={selectedReadModel} />);

    expect(screen.getByText("1 observation(s) selected")).toBeTruthy();

    rerender(<CatalogPrimaryWorkbenchPage readModel={clearedReadModel} />);

    await waitFor(() => {
      expect(screen.queryByText("1 observation(s) selected")).toBeNull();
    });
  });

  it("renders denied row actions without exposing provider bypass controls", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      canManageCatalog: false,
    });

    render(<CatalogPrimaryWorkbenchPage readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();
    expect(
      screen
        .getAllByRole("button", { name: /Preview promotion: Charizard/i })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getAllByText("Permission denied").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/This operator account cannot run the requested Catalog command/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Next: Ask an admin to grant catalog.manage/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/all providers/i)).toBeNull();
  });
});

function healthTriageStressOverview() {
  const baseOverview = controlPlaneOverview();
  const semanticUnitKey = "tcgdex:pokemon:card:import";
  const transportUnitKey = "tcgdex:pokemon:sealed:import";
  const longProviderDiagnostic =
    "Provider pagination cursor failed after page 18 while acquiring payloads; retry only after the adapter can resume without duplicating Source Observations.";
  const baseUnit = baseOverview.readiness.units[0]!;
  const baseJob = baseOverview.unitActivity.units[0]!.recentJobs[0]!;

  return controlPlaneOverview({
    readiness: {
      ...baseOverview.readiness,
      rolloutControls: {
        generatedAt: baseOverview.generatedAt,
        controls: [
          {
            controlId: "catalog-import-launch-stop",
            owner: "ops-release",
            ownerIssue: 801,
            defaultState: "quarantined",
            status: "blocked",
            severity: "error",
            capabilities: ["source-observation-import"],
            providerKeys: ["tcgdex"],
            profileKeys: ["tcgdex-pokemon-card"],
            unitKeys: [transportUnitKey],
            message: "Catalog integration imports stopped by launch kill switch.",
            auditEventName: "rollout-control-denied",
            metricKey: "catalog.integration.rollout.stop",
          },
        ],
      },
      units: [
        {
          ...baseUnit,
          unitKey: semanticUnitKey,
          displayName: "TCGdex semantic mapping",
          semanticReadiness: "blocked",
          fixtureValidationStatus: "blocked",
          dryRunStatus: "blocked",
          diagnosticCounts: { info: 0, warning: 1, error: 1 },
          diagnostics: [
            {
              code: "semantic-mapping-blocked",
              severity: "error",
              message: "Catalog semantic mapping is missing collector number evidence.",
              unitKey: semanticUnitKey,
              retryAfterSeconds: null,
              source: "catalog",
            },
            {
              code: "dry-run-evidence-missing",
              severity: "warning",
              message: "Dry-run evidence must be completed before promotion preview.",
              unitKey: semanticUnitKey,
              retryAfterSeconds: null,
              source: "catalog",
            },
          ],
          latestDiagnosticText: "Catalog semantic mapping is missing collector number evidence.",
        },
        {
          ...baseUnit,
          unitKey: transportUnitKey,
          displayName: "TCGdex sealed import",
          productForm: "sealed",
          transportReadiness: "blocked",
          diagnosticCounts: { info: 0, warning: 0, error: 1 },
          diagnostics: [
            {
              code: "provider-pagination-failed",
              severity: "error",
              message: longProviderDiagnostic,
              unitKey: transportUnitKey,
              retryAfterSeconds: 300,
              source: "provider-adapter",
            },
          ],
          latestDiagnosticText: longProviderDiagnostic,
        },
      ],
    },
    unitActivity: {
      generatedAt: baseOverview.generatedAt,
      units: [
        {
          unitKey: semanticUnitKey,
          recentJobs: [
            {
              ...baseJob,
              jobId: "job_failed",
              phase: "failed",
              operatorStatus: "failed",
              completed: 18,
              total: 24,
              summary: "import job job_failed failed after provider pagination drift.",
              unitKey: semanticUnitKey,
              providerKey: "tcgdex",
              importScope: "en:3:base:base1",
            },
            {
              ...baseJob,
              jobId: "job_running",
              completed: 4,
              total: 24,
              summary: "import job job_running is running with launch diagnostics.",
              unitKey: semanticUnitKey,
              providerKey: "tcgdex",
              importScope: "en:3:base:base1",
            },
          ],
        },
      ],
    },
    providerReadiness: {
      generatedAt: baseOverview.generatedAt,
      providers: [
        {
          ...baseOverview.providerReadiness.providers[0]!,
          readiness: "degraded",
          unitKeys: [semanticUnitKey, transportUnitKey],
          rateLimitStatus: {
            status: "degraded",
            diagnosticCodes: ["provider-rate-limit"],
            message: "Provider rate limit is cooling down.",
          },
          payloadAcquisition: {
            status: "blocked",
            diagnosticCodes: ["provider-pagination-failed"],
            message: longProviderDiagnostic,
          },
          diagnostics: [
            {
              code: "provider-pagination-failed",
              severity: "error",
              message: longProviderDiagnostic,
              unitKey: transportUnitKey,
              retryAfterSeconds: 300,
              source: "provider-adapter",
            },
          ],
        },
      ],
    },
    auditLifecycle: {
      generatedAt: baseOverview.generatedAt,
      projectionStatus: "partial",
      statusMessage: "Audit lifecycle projection is partial while health triage is live.",
      entries: [
        {
          eventId: "aud_health_001",
          occurredAt: "2026-06-09T01:02:00.000Z",
          eventName: "import-job-started",
          category: "import-job",
          providerKey: "tcgdex",
          unitKey: semanticUnitKey,
          profileVersion: "2026.06.04",
          actorUserId: "user_admin",
          relatedJobId: "job_running",
          summary: "Provider import started for health triage.",
          diagnosticCodes: ["provider-pagination-failed"],
        },
      ],
    },
  });
}
