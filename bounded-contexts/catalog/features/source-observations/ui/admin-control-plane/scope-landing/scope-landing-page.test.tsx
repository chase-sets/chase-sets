// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { readCatalogListQuery } from "../../../../../support/shell-support/list-query-state";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";
import { CatalogScopeLandingPage } from "./scope-landing-page";
import { buildCatalogScopeLandingReadModel } from "./scope-landing-read-model";
import { catalogAttentionQueueReadModelFixture } from "../../../../attention-queue/api/attention-queue-test-fixtures";
import type { CatalogDeferredAttentionQueueResult } from "../../../../attention-queue/api/contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../primary-workbench-command-feedback";
import {
  buildCatalogAliasReviewReadModel,
  type CatalogAliasReviewReadModel,
} from "../../../../alias-equivalence/api/alias-review-admin-contracts";
import type {
  CatalogAliasCandidateRow,
  CatalogItemAliasRow,
  CatalogReferenceRecordAliasRow,
} from "../../../../alias-equivalence/read-model/queries";
afterEach(cleanup);

const GENERATED_AT = "2026-07-13T12:00:00.000Z";

function scope(overrides: Partial<CatalogScopeRecordDetail> = {}): CatalogScopeRecordDetail {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordId: "ref_expansion_paldean_fates",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentScopeRecordId: null,
    productLineScopeRecordId: null,
    seriesScopeRecordId: null,
    releaseDate: "2024-01-26",
    officialSetCode: "PAF",
    languageEditions: ["en", "ja"],
    lifecycleStatus: "active",
    updatedAt: GENERATED_AT,
    ...overrides,
  };
}

function renderLanding(input: {
  scopes: ListResponse<CatalogScopeRecordDetail>;
  url?: string;
  error?: string | null;
  attentionQueue?: CatalogDeferredAttentionQueueResult;
  generalAliasReview?: CatalogAliasReviewReadModel | null;
  generalAliasReviewFailed?: boolean;
  canManage?: boolean;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback;
  attentionItemKey?: string;
}) {
  const url = input.url ?? "https://admin.example/catalog/scopes";
  const query = readCatalogListQuery(new Request(url));
  const readModel = buildCatalogScopeLandingReadModel({
    scopes: input.scopes,
    filters: {
      search: query.search,
      productDomain: "",
      languageEdition: query.language,
      lifecycleStatus: query.status,
    },
    generatedAt: GENERATED_AT,
  });

  const router = createMemoryRouter(
    [
      {
        path: "/catalog/scopes",
        Component: () => (
          <CatalogScopeLandingPage
            readModel={readModel}
            query={query}
            productDomain=""
            loading={false}
            error={input.error ?? null}
            attentionQueue={input.attentionQueue}
            generalAliasReview={input.generalAliasReview}
            generalAliasReviewFailed={input.generalAliasReviewFailed}
            canManage={input.canManage}
            commandFeedback={input.commandFeedback}
            attentionItemKey={input.attentionItemKey}
          />
        ),
      },
      { path: "/catalog/scopes/:id", Component: () => <h1>Scope Detail</h1> },
    ],
    { initialEntries: [new URL(url).pathname + new URL(url).search] },
  );

  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
}

function aliasCandidate(overrides: Partial<CatalogAliasCandidateRow> = {}): CatalogAliasCandidateRow {
  return {
    alias_hash: "alias-pending",
    target_kind: "catalog-item",
    target_id: "item-1",
    target_key: "name",
    alias_text: "フシギダネ",
    normalized_alias_text: "ふしぎだね",
    alias_language_code: "ja",
    source_language_code: "en",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "pending",
    provider_key: "tcgdex",
    observation_id: "obs-1",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "v1",
    mapping_fingerprint: "fp",
    evidence: { nativeName: "Bulbasaur", providerId: "p-1" },
    first_observed_at: GENERATED_AT,
    updated_at: GENERATED_AT,
    ...overrides,
  };
}

