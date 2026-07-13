// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogIntegrationAliasReviewWorkspace } from "./alias-review-workspace";
import {
  buildCatalogAliasReviewReadModel,
  type CatalogAliasReviewFilter,
} from "../../../../../features/alias-equivalence/api/alias-review-admin-contracts";
import type {
  CatalogAliasCandidateRow,
  CatalogItemAliasRow,
} from "../../../../../features/alias-equivalence/read-model/queries";

afterEach(cleanup);

const ACTION_HREF = "/admin/integrations/alias-review";

const filter: CatalogAliasReviewFilter = {
  providerKey: "tcgdex",
  sourceProfileVersion: "2026.06.03",
  aliasType: null,
  reviewStatuses: [],
  observationId: null,
  targetKind: null,
  targetId: null,
};

function candidateRow(overrides: Partial<CatalogAliasCandidateRow> = {}): CatalogAliasCandidateRow {
  return {
    alias_hash: "hash_official",
    target_kind: "catalog-item",
    target_id: "cat_charizard",
    target_key: "name",
    alias_text: "Sprigatito",
    normalized_alias_text: "sprigatito",
    alias_language_code: "en",
    source_language_code: "ja",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "pending",
    provider_key: "tcgdex",
    observation_id: "obs_1",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    mapping_fingerprint: "fp-1",
    evidence: { providerId: "sv1a-001", evidenceKind: "card-id", nativeName: "ニャオハ" },
    first_observed_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function acceptedCardAlias(overrides: Partial<CatalogItemAliasRow> = {}): CatalogItemAliasRow {
  return {
    alias_hash: "hash_item",
    catalog_item_id: "cat_charizard",
    target_field: "name",
    alias_text: "Sprigatito",
    normalized_alias_text: "sprigatito",
    alias_language_code: "en",
    source_language_code: "ja",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "accepted",
    provider_key: "tcgdex",
    observation_id: "obs_1",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    mapping_fingerprint: "fp-1",
    evidence: {},
    last_actor: "usr_1",
    last_reason: null,
    policy_version: "alias-source-governance-v1",
    proposed_at: "2026-06-16T00:00:00.000Z",
    reviewed_at: "2026-06-16T01:00:00.000Z",
    updated_at: "2026-06-16T01:00:00.000Z",
    ...overrides,
  };
}

function readModel(input: {
  candidateRows?: readonly CatalogAliasCandidateRow[];
  catalogItemAliasRows?: readonly CatalogItemAliasRow[];
}) {
  return buildCatalogAliasReviewReadModel({
    generatedAt: "2026-06-16T00:00:00.000Z",
    filter,
    candidateRows: input.candidateRows ?? [],
    catalogItemAliasRows: input.catalogItemAliasRows ?? [],
    referenceRecordAliasRows: [],
  });
}

function renderWorkspace(input: Parameters<typeof readModel>[0], canManageAliases = true) {
  return render(
    <CatalogIntegrationAliasReviewWorkspace
      readModel={readModel(input)}
      actionHref={ACTION_HREF}
      canManageAliases={canManageAliases}
    />,
  );
}

describe("CatalogIntegrationAliasReviewWorkspace", () => {
  it("displays each candidate's proposed alias, native printed name, type, and source", () => {
    renderWorkspace({ candidateRows: [candidateRow()] });

    expect(screen.getAllByText("Sprigatito").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Native: ニャオハ").length).toBeGreaterThan(0);
    expect(screen.getAllByText("official-equivalent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex").length).toBeGreaterThan(0);
  });

  it("renders an empty state when there are no alias candidates", () => {
    renderWorkspace({ candidateRows: [] });
    expect(screen.getByText("No alias candidates")).toBeTruthy();
  });

  it("shows generated-translation and low-confidence warnings for risky candidates", () => {
    renderWorkspace({
      candidateRows: [
        candidateRow({
          alias_hash: "hash_generated",
          alias_type: "generated-translation",
          confidence: "generated",
          source_category: "machine-translation",
        }),
      ],
    });
    expect(screen.getAllByText("Generated translation").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Low-confidence evidence").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Never official").length).toBeGreaterThan(0);
  });

  it("offers accept, reject, and defer for a pending candidate", () => {
    const { container } = renderWorkspace({ candidateRows: [candidateRow()] });
    const commands = [...container.querySelectorAll("[data-alias-review-command]")].map((node) =>
      node.getAttribute("data-alias-review-command"),
    );
    expect(commands).toContain("alias.accept");
    expect(commands).toContain("alias.reject");
    expect(commands).toContain("alias.defer");
  });

  it("only offers revoke for an accepted alias candidate", () => {
    const { container } = renderWorkspace({
      candidateRows: [candidateRow({ review_status: "accepted" })],
    });
    const rowCommands = [...container.querySelectorAll("[data-alias-review-command]")].map((node) =>
      node.getAttribute("data-alias-review-command"),
    );
    expect(rowCommands).toContain("alias.revoke");
    expect(rowCommands).not.toContain("alias.accept");
  });

  it("posts bulk accept and reject forms to the supplied action href once candidates are selected", () => {
    const { container } = renderWorkspace({ candidateRows: [candidateRow()] });

    const rowCheckbox = container.querySelector('tbody input[type="checkbox"]');
    expect(rowCheckbox).toBeTruthy();
    fireEvent.click(rowCheckbox as Element);

    const bulkPanel = container.querySelector('[data-alias-review-bulk-actions="true"]');
    expect(bulkPanel).toBeTruthy();
    const panel = within(bulkPanel as HTMLElement);
    expect(panel.getByText("1 candidates selected")).toBeTruthy();

    const acceptForm = (bulkPanel as HTMLElement).querySelector('[data-alias-review-command="alias.accept"]');
    expect(acceptForm?.getAttribute("action")).toBe(ACTION_HREF);
    const rejectForm = (bulkPanel as HTMLElement).querySelector('[data-alias-review-command="alias.reject"]');
    expect(rejectForm?.getAttribute("action")).toBe(ACTION_HREF);
    expect((rejectForm?.querySelector('input[name="aliasHashes"]') as HTMLInputElement)?.value).toBe("hash_official");
  });

  it("renders coverage counters for promotion/search readiness", () => {
    renderWorkspace({
      candidateRows: [candidateRow({ alias_hash: "pending", target_id: "cat_needs_review", review_status: "pending" })],
      catalogItemAliasRows: [acceptedCardAlias({ catalog_item_id: "cat_english" })],
    });
    const coverage = document.querySelector('[data-alias-review-coverage="true"]');
    expect(coverage).toBeTruthy();
    expect(within(coverage as HTMLElement).getByText("Cards with accepted English alias")).toBeTruthy();
    expect(within(coverage as HTMLElement).getByText("Cards needing review")).toBeTruthy();
  });

  it("disables review actions for a view-only operator", () => {
    const { container } = renderWorkspace({ candidateRows: [candidateRow()] }, false);
    const acceptButton = container.querySelector('[data-alias-review-command="alias.accept"]')?.querySelector("button");
    expect(acceptButton?.hasAttribute("disabled")).toBe(true);
  });
});
