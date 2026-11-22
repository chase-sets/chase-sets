// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../primary-workbench-route-context";
import { CatalogIntegrationCommandActionProvider } from "../../import-to-promotion/command-action-context";
import { CatalogIntegrationLanguageEditionsPanel } from "./language-editions-panel";
import { buildCatalogScopeLanguageEditionReviewReadModel } from "../../../../../scope-registry/api/scope-journey";
import type { CatalogAliasReviewCandidateSummary } from "../../../../../alias-equivalence/api/alias-review-admin-contracts";

afterEach(cleanup);

const ACTION_HREF = "/catalog/scopes/scope_expansion_paldean_fates";

function renderPanel(
  readModel: ReturnType<typeof buildCatalogScopeLanguageEditionReviewReadModel>,
  props: Partial<Omit<ComponentProps<typeof CatalogIntegrationLanguageEditionsPanel>, "readModel">> = {},
) {
  return render(
    <CatalogIntegrationCommandActionProvider actionPath={ACTION_HREF}>
      <CatalogIntegrationLanguageEditionsPanel readModel={readModel} routeContext={null} {...props} />
    </CatalogIntegrationCommandActionProvider>,
  );
}
const REFERENCE_RECORD_ID = "ref_expansion_paldean_fates";

function candidate(overrides: Partial<CatalogAliasReviewCandidateSummary> = {}): CatalogAliasReviewCandidateSummary {
  return {
    aliasHash: "hash_ja_set_equivalent",
    targetKind: "reference-record",
    targetId: REFERENCE_RECORD_ID,
    targetKey: "expansion",
    nativePrintedName: "シャイニートレジャーex",
    nativeLanguageCode: "ja",
    proposedAlias: "シャイニートレジャーex",
    aliasLanguageCode: "ja",
    aliasType: "set-equivalent",
    confidence: "high",
    reviewStatus: "pending",
    sourceCategory: "provider-same-id-localized-endpoint",
    providerKey: "tcgdex",
    observationId: "obs_paldean_fates_ja",
    sourceProfileKey: "pokemon-tcg",
    sourceProfileVersion: "2026.06.03",
    evidence: [],
    warnings: [],
    autoAccept: {
      eligible: false,
      governedReviewState: "pending",
      official: false,
      policyVersion: "alias-source-governance-v1",
      reasons: ["Provider same-id localized endpoint requires operator review before becoming official."],
    },
    reviewable: true,
    availableActions: ["alias.accept", "alias.reject", "alias.defer"],
    firstObservedAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

const scope = {
  scopeRecordId: "scope_expansion_paldean_fates",
  referenceRecordId: REFERENCE_RECORD_ID,
  languageEditions: ["en", "ja"],
};

describe("CatalogIntegrationLanguageEditionsPanel", () => {
  it("shows both editions for a scope imported in en+ja, with the pending ja candidate visible", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      candidates: [candidate()],
    });

    renderPanel(readModel);

    expect(screen.getByText(/EN/)).toBeTruthy();
    expect(screen.getByText(/JA/)).toBeTruthy();
    expect(screen.getByText("シャイニートレジャーex")).toBeTruthy();
    // Auto-accept posture surfaced.
    expect(
      screen.getByText("Provider same-id localized endpoint requires operator review before becoming official."),
    ).toBeTruthy();
  });

  it("posts the accept intent with the candidate's alias hash to the owning page", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      candidates: [candidate()],
    });

    renderPanel(readModel);

    const acceptForm = document.querySelector('form[data-language-edition-command="alias.accept"]');
    expect(acceptForm).not.toBeNull();
    expect(acceptForm?.getAttribute("action")).toBe(ACTION_HREF);
    const hiddenIntent = acceptForm?.querySelector('input[name="_intent"]');
    expect(hiddenIntent?.getAttribute("value")).toBe("alias.accept");
    const hiddenHashes = acceptForm?.querySelector('input[name="aliasHashes"]');
    expect(hiddenHashes?.getAttribute("value")).toBe("hash_ja_set_equivalent");
  });

  it("posts accept and reject to the owning page with its current journey context", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      aliasReview: aliasReview([candidate()]),
    });
    const routeContext = parseCatalogPrimaryWorkbenchRouteContext(
      `https://admin.example${ACTION_HREF}?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&reviewOffset=25&filter.status=eligible&selectedObservationIds=obs_001`,
    );

    renderPanel(readModel, { routeContext });

    for (const command of ["alias.accept", "alias.reject"]) {
      const action = new URL(
        document.querySelector(`form[data-language-edition-command="${command}"]`)?.getAttribute("action") ?? "",
        "https://admin.example",
      );
      expect(action.pathname, command).toBe(ACTION_HREF);
      expect(parseCatalogPrimaryWorkbenchRouteContext(action), command).toMatchObject({
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        reviewOffset: 25,
        sourceObservationFilters: { status: "eligible" },
        selectedObservationIds: ["obs_001"],
      });
    }
  });

  it("fails closed without an owning page", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      aliasReview: aliasReview([candidate()]),
    });

    expect(() =>
      renderToString(<CatalogIntegrationLanguageEditionsPanel readModel={readModel} routeContext={null} />),
    ).toThrow("Catalog integration controls require an owning page action path.");
  });

  it("requires a reason for reject and revoke actions", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      candidates: [candidate()],
    });

    renderPanel(readModel);

    const rejectForm = document.querySelector('form[data-language-edition-command="alias.reject"]');
    const reasonInput = rejectForm?.querySelector('input[name="reason"]');
    expect(reasonInput?.hasAttribute("required")).toBe(true);
  });

  it("offers revoke for an already-linked (accepted) edition candidate", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      candidates: [candidate({ reviewStatus: "accepted", availableActions: ["alias.revoke"] })],
    });

    renderPanel(readModel);

    expect(document.querySelector('form[data-language-edition-command="alias.revoke"]')).not.toBeNull();
  });

  it("disables actions when the operator cannot manage aliases", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      candidates: [candidate()],
    });

    renderPanel(readModel, { canManageAliases: false });

    const acceptButton = within(
      document.querySelector('form[data-language-edition-command="alias.accept"]') as HTMLElement,
    ).getByRole("button") as HTMLButtonElement;
    expect(acceptButton.disabled).toBe(true);
  });

  it("renders no alias forms for the canonical english edition", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      candidates: [],
    });

    renderPanel(readModel);

    expect(document.querySelectorAll("form").length).toBe(0);
  });
});