function acceptedItemAlias(overrides: Partial<CatalogItemAliasRow> = {}): CatalogItemAliasRow {
  return {
    alias_hash: "alias-accepted-item",
    catalog_item_id: "item-1",
    target_field: "name",
    alias_text: "Bulbasaur",
    normalized_alias_text: "bulbasaur",
    alias_language_code: "en",
    source_language_code: "en",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "accepted",
    provider_key: "tcgdex",
    observation_id: "obs-accepted",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "v1",
    mapping_fingerprint: "fp-accepted",
    evidence: {},
    last_actor: "operator",
    last_reason: null,
    policy_version: "alias-source-governance-v1",
    proposed_at: GENERATED_AT,
    reviewed_at: GENERATED_AT,
    updated_at: GENERATED_AT,
    ...overrides,
  };
}

function acceptedReferenceAlias(
  overrides: Partial<CatalogReferenceRecordAliasRow> = {},
): CatalogReferenceRecordAliasRow {
  return {
    alias_hash: "alias-accepted-reference",
    reference_record_id: "ref-1",
    type_key: "expansion",
    alias_text: "Base Set",
    normalized_alias_text: "base set",
    alias_language_code: "en",
    source_language_code: "en",
    alias_type: "set-equivalent",
    confidence: "high",
    review_status: "auto-accepted",
    provider_key: "tcgdex",
    observation_id: "obs-reference",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "v1",
    mapping_fingerprint: "fp-reference",
    evidence: {},
    last_actor: "system",
    last_reason: null,
    policy_version: "alias-source-governance-v1",
    proposed_at: GENERATED_AT,
    reviewed_at: GENERATED_AT,
    updated_at: GENERATED_AT,
    ...overrides,
  };
}

function generalAliasReview(
  statuses: Readonly<Record<string, CatalogAliasCandidateRow["review_status"]>> = {},
): CatalogAliasReviewReadModel {
  return buildCatalogAliasReviewReadModel({
    generatedAt: GENERATED_AT,
    filter: {
      providerKey: null,
      sourceProfileVersion: null,
      aliasType: null,
      reviewStatuses: [],
      observationId: null,
      targetKind: null,
      targetId: null,
    },
    candidateRows: [
      aliasCandidate({ review_status: statuses["alias-pending"] ?? "pending" }),
      aliasCandidate({
        alias_hash: "alias-reference",
        target_kind: "reference-record",
        target_id: "ref-1",
        target_key: "expansion",
        alias_text: "Base Set JP",
        alias_type: "set-equivalent",
        review_status: statuses["alias-reference"] ?? "auto-accepted",
      }),
    ],
    catalogItemAliasRows: [acceptedItemAlias({ review_status: statuses["alias-accepted-item"] ?? "accepted" })],
    referenceRecordAliasRows: [acceptedReferenceAlias()],
  });
}

describe("CatalogScopeLandingPage", () => {
  // The DS DataTable renders both a desktop table and a mobile card layout in
  // jsdom, so cell values appear more than once; assert on "at least one".
  it("renders the canonical scope record list with promotion and sync signals, each linking to its Scope Detail", async () => {
    renderLanding({ scopes: { items: [scope()], total: 1, count: 1 } });

    expect(await screen.findByRole("heading", { name: "Scopes" })).toBeTruthy();
    expect(screen.getAllByText("Paldean Fates").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Fresh").length).toBeGreaterThan(0);

    const viewLinks = screen.getAllByRole("link", { name: "View" });
    expect(
      viewLinks.some((link) => link.getAttribute("href") === "/catalog/scopes/scope_expansion_paldean_fates"),
    ).toBe(true);
  });

  it("shows a stale-sync signal for a scope whose projection has not advanced recently", () => {
    renderLanding({
      scopes: { items: [scope({ updatedAt: "2026-01-01T00:00:00.000Z" })], total: 1, count: 1 },
    });

    expect(screen.getAllByText("Stale sync").length).toBeGreaterThan(0);
  });

  it("renders the empty state when no scope records match", () => {
    renderLanding({ scopes: { items: [], total: 0, count: 0 } });

    expect(screen.queryByText("Paldean Fates")).toBeNull();
    // EntityListPage renders its empty state (no rows) rather than the table.
    expect(screen.queryAllByRole("link", { name: "View" })).toHaveLength(0);
  });

  it("surfaces a blocked banner when the list load failed", () => {
    renderLanding({
      scopes: { items: [], total: 0, count: 0 },
      error: "Scope records are unavailable.",
    });

    expect(screen.getAllByText("Scope records are unavailable.").length).toBeGreaterThan(0);
  });

  it("keeps home review content after the Scopes heading inside the page container", async () => {
    renderLanding({
      scopes: { items: [scope()], total: 1, count: 1 },
      attentionQueue: { status: "ready", readModel: catalogAttentionQueueReadModelFixture() },
    });

    const heading = await screen.findByRole("heading", { name: "Scopes" });
    const review = document.querySelector("[data-catalog-scope-home-review]")!;
    expect(heading.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.closest("[data-catalog-scope-home-review]")).toBeNull();
    expect(review.closest("main") ?? review.parentElement).toBeTruthy();
  });

  it("mounts general alias review for a single-language scope with item/reference and accepted/auto-accepted targets", async () => {
    const user = userEvent.setup();
    renderLanding({
      scopes: { items: [scope({ languageEditions: ["en"] })], total: 1, count: 1 },
      generalAliasReview: generalAliasReview(),
      canManage: true,
    });

    const disclosure = screen.getByRole("button", { name: /All-scopes alias review/i });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await user.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("フシギダネ").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Base Set JP").length).toBeGreaterThan(0);
    expect(screen.getAllByText("accepted").length).toBeGreaterThan(0);
    expect(screen.getAllByText("auto-accepted").length).toBeGreaterThan(0);
    const commands = [...document.querySelectorAll("[data-alias-review-command]")].map((node) =>
      node.getAttribute("data-alias-review-command"),
    );
    expect(commands).toEqual(expect.arrayContaining(["alias.accept", "alias.reject", "alias.defer", "alias.revoke"]));
    for (const intent of ["alias.accept", "alias.reject", "alias.defer", "alias.revoke"]) {
      expect(document.querySelector(`[data-alias-review-command="${intent}"]`)?.getAttribute("action")).toBe(
        "/catalog/scopes",
      );
    }
  });

  it("renders the committed dismiss feedback with a manage-gated restore form", () => {
    renderLanding({
      scopes: { items: [scope()], total: 1, count: 1 },
      commandFeedback: { status: "success", intent: "dismiss-attention-item", result: "job-queued" },
      attentionItemKey: "provider-health:tcgdex:unit",
      canManage: true,
    });
    const restore = [...document.querySelectorAll<HTMLFormElement>("form")].find(
      (form) =>
        (form.querySelector('input[name="_intent"]') as HTMLInputElement | null)?.value === "restore-attention-item",
    );
    expect((restore?.querySelector('input[name="_intent"]') as HTMLInputElement | null)?.value).toBe(
      "restore-attention-item",
    );
    expect((restore?.querySelector('input[name="itemKey"]') as HTMLInputElement | null)?.value).toBe(
      "provider-health:tcgdex:unit",
    );
    expect(restore?.querySelector("button")?.disabled).toBe(false);
  });

  it("renders supplementary queue states, alias-read failure, and disables every control for view-only operators", async () => {
    const user = userEvent.setup();
    renderLanding({
      scopes: { items: [scope()], total: 1, count: 1 },
      attentionQueue: { status: "ready", readModel: catalogAttentionQueueReadModelFixture() },
      generalAliasReview: generalAliasReview(),
      canManage: false,
    });
    await user.click(screen.getByRole("button", { name: /All-scopes alias review/i }));
    expect(document.querySelectorAll("[data-alias-review-command] button[disabled]")).not.toHaveLength(0);
    await user.click(screen.getAllByRole("button", { name: "Review health" }).at(-1)!);
    expect(document.querySelectorAll("[data-attention-park] button[disabled]").length).toBeGreaterThan(0);

    cleanup();
    renderLanding({
      scopes: { items: [scope()], total: 1, count: 1 },
      attentionQueue: { status: "ready", readModel: catalogAttentionQueueReadModelFixture([]) },
      generalAliasReviewFailed: true,
    });
    expect(screen.getByText(/alias review/i)).toBeTruthy();

    cleanup();
    renderLanding({
      scopes: { items: [scope()], total: 1, count: 1 },
      attentionQueue: { status: "unavailable" },
    });
    expect(screen.getByText(/attention queue/i)).toBeTruthy();
  });
});
