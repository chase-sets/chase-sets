// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, isInaccessible, render, renderHook, screen, within } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError as CatalogApiError } from "../support/shell-support/api/client";
import IntegrationsRoute, { action, loader } from "../routes/admin/integrations";
import ScopeDetailRoute from "../routes/admin/scope-detail";
import { loader as providersLoader, action as providerDetailAction } from "../routes/admin/catalog-provider-detail";
import { action as governanceAction } from "../routes/admin/integrations-governance";
import type { CatalogIntegrationsCommandResult } from "../support/route-support/admin-integrations/integrations-command-result";
import { commandResultNeedsRoutableHandoff } from "../support/route-support/admin-integrations/integrations-command-result";
import { action as scopeDetailAction } from "../support/route-support/admin-scope-detail/scope-detail-action";
import { useOriginalPromotionReceipt } from "../features/source-observations/ui/integrations-surface-route-view";
import { CatalogIntegrationCreateItemsStage } from "../features/source-observations/ui/admin-control-plane/import-to-promotion/create-items-stage";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../features/source-observations/ui/primary-workbench-read-model";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../features/source-observations/ui/primary-workbench-route-context";
import { catalogPrimaryWorkbenchSourceOptionHref } from "../features/source-observations/ui/primary-workbench-source-option-refresh";
import {
  observationSelectionScopeKey,
  readPersistedObservationSelection,
  writePersistedObservationSelection,
} from "../features/source-observations/ui/primary-workbench-selection-store";
import {
  controlPlaneOverview,
  loaderData,
  integrationJobSummary,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
  syntheticPromotionPreviewResponse,
  syntheticPromotionReceipt,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../features/source-observations/ui/contracts";

import {
  actionRequest,
  aliasReviewReadModel,
  lifecycleConfirmationValue,
  redirectLocation,
  lorcastLorcanaProfileReview,
  runDailyAction,
  runDailyActionRedirect,
  runProviderDetailAction,
  scrydexLorcanaImportPreview,
  scrydexLorcanaProfileReview,
  scrydexOnePieceImportPreview,
  scrydexOnePieceProfileReview,
  sourceOptionResponse,
  tcgplayerReadinessUnit,
  emptyPromotionValidation,
} from "./admin-integrations-route-test-support";

const {
  mockCreateCatalogRequestApiClient,
  mockIsTransientAuthResolutionError,
  mockResolveActorFromAuthApi,
  mockUseLoaderData,
  mockUseNavigate,
  mockUseRouteLoaderData,
  mockUseActionData,
  mockUseNavigation,
} = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
  mockIsTransientAuthResolutionError: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseNavigate: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockUseNavigation: vi.fn(() => ({ state: "idle" })),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useNavigate: () => mockUseNavigate,
    useRouteLoaderData: mockUseRouteLoaderData,
    useActionData: mockUseActionData,
    useNavigation: mockUseNavigation,
    useLocation: () => ({ pathname: "/catalog/integrations", search: "", hash: "", key: "synthetic-daily" }),
    useFetcher: () => ({ state: "idle", data: undefined, load: () => undefined }),
    // The import-jobs module polls live progress via useRevalidator and the daily
    // import-context form submits context changes via useSubmit; outside a data
    // router (this bare render) both need a stub so the workbench still renders.
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useSubmit: () => () => undefined,
  };
});

vi.mock("../support/request-support/api-client", async () => {
  const { withCatalogSurfaceReads } = await vi.importActual<
    typeof import("../features/source-observations/tests/integrations-surface-read-test-client")
  >("../features/source-observations/tests/integrations-surface-read-test-client");
  return {
    createCatalogRequestApiClient: (request: Request) =>
      withCatalogSurfaceReads(mockCreateCatalogRequestApiClient(request), request),
  };
});

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  isTransientAuthResolutionError: mockIsTransientAuthResolutionError,
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
}));

function readOriginalReceiptDom(node: Element): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const set = (path: string, value: unknown) => {
    const parts = path.split(".");
    let parent = result;
    for (const part of parts.slice(0, -1)) {
      parent = (parent[part] ??= {}) as Record<string, unknown>;
    }
    parent[parts.at(-1)!] = value;
  };
  for (const array of node.querySelectorAll("[data-catalog-receipt-array]")) {
    set(array.getAttribute("data-catalog-receipt-array")!, []);
  }
  const seen = new Set<string>();
  for (const field of node.querySelectorAll("[data-catalog-receipt-field]")) {
    const path = field.getAttribute("data-catalog-receipt-field")!;
    expect(seen.has(path), path).toBe(false);
    seen.add(path);
    expect(field.closest("[hidden],input,script")).toBeNull();
    const kind = field.getAttribute("data-catalog-receipt-kind");
    const text = field.textContent;
    expect(["null", "undefined", "empty-string", "number", "boolean", "string"]).toContain(kind);
    set(
      path,
      kind === "null"
        ? null
        : kind === "undefined"
          ? undefined
          : kind === "empty-string"
            ? ""
            : kind === "number"
              ? Number(text)
              : kind === "boolean"
                ? text === "true"
                : text,
    );
  }
  return result;
}

const receiptRequestUrl =
  "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04";

function receiptUrlFor(scopeRecordId: string | null) {
  return scopeRecordId
    ? receiptRequestUrl.replace("/catalog/integrations?", `/catalog/scopes/${scopeRecordId}?`) +
        `&scopeRecordId=${scopeRecordId}`
    : receiptRequestUrl;
}

function receiptRouteModel(
  activeProfileVersion: string | null = "2026.06.04",
  requestUrl = receiptRequestUrl,
  overview: ReturnType<typeof controlPlaneOverview> | null = null,
) {
  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: {
      items: activeProfileVersion
        ? [profileReview({ active: true, lifecycle: "active", profileVersion: activeProfileVersion })]
        : [],
      total: activeProfileVersion ? 1 : 0,
      count: activeProfileVersion ? 1 : 0,
    },
    controlPlaneOverview: overview,
    canManageCatalog: true,
    reviewObservations: {
      items: [sourceObservationListItem(), sourceObservationListItem({ observation_id: "obs_002" })],
      total: 2,
      count: 2,
    },
  });
}

function expectActiveProfileOnlyDifference(
  matching: ReturnType<typeof receiptRouteModel>,
  changed: ReturnType<typeof receiptRouteModel>,
  activeProfileVersion: string,
) {
  expect(changed.importJobs.selectedScope?.profileVersion).toBe(activeProfileVersion);
  expect(changed.routeContext).toEqual(matching.routeContext);
  expect(changed.sourceObservationReview).toEqual(matching.sourceObservationReview);
  const { profileWorkflows, ...preview } = changed.promotionPreview;
  const { profileWorkflows: matchingWorkflows, ...matchingPreview } = matching.promotionPreview;
  expect(preview).toEqual(matchingPreview);
  expect(profileWorkflows).toEqual({
    ...matchingWorkflows,
    reapply: { ...matchingWorkflows.reapply, profileVersion: activeProfileVersion },
  });
  expect(changed.readiness).toEqual(matching.readiness);
}

// Exercise the real route/workspace and action with form-derived inputs. Pending
// starts on submission and ends only when the actual deferred action settles.
function ReceiptActionRouteHarness({
  readModel,
  requestUrl = receiptRequestUrl,
  scopeRecordId = null,
}: {
  readModel: ReturnType<typeof receiptRouteModel>;
  requestUrl?: string;
  scopeRecordId?: string | null;
}) {
  const [transition, setTransition] = useState<{
    pending: boolean;
    result: CatalogIntegrationsCommandResult | null;
  }>({ pending: false, result: null });
  const journey = loaderData({ requestUrl, readModel });
  mockUseLoaderData.mockReturnValue(
    scopeRecordId
      ? {
          scope: {
            scopeRecordId,
            name: "Synthetic scope",
            productDomain: "pokemon",
            scopeKind: "set",
            lifecycleStatus: "active",
            referenceTypeKey: "set",
            referenceRecordId: "synthetic-reference-record",
            referenceRecordKey: "synthetic-set",
            parentScopeRecordId: null,
            productLineScopeRecordId: null,
            seriesScopeRecordId: null,
            releaseDate: null,
            officialSetCode: null,
            languageEditions: ["en"],
            updatedAt: "2026-11-06T00:00:00Z",
          },
          languageEditionAliasReview: aliasReviewReadModel(),
          journey,
        }
      : journey,
  );
  mockUseActionData.mockReturnValue(transition.result);
  mockUseNavigation.mockReturnValue({ state: transition.pending ? "submitting" : "idle" });
  return (
    <div
      data-testid="receipt-action-transition"
      data-state={transition.pending ? "submitting" : "idle"}
      onSubmit={async (event) => {
        event.preventDefault();
        const fields = Object.fromEntries(
          [...new FormData(event.target as HTMLFormElement).entries()].map(([key, value]) => [key, String(value)]),
        );
        const form = event.target as HTMLFormElement;
        expect(new URL(form.getAttribute("action")!, requestUrl).pathname).toBe(new URL(requestUrl).pathname);
        expect(fields._intent).toBe("observation.promote");
        expect(fields.promotionPhase).toBe("preview");
        expect(fields.scopeRecordId).toBe(scopeRecordId ?? "");
        setTransition((previous) => ({ ...previous, pending: true }));
        const result = scopeRecordId
          ? await scopeDetailAction(actionRequest(fields, requestUrl))
          : await runDailyAction(fields, requestUrl);
        setTransition({ pending: false, result });
      }}
    >
      {scopeRecordId ? <ScopeDetailRoute /> : <IntegrationsRoute />}
    </div>
  );
}

function receiptPreviewButton(): HTMLButtonElement {
  openReceiptStage("create-items");
  return screen
    .getAllByRole("button", { name: /Preview promotion/ })
    .find((button) => !button.hasAttribute("aria-expanded"))! as HTMLButtonElement;
}

function openReceiptStage(stage: "review-changes" | "create-items") {
  const trigger = document.querySelector<HTMLButtonElement>(`[data-catalog-import-workflow-stage="${stage}"]`)!;
  expect(trigger).not.toBeNull();
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}

function observationRowCheckboxes(): HTMLInputElement[] {
  openReceiptStage("review-changes");
  const table = [...document.querySelectorAll("table")].find(
    (candidate) => candidate.caption?.textContent === "Source Observation review",
  )!;
  expect(table).toBeDefined();
  expect(isInaccessible(table)).toBe(false);
  return [...table.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')];
}

function expectWorkingSelection(scopeKey: string, ids: readonly string[]) {
  const rows = observationRowCheckboxes();
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.disabled)).toEqual([false, false]);
  expect(rows.map((row) => row.checked)).toEqual([ids.includes("obs_001"), ids.includes("obs_002")]);
  expect([...readPersistedObservationSelection(scopeKey)].sort()).toEqual([...ids].sort());
}

function changeWorkingSelection(scopeKey: string, from: "obs_001" | "obs_002", to: "obs_001" | "obs_002") {
  const rows = observationRowCheckboxes();
  fireEvent.click(rows[to === "obs_001" ? 0 : 1]);
  expectWorkingSelection(scopeKey, [from, to]);
  fireEvent.click(rows[from === "obs_001" ? 0 : 1]);
  expectWorkingSelection(scopeKey, [to]);
}

function expectOriginalReceipt(result: CatalogIntegrationsCommandResult, state?: "fresh" | "stale") {
  openReceiptStage("create-items");
  const disclosure = screen
    .getAllByRole("button", { name: /Preview promotion/ })
    .find((button) => button.hasAttribute("aria-expanded"))!;
  if (disclosure.getAttribute("aria-expanded") !== "true") fireEvent.click(disclosure);
  const node = document.querySelector("[data-catalog-promotion-receipt]")!;
  expect(readOriginalReceiptDom(node)).toEqual(result.promotionReceipt);
  expect(isInaccessible(node)).toBe(false);
  if (state) {
    const status = document.querySelector(`[data-catalog-promotion-receipt-state="${state}"]`);
    expect(status).not.toBeNull();
    expect(isInaccessible(status!)).toBe(false);
  }
  const commit = screen.getByRole("button", { name: "Create or update Catalog Items" }) as HTMLButtonElement;
  expect(commit.form?.querySelector<HTMLInputElement>('[name="promotionPreviewId"]')?.value).toBe(
    result.promotionReceipt!.previewId,
  );
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    expect(link.href).not.toContain("promotionPreviewId");
    expect(link.href).not.toContain(result.promotionReceipt!.preview.fingerprint);
  }
  expect(JSON.stringify(window.sessionStorage)).not.toContain(result.promotionReceipt!.previewId);
  expect(JSON.stringify(window.sessionStorage)).not.toContain(result.promotionReceipt!.preview.fingerprint);
}

function recordSyntheticReceipt(label: string, result: CatalogIntegrationsCommandResult) {
  console.info(`SYNTHETIC_RECEIPT ${label} ${JSON.stringify(result.promotionReceipt)}`);
}

// The review page every promotion in these tests is previewed and confirmed on,
// which admin-web sends with the preview and the execution for the Catalog API
// to bind into its token using the daily API's commandPreview descriptor.
function pick(page: { unitKey: string; importScope: string; profileVersion: string }) {
  return { unitKey: page.unitKey, importScope: page.importScope, profileVersion: page.profileVersion };
}

const reviewPage = {
  unitKey: "tcgdex:pokemon:card:import",
  importScope: "en:3:base:base1",
  profileVersion: "2026.06.04",
  scope: expect.objectContaining({ provider: "tcgdex", setId: "base1" }),
};

describe("Catalog integrations route", () => {
  // Issue #11142: distinctive API values reveal any remaining route-side promotion authority.
  it("forwards the submitted row's API descriptor and keeps its original receipt confirmable", async () => {
    const requestUrl = receiptRequestUrl;
    const readModel = receiptRouteModel();
    const scope = {
      provider: "tcgdex",
      language: "synthetic-api-language",
      search: "synthetic-api-query",
      status: "eligible",
    };
    const commandPreview = {
      scope,
      confirmation: {
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        scope,
      },
      allowScopeSelection: false,
    };
    const authoritative = {
      ...readModel,
      actions: readModel.actions.map((entry) =>
        entry.key === "observation.promote" ? { ...entry, commandPreview } : entry,
      ),
    };
    const getCatalogPrimaryWorkbenchSurface = vi.fn().mockResolvedValue({ readModel: authoritative });
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue(syntheticPromotionPreviewResponse());
    const previewBulkPromoteSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogPrimaryWorkbenchSurface,
      previewBulkPromoteSourceObservationIds,
      previewBulkPromoteSourceObservations,
    });
    const result = await runDailyAction(
      {
        _intent: "observation.promote",
        promotionPhase: "preview",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        selectedObservationIds: "obs_001",
        commandPreview: JSON.stringify({ ...commandPreview, scope: { provider: "synthetic-forged-provider" } }),
      },
      "https://admin.example/catalog/integrations?providerKey=synthetic-stale-provider&profileVersion=synthetic-stale-profile&promotionPreviewId=synthetic-held-token",
    );
    expect(getCatalogPrimaryWorkbenchSurface).toHaveBeenCalledTimes(1);
    const [surface, location] = getCatalogPrimaryWorkbenchSurface.mock.calls[0]!;
    expect(surface).toBe("daily");
    const submitted = new URL(location, "https://admin.example");
    expect(submitted.searchParams.get("providerKey")).toBe("tcgdex");
    expect(submitted.searchParams.get("profileVersion")).toBe("2026.06.04");
    expect(submitted.searchParams.get("promotionPreviewId")).toBeNull();
    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledWith(["obs_001"], {
      promoteAsDraft: false,
      confirmation: commandPreview.confirmation,
    });
    expect(previewBulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(result.promotionReceipt?.selection.scope).toEqual(scope);
    const data = loaderData({ requestUrl, readModel: authoritative });
    const positive = renderHook(() => useOriginalPromotionReceipt(data, result, false));
    expect(positive.result.current.promotionPreview.executionSafeguards.previewFresh).toBe(true);
    positive.unmount();
    const changed = { ...commandPreview, scope: { ...scope, search: "synthetic-descriptor-drift" } };
    for (const [currentModel, actionResult] of [
      [
        {
          ...authoritative,
          actions: authoritative.actions.map((entry) =>
            entry.key === "observation.promote" ? { ...entry, commandPreview: changed } : entry,
          ),
        },
        result,
      ],
      [authoritative, { ...result, promotionCommandPreview: changed }],
    ] as const) {
      const probe = renderHook(() =>
        useOriginalPromotionReceipt({ ...data, readModel: currentModel }, actionResult, false),
      );
      expect(probe.result.current.promotionPreview.executionSafeguards.previewFresh).toBe(false);
      expect(probe.result.current.promotionPreview.receipt).toEqual(result.promotionReceipt);
      probe.unmount();
    }
  });

  it("fails closed on missing promotion reads or descriptors and refuses disallowed scope selection", async () => {
    for (const phase of ["preview", "execute"]) {
      for (const answer of [
        null,
        { readModel: { actions: [] } },
        { readModel: { actions: [{ key: "observation.promote" }] } },
        new Error("synthetic read failure"),
      ]) {
        const getCatalogPrimaryWorkbenchSurface =
          answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue(answer);
        const previewBulkPromoteSourceObservationIds = vi.fn();
        const bulkPromoteSourceObservations = vi.fn();
        mockCreateCatalogRequestApiClient.mockReturnValue({
          getCatalogPrimaryWorkbenchSurface,
          previewBulkPromoteSourceObservationIds,
          bulkPromoteSourceObservations,
        });
        const result = await runDailyAction({
          _intent: "observation.promote",
          promotionPhase: phase,
          selectedObservationIds: "obs_001",
          promotionPreviewId: "synthetic-original-token",
        });
        expect(result.feedback).toMatchObject({
          status: "error",
          result: phase === "preview" ? "command-failed" : "preview-required",
        });
        expect(result.context.promotionPreviewId).toBeNull();
        expect(result.promotionReceipt).toBeUndefined();
        expect(previewBulkPromoteSourceObservationIds).not.toHaveBeenCalled();
        expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
      }
    }
    const commandPreview = {
      scope: { provider: "synthetic-api-provider" },
      confirmation: { unitKey: null, importScope: null, profileVersion: null, scope: {} },
      allowScopeSelection: false,
    };
    const getCatalogPrimaryWorkbenchSurface = vi
      .fn()
      .mockResolvedValue({ readModel: { actions: [{ key: "observation.promote", commandPreview }] } });
    const previewBulkPromoteSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogPrimaryWorkbenchSurface,
      previewBulkPromoteSourceObservations,
    });
    const result = await runDailyAction({
      _intent: "observation.promote",
      promotionPhase: "preview",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
    });
    expect(result.feedback.result).toBe("command-failed");
    expect(previewBulkPromoteSourceObservations).not.toHaveBeenCalled();
  });

  it.each([null, "synthetic-scope-record"])(
    "preserves working selection B when deferred Preview A settles under scope %s",
    async (scopeRecordId) => {
      window.sessionStorage.clear();
      const requestUrl = receiptUrlFor(scopeRecordId);
      const readModel = receiptRouteModel("2026.06.04", requestUrl);
      const scopeKey = observationSelectionScopeKey(readModel.routeContext);
      writePersistedObservationSelection(scopeKey, ["obs_001"]);
      let resolvePreview!: (preview: ReturnType<typeof syntheticPromotionReceipt>["preview"]) => void;
      const deferred = new Promise<ReturnType<typeof syntheticPromotionReceipt>["preview"]>((resolve) => {
        resolvePreview = resolve;
      });
      const previewBulkPromoteSourceObservationIds = vi.fn().mockReturnValueOnce(deferred);
      const bulkPromoteSourceObservations = vi.fn();
      mockCreateCatalogRequestApiClient.mockReturnValue({
        previewBulkPromoteSourceObservationIds,
        bulkPromoteSourceObservations,
      });
      const route = render(
        <ReceiptActionRouteHarness readModel={readModel} requestUrl={requestUrl} scopeRecordId={scopeRecordId} />,
      );
      const rowCheckboxes = observationRowCheckboxes;
      expectWorkingSelection(scopeKey, ["obs_001"]);
      const originalTable = rowCheckboxes()[0].closest("table");
      const originalTransition = screen.getByTestId("receipt-action-transition");
      fireEvent.submit(receiptPreviewButton().form!);
      await waitFor(() => expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("receipt-action-transition").getAttribute("data-state")).toBe("submitting");
      expect(screen.getByLabelText(/I confirm this will promote/).hasAttribute("disabled")).toBe(true);
      changeWorkingSelection(scopeKey, "obs_001", "obs_002");
      resolvePreview(syntheticPromotionPreviewResponse());
      await waitFor(() =>
        expect(screen.getByTestId("receipt-action-transition").getAttribute("data-state")).toBe("idle"),
      );
      const resultA = mockUseActionData();
      recordSyntheticReceipt(`F1 scope=${scopeRecordId} original=A`, resultA);
      expectWorkingSelection(scopeKey, ["obs_002"]);
      expect(rowCheckboxes()[0].closest("table")).toBe(originalTable);
      expect(screen.getByTestId("receipt-action-transition")).toBe(originalTransition);
      expect(resultA.promotionReceipt.selection.observationIds).toEqual(["obs_001"]);
      expect(resultA.promotionReceipt.selection.scopeRecordId).toBe(scopeRecordId);
      expectOriginalReceipt(resultA, "stale");
      const confirmation = screen.getByLabelText(/I confirm this will promote/);
      const commit = screen.getByRole("button", { name: "Create or update Catalog Items" }) as HTMLButtonElement;
      expect(confirmation.hasAttribute("disabled")).toBe(true);
      expect(commit.disabled).toBe(true);
      expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1);
      expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
      expect(mockUseNavigate).not.toHaveBeenCalled();
      changeWorkingSelection(scopeKey, "obs_002", "obs_001");
      openReceiptStage("create-items");
      expect(confirmation.hasAttribute("disabled")).toBe(true);
      expect(commit.disabled).toBe(true);
      changeWorkingSelection(scopeKey, "obs_001", "obs_002");
      const previewB = syntheticPromotionReceipt().preview;
      previewB.validation.coveredObservationIds = ["obs_002"];
      previewBulkPromoteSourceObservationIds.mockResolvedValueOnce(
        syntheticPromotionPreviewResponse(previewB, "synthetic-preview-token-b"),
      );
      fireEvent.submit(receiptPreviewButton().form!);
      await waitFor(() => expect(confirmation.hasAttribute("disabled")).toBe(false));
      const resultB = mockUseActionData();
      recordSyntheticReceipt(`F1 scope=${scopeRecordId} original=B`, resultB);
      expect(resultB.promotionReceipt.selection.observationIds).toEqual(["obs_002"]);
      expectOriginalReceipt(resultB, "fresh");
      expect(commit.disabled).toBe(true);
      fireEvent.click(confirmation);
      expect(commit.disabled).toBe(false);
      expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(2);
      expect(previewBulkPromoteSourceObservationIds.mock.calls.map(([ids]) => ids)).toEqual([["obs_001"], ["obs_002"]]);
      expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
      expect(mockUseNavigate).not.toHaveBeenCalled();
      route.unmount();
      render(<ReceiptActionRouteHarness readModel={readModel} requestUrl={requestUrl} scopeRecordId={scopeRecordId} />);
      expectWorkingSelection(scopeKey, ["obs_002"]);
      openReceiptStage("create-items");
      expect(document.querySelector("[data-catalog-promotion-receipt]")).toBeNull();
      expect(screen.getByLabelText(/I confirm this will promote/).hasAttribute("disabled")).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Create or update Catalog Items" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(2);
    },
  );

  it.each(
    [null, "synthetic-scope-record"].flatMap((scopeRecordId) =>
      ["2026.06.04", "synthetic-active-B", null].map((activeProfileVersion) => ({
        scopeRecordId,
        activeProfileVersion,
      })),
    ),
  )(
    "checks initial active profile $activeProfileVersion and restoration under scope $scopeRecordId",
    async ({ activeProfileVersion, scopeRecordId }) => {
      window.sessionStorage.clear();
      const requestUrl = receiptUrlFor(scopeRecordId);
      const matchingModel = receiptRouteModel("2026.06.04", requestUrl);
      const readModel = receiptRouteModel(activeProfileVersion, requestUrl);
      expect(readModel.importJobs.selectedScope?.profileVersion).toBe(activeProfileVersion);
      if (activeProfileVersion) expectActiveProfileOnlyDifference(matchingModel, readModel, activeProfileVersion);
      expect(readModel.routeContext).toEqual(matchingModel.routeContext);
      expect(readModel.sourceObservationReview.rows).toEqual(matchingModel.sourceObservationReview.rows);
      expect(readModel.promotionPreview.currentFingerprint).toBe(matchingModel.promotionPreview.currentFingerprint);
      expect(readModel.promotionPreview.blockers).toEqual(
        activeProfileVersion === null
          ? expect.arrayContaining(["missing-active-profile"])
          : matchingModel.promotionPreview.blockers,
      );
      writePersistedObservationSelection(observationSelectionScopeKey(readModel.routeContext), ["obs_001"]);
      const original = syntheticPromotionReceipt().preview;
      let resolvePreview!: (preview: typeof original) => void;
      const previewBulkPromoteSourceObservationIds = vi.fn().mockReturnValueOnce(
        new Promise<typeof original>((resolve) => {
          resolvePreview = resolve;
        }),
      );
      const bulkPromoteSourceObservations = vi.fn();
      mockCreateCatalogRequestApiClient.mockReturnValue({
        previewBulkPromoteSourceObservationIds,
        bulkPromoteSourceObservations,
      });
      const harness = (model: ReturnType<typeof receiptRouteModel>) => (
        <ReceiptActionRouteHarness readModel={model} requestUrl={requestUrl} scopeRecordId={scopeRecordId} />
      );
      const { rerender } = render(harness(readModel));
      fireEvent.submit(receiptPreviewButton().form!);
      await waitFor(() => expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("receipt-action-transition").getAttribute("data-state")).toBe("submitting");
      resolvePreview(syntheticPromotionPreviewResponse(original));
      await waitFor(() =>
        expect(screen.getByTestId("receipt-action-transition").getAttribute("data-state")).toBe("idle"),
      );
      const result = mockUseActionData();
      recordSyntheticReceipt(`F2 scope=${scopeRecordId} initial-active=${activeProfileVersion}`, result);
      expectOriginalReceipt(result, activeProfileVersion === "2026.06.04" ? "fresh" : "stale");
      const confirmation = screen.getByLabelText(/I confirm this will promote/);
      const commit = screen.getByRole("button", { name: "Create or update Catalog Items" }) as HTMLButtonElement;
      expect(confirmation.hasAttribute("disabled")).toBe(activeProfileVersion !== "2026.06.04");
      expect(commit.disabled).toBe(true);
      if (activeProfileVersion === "2026.06.04") {
        fireEvent.click(confirmation);
        expect(commit.disabled).toBe(false);
        const driftModel = receiptRouteModel("synthetic-active-B", requestUrl);
        expectActiveProfileOnlyDifference(matchingModel, driftModel, "synthetic-active-B");
        rerender(harness(driftModel));
        expect(confirmation.hasAttribute("disabled")).toBe(true);
        expect(commit.disabled).toBe(true);
      }
      rerender(harness(matchingModel));
      expect(confirmation.hasAttribute("disabled")).toBe(true);
      expect(commit.disabled).toBe(true);
      expectOriginalReceipt(result, "stale");
      expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1);
      previewBulkPromoteSourceObservationIds.mockResolvedValueOnce(syntheticPromotionPreviewResponse(original));
      fireEvent.submit(receiptPreviewButton().form!);
      await waitFor(() => expect(confirmation.hasAttribute("disabled")).toBe(false));
      expect(commit.disabled).toBe(true);
      fireEvent.click(confirmation);
      expect(commit.disabled).toBe(false);
      expectOriginalReceipt(mockUseActionData(), "fresh");
      expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(2);
      expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
      expect(mockUseNavigate).not.toHaveBeenCalled();
    },
  );

  it.each(
    [null, "synthetic-scope-record"].flatMap((scopeRecordId) =>
      [false, true].map((restoreWhilePending) => ({ scopeRecordId, restoreWhilePending })),
    ),
  )(
    "latches active-only profile drift while pending under scope $scopeRecordId, restored pending=$restoreWhilePending",
    async ({ scopeRecordId, restoreWhilePending }) => {
      window.sessionStorage.clear();
      const requestUrl = receiptUrlFor(scopeRecordId);
      const matching = receiptRouteModel("2026.06.04", requestUrl);
      const drift = receiptRouteModel("synthetic-active-B", requestUrl);
      expect(matching.importJobs.selectedScope?.profileVersion).toBe("2026.06.04");
      expectActiveProfileOnlyDifference(matching, drift, "synthetic-active-B");
      const scopeKey = observationSelectionScopeKey(matching.routeContext);
      writePersistedObservationSelection(scopeKey, ["obs_001"]);
      const original = syntheticPromotionReceipt().preview;
      let resolvePreview!: (preview: typeof original) => void;
      const previewBulkPromoteSourceObservationIds = vi.fn().mockReturnValueOnce(
        new Promise<typeof original>((resolve) => {
          resolvePreview = resolve;
        }),
      );
      const bulkPromoteSourceObservations = vi.fn();
      mockCreateCatalogRequestApiClient.mockReturnValue({
        previewBulkPromoteSourceObservationIds,
        bulkPromoteSourceObservations,
      });
      const harness = (model: ReturnType<typeof receiptRouteModel>) => (
        <ReceiptActionRouteHarness readModel={model} requestUrl={requestUrl} scopeRecordId={scopeRecordId} />
      );
      const { rerender } = render(harness(matching));
      fireEvent.submit(receiptPreviewButton().form!);
      await waitFor(() => expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("receipt-action-transition").getAttribute("data-state")).toBe("submitting");
      rerender(harness(drift));
      expectWorkingSelection(scopeKey, ["obs_001"]);
      openReceiptStage("create-items");
      expect(screen.getByLabelText(/I confirm this will promote/).hasAttribute("disabled")).toBe(true);
      if (restoreWhilePending) rerender(harness(matching));
      resolvePreview(syntheticPromotionPreviewResponse(original));
      await waitFor(() =>
        expect(screen.getByTestId("receipt-action-transition").getAttribute("data-state")).toBe("idle"),
      );
      recordSyntheticReceipt(
        `F2 scope=${scopeRecordId} pending-drift restored=${restoreWhilePending}`,
        mockUseActionData(),
      );
      expectOriginalReceipt(mockUseActionData(), "stale");
      const confirmation = screen.getByLabelText(/I confirm this will promote/);
      const commit = screen.getByRole("button", { name: "Create or update Catalog Items" }) as HTMLButtonElement;
      expect(confirmation.hasAttribute("disabled")).toBe(true);
      expect(commit.disabled).toBe(true);
      rerender(harness(matching));
      expectOriginalReceipt(mockUseActionData(), "stale");
      expect(confirmation.hasAttribute("disabled")).toBe(true);
      expect(commit.disabled).toBe(true);
      expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1);
      previewBulkPromoteSourceObservationIds.mockResolvedValueOnce(syntheticPromotionPreviewResponse(original));
      fireEvent.submit(receiptPreviewButton().form!);
      await waitFor(() => expect(confirmation.hasAttribute("disabled")).toBe(false));
      expectOriginalReceipt(mockUseActionData(), "fresh");
      expect(commit.disabled).toBe(true);
      fireEvent.click(confirmation);
      expect(commit.disabled).toBe(false);
      expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(2);
      expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
      expect(mockUseNavigate).not.toHaveBeenCalled();
    },
  );

  it("reconciles real deep-link selection and a different scope without restoring a receipt", () => {
    window.sessionStorage.clear();
    const initial = receiptRouteModel();
    const scopeKey = observationSelectionScopeKey(initial.routeContext);
    writePersistedObservationSelection(scopeKey, ["obs_001"]);
    const deepLink = `${receiptRequestUrl}&selectedObservationIds=obs_002`;
    const { rerender } = render(
      <ReceiptActionRouteHarness readModel={receiptRouteModel("2026.06.04", deepLink)} requestUrl={deepLink} />,
    );
    expect(observationRowCheckboxes().map((input) => input.checked)).toEqual([false, true]);
    expect(readPersistedObservationSelection(scopeKey)).toEqual(["obs_002"]);
    const otherDeepLink = `${receiptRequestUrl}&selectedObservationIds=obs_001`;
    rerender(
      <ReceiptActionRouteHarness
        readModel={receiptRouteModel("2026.06.04", otherDeepLink)}
        requestUrl={otherDeepLink}
      />,
    );
    expect(observationRowCheckboxes().map((input) => input.checked)).toEqual([true, false]);
    expect(readPersistedObservationSelection(scopeKey)).toEqual(["obs_001"]);
    const otherScopeUrl = receiptRequestUrl.replace("profileVersion=2026.06.04", "profileVersion=synthetic-profile-C");
    const otherScope = receiptRouteModel("synthetic-profile-C", otherScopeUrl);
    const otherScopeKey = observationSelectionScopeKey(otherScope.routeContext);
    expect(otherScopeKey).not.toBe(scopeKey);
    writePersistedObservationSelection(otherScopeKey, ["obs_002"]);
    rerender(<ReceiptActionRouteHarness readModel={otherScope} requestUrl={otherScopeUrl} />);
    expect(observationRowCheckboxes().map((input) => input.checked)).toEqual([false, true]);
    expect(readPersistedObservationSelection(scopeKey)).toEqual(["obs_001"]);
    expect(readPersistedObservationSelection(otherScopeKey)).toEqual(["obs_002"]);
    expect(document.querySelector("[data-catalog-promotion-receipt]")).toBeNull();
    expect(screen.getByLabelText(/I confirm this will promote/).hasAttribute("disabled")).toBe(true);
    expect(mockCreateCatalogRequestApiClient).not.toHaveBeenCalled();
    expect(mockUseNavigate).not.toHaveBeenCalled();
  });

  it("enqueues exact selected product coordinates from the real action without changing compact set meaning", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "synthetic_product_job" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
    for (const productId of ["synthetic-product-a", "synthetic-product-b"]) {
      const result = await runDailyAction({
        _intent: "scope.import",
        providerKey: "ygojson",
        unitKey: "ygojson:yugioh:sealed-product:reference-data",
        languageCode: "en",
        productId,
        importScope: "",
        expansionId: "",
        expansionName: "",
        seriesId: "",
        productLineId: "",
      });
      expect(enqueueSourceObservationIntegrationJob).toHaveBeenLastCalledWith("import", {
        provider: "ygojson",
        ingestionUnitKey: "ygojson:yugioh:sealed-product:reference-data",
        language: "en",
        productId,
      });
      expect(result.context.scope?.productId).toBe(productId);
      expect(result.context.importScope).toBe(`en:${productId}`);
    }
    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledTimes(2);
    expect(enqueueSourceObservationIntegrationJob.mock.calls.map(([, scope]) => scope.productId)).toEqual([
      "synthetic-product-a",
      "synthetic-product-b",
    ]);
  });

  // Whether a product coordinate may be imported on its own is the Catalog API's rule
  // (product-coordinate-import-guard.test.ts); the page sends the unit's scope and says the refusal.
  it("sends a product import to the Catalog API and says its refusal", async () => {
    const enqueueSourceObservationIntegrationJob = vi
      .fn()
      .mockRejectedValue(new CatalogApiError(400, { error: { code: "invalid_scope" } }));
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const result = await runDailyAction({
      _intent: "scope.import",
      providerKey: "ygojson",
      unitKey: "ygojson:yugioh:set:reference-data",
      languageCode: "en",
      productId: "synthetic-product",
      expansionId: "synthetic-set",
    });

    expect(result.feedback.status).toBe("error");
    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith(
      "import",
      expect.objectContaining({
        provider: "ygojson",
        ingestionUnitKey: "ygojson:yugioh:set:reference-data",
        language: "en",
        setId: "synthetic-set",
        productId: "synthetic-product",
      }),
    );
  });

  it("refuses a product import without a unit or with a contradicting language filter before enqueue", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
    const missingUnitResult = await runDailyAction({
      _intent: "scope.import",
      providerKey: "ygojson",
      unitKey: "",
      languageCode: "en",
      productId: "synthetic-product",
    });
    expect(missingUnitResult.feedback.status).toBe("error");
    expect(enqueueSourceObservationIntegrationJob).not.toHaveBeenCalled();

    const conflictingFilterResult = await runDailyAction(
      {
        _intent: "scope.import",
        providerKey: "ygojson",
        unitKey: "ygojson:yugioh:sealed-product:reference-data",
        languageCode: "en",
        productId: "synthetic-product",
      },
      "https://admin.example/catalog/integrations?filter.language=ja",
    );
    expect(conflictingFilterResult.feedback.status).toBe("error");
    expect(enqueueSourceObservationIntegrationJob).not.toHaveBeenCalled();
  });
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    mockUseLoaderData.mockReset();
    mockUseNavigate.mockReset();
    mockUseRouteLoaderData.mockReset();
    mockUseActionData.mockReset();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTransientAuthResolutionError.mockReturnValue(false);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockResolveActorFromAuthApi.mockResolvedValue({
      permissions: ["catalog.view", "catalog.manage"],
    });
  });
  it("stays on the daily route and returns a job-queued result when queuing a scoped provider import", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const result = await runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgdex",
      ingestionUnitKey: "tcgdex:pokemon:card:import",
      language: "en",
      productLineId: "3",
      seriesId: "base",
      setId: "base1",
    });
    // The run-sync path stays on the daily surface (no redirect) and returns its
    // result as data so the daily route renders the command-feedback banner.
    expect(result.section).toBe("import-to-promotion");
    expect(result.context.jobId).toBe("job_import_123");
    expect(result.feedback.status).toBe("success");
    expect(result.feedback.result).toBe("job-queued");
    expect(result.feedback).toMatchObject({
      intent: "scope.import",
      target: { entity: "scope", id: "en:3:base:base1", count: 1 },
      nextStep: "monitor-job",
      undoAction: null,
    });
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.import_started",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        scopeId: "en:3:base:base1",
        profileRef: "tcgdex:2026.06.04",
        jobRefState: "present",
        promotionResult: "job-queued",
      }),
    );
  });

  it("reads the daily import receipt DOM against the actual returned job and sent scope without changing loader context", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({
      jobId: "synthetic-returned-job-A",
      status: "running",
      profileVersion: "synthetic-effective-profile-not-submitted",
      scope: { setId: "synthetic-response-scope-not-sent" },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
    const result = await runDailyAction(
      {
        _intent: "scope.import",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        jobId: "synthetic-submitted-job",
      },
      receiptRequestUrl + "&jobId=synthetic-url-job",
    );
    const requestUrl = receiptRequestUrl + "&jobId=synthetic-loader-sync-run";
    const baseOverview = controlPlaneOverview();
    const overview = controlPlaneOverview({
      unitActivity: {
        ...baseOverview.unitActivity,
        units: [
          {
            unitKey: "tcgdex:pokemon:card:import",
            recentJobs: [integrationJobSummary({ jobId: "synthetic-newer-job-B", startedAt: "2026-11-06T20:00:00Z" })],
          },
        ],
      },
    });
    const readModel = receiptRouteModel("2026.06.04", requestUrl, overview);
    const originalModel = structuredClone(readModel);
    mockUseLoaderData.mockReturnValue(loaderData({ requestUrl, readModel }));
    mockUseActionData.mockReturnValue(undefined);
    const { rerender } = render(<IntegrationsRoute />);
    const hiddenJobIds = () =>
      [...document.querySelectorAll<HTMLInputElement>('input[name="jobId"]')].map((field) => field.value);
    const originalHiddenJobIds = hiddenJobIds();
    expect(originalHiddenJobIds).toContain("synthetic-loader-sync-run");
    mockUseActionData.mockReturnValue(result);
    rerender(<IntegrationsRoute />);
    const root = document.querySelector('[data-catalog-import-job-receipt="source-observation-import-job-receipt/v1"]');
    expect(root).not.toBeNull();
    expect(isInaccessible(root!)).toBe(false);
    const expected = {
      schemaVersion: "source-observation-import-job-receipt/v1",
      jobId: "synthetic-returned-job-A",
      status: "running",
      scope: enqueueSourceObservationIntegrationJob.mock.calls[0]![1],
      submitted: { providerKey: "tcgdex", unitKey: "tcgdex:pokemon:card:import", profileVersion: "2026.06.04" },
    };
    expect(readOriginalReceiptDom(root!)).toEqual(expected);
    expect(result).toMatchObject({ importJobReceipt: expected });
    for (const excluded of [
      "synthetic-submitted-job",
      "synthetic-url-job",
      "synthetic-loader-sync-run",
      "synthetic-newer-job-B",
      "synthetic-effective-profile-not-submitted",
      "synthetic-response-scope-not-sent",
    ]) {
      expect(root!.textContent).not.toContain(excluded);
    }
    expect(readModel).toEqual(originalModel);
    expect(readModel.importJobs.jobs.map((job) => job.jobId)).toContain("synthetic-newer-job-B");
    expect(document.querySelector('[data-catalog-import-job-id="synthetic-newer-job-B"]')).not.toBeNull();
    expect(hiddenJobIds()).toEqual(originalHiddenJobIds);
    for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      expect(link.href).not.toContain("synthetic-returned-job-A");
    }
    expect(mockUseNavigate).not.toHaveBeenCalled();
    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledTimes(1);
    const clientCalls = mockCreateCatalogRequestApiClient.mock.calls.length;
    mockUseActionData.mockReturnValue(null);
    rerender(<IntegrationsRoute />);
    expect(readOriginalReceiptDom(document.querySelector("[data-catalog-import-job-receipt]")!)).toEqual(expected);
    mockUseNavigation.mockReturnValue({ state: "submitting" });
    rerender(<IntegrationsRoute />);
    expect(document.querySelector("[data-catalog-import-job-receipt]")).toBeNull();
    mockUseActionData.mockReturnValue({
      ...result,
      feedback: { ...result.feedback, intent: "observation.review", result: "command-failed", status: "error" },
    });
    mockUseNavigation.mockReturnValue({ state: "idle" });
    rerender(<IntegrationsRoute />);
    expect(document.querySelector("[data-catalog-import-job-receipt]")).toBeNull();
    mockUseActionData.mockReturnValue(undefined);
    rerender(<IntegrationsRoute />);
    expect(document.querySelector("[data-catalog-import-job-receipt]")).toBeNull();
    expect(mockCreateCatalogRequestApiClient).toHaveBeenCalledTimes(clientCalls);
  });

  it("shows no receipt while the actual import enqueue is pending, then shows its settled response", async () => {
    let settle!: (job: { jobId: string; status: string }) => void;
    const enqueueSourceObservationIntegrationJob = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
    const pendingAction = runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });
    mockUseLoaderData.mockReturnValue(loaderData({ requestUrl: receiptRequestUrl, readModel: receiptRouteModel() }));
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "submitting" });
    const view = render(<IntegrationsRoute />);
    expect(document.querySelector("[data-catalog-import-job-receipt]")).toBeNull();
    settle({ jobId: "synthetic-settled-job", status: "queued" });
    const result = await pendingAction;
    mockUseActionData.mockReturnValue(result);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    view.rerender(<IntegrationsRoute />);
    const root = document.querySelector("[data-catalog-import-job-receipt]");
    expect(root).not.toBeNull();
    expect(readOriginalReceiptDom(root!)).toMatchObject({
      jobId: "synthetic-settled-job",
      status: "queued",
      scope: enqueueSourceObservationIntegrationJob.mock.calls[0]![1],
      submitted: { providerKey: "tcgdex", unitKey: "tcgdex:pokemon:card:import", profileVersion: "2026.06.04" },
    });
    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledTimes(1);
    expect(mockUseNavigate).not.toHaveBeenCalled();
  });

  it.each([undefined, "", 42])(
    "shows unavailable for producer job ID %s, never the non-null submitted fallback",
    async (jobId) => {
      const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId, status: "queued" });
      mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
      const result = await runDailyAction({
        _intent: "scope.import",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        jobId: "synthetic-fallback-must-not-render",
      });
      mockUseLoaderData.mockReturnValue(loaderData({ requestUrl: receiptRequestUrl, readModel: receiptRouteModel() }));
      mockUseActionData.mockReturnValue(result);
      render(<IntegrationsRoute />);
      const root = document.querySelector("[data-catalog-import-job-receipt]");
      expect(root).not.toBeNull();
      expect(readOriginalReceiptDom(root!)).toMatchObject({ jobId: null, status: "queued" });
      expect(root!.querySelector('[data-catalog-receipt-field="jobId"]')!.textContent).toMatch(
        /not returned|unavailable/i,
      );
      expect(root!.textContent).not.toContain("synthetic-fallback-must-not-render");
    },
  );

  it.each([undefined, 42])("shows unavailable for producer status %s without inventing queued", async (status) => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "synthetic-status-job", status });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
    const result = await runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
    });
    mockUseLoaderData.mockReturnValue(loaderData({ requestUrl: receiptRequestUrl, readModel: receiptRouteModel() }));
    mockUseActionData.mockReturnValue(result);
    render(<IntegrationsRoute />);
    const root = document.querySelector("[data-catalog-import-job-receipt]");
    expect(root).not.toBeNull();
    expect(readOriginalReceiptDom(root!)).toMatchObject({ jobId: "synthetic-status-job", status: null });
    expect(root!.querySelector('[data-catalog-receipt-field="status"]')!.textContent).toMatch(
      /not returned|unavailable/i,
    );
  });

  it("renders only allowed escaped import receipt scalars and excludes injected response extras", async () => {
    const jobId = '<img src=x onerror="synthetic()">';
    const status = "<script>synthetic()</script>";
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({
      jobId,
      status,
      nested: { jobId: "synthetic-nested-secret" },
      headers: "synthetic-header-secret",
      credentials: "synthetic-credential-secret",
      error: { detail: "synthetic-error-secret" },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
    const result = await runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });
    mockUseLoaderData.mockReturnValue(loaderData({ requestUrl: receiptRequestUrl, readModel: receiptRouteModel() }));
    mockUseActionData.mockReturnValue(result);
    render(<IntegrationsRoute />);
    const root = document.querySelector("[data-catalog-import-job-receipt]");
    expect(root).not.toBeNull();
    expect(readOriginalReceiptDom(root!)).toEqual({
      schemaVersion: "source-observation-import-job-receipt/v1",
      jobId,
      status,
      scope: enqueueSourceObservationIntegrationJob.mock.calls[0]![1],
      submitted: { providerKey: "tcgdex", unitKey: "tcgdex:pokemon:card:import", profileVersion: "2026.06.04" },
    });
    expect(root!.querySelector("img,script,a")).toBeNull();
    expect(root!.innerHTML).toContain("&lt;img");
    expect(root!.textContent).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-credential-secret");
  });

  it("never renders import job identity for failed or refused actual actions", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockRejectedValue(new Error("synthetic-failed-identity"));
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
    for (const providerKey of ["tcgdex", ""]) {
      const result = await runDailyAction({
        _intent: "scope.import",
        providerKey,
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        jobId: "synthetic-failed-identity",
      });
      expect(result.feedback.status).toBe("error");
      mockUseLoaderData.mockReturnValue(loaderData({ requestUrl: receiptRequestUrl, readModel: receiptRouteModel() }));
      mockUseActionData.mockReturnValue(result);
      const view = render(<IntegrationsRoute />);
      expect(document.querySelector("[data-catalog-import-job-receipt]")).toBeNull();
      view.unmount();
    }
  });

  it("enqueues a scope-first Catalog sync run and carries the parent run id", async () => {
    const enqueueCatalogSyncRun = vi.fn().mockResolvedValue({ syncRunId: "catalog_sync_run_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueCatalogSyncRun,
    });

    const response = await runDailyActionRedirect({
      _intent: "scope.sync",
      productDomain: "pokemon",
      productForm: "single-card",
      languageCode: "ja",
      referenceKind: "expansion",
      referenceId: "SV8",
      referenceName: "Super Electric Breaker",
      seriesId: "SV",
      seriesName: "Scarlet & Violet",
      expansionId: "SV8",
      expansionName: "Super Electric Breaker",
      selectedUnitKeys: "tcgdex:pokemon:single-card:source-observation-import",
      excludedUnitKeys: "",
    });
    const location = redirectLocation(response);

    expect(enqueueCatalogSyncRun).toHaveBeenCalledWith({
      scopeVersion: "catalog-sync-scope-v2",
      productDomain: "pokemon",
      productForm: "single-card",
      languageCode: "ja",
      reference: {
        kind: "expansion",
        scopeRecordId: "SV8",
      },
      providerParticipation: {
        requiredUnitKeys: [],
        selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
        excludedUnitKeys: [],
      },
    });
    expect(location.searchParams.get("jobId")).toBe("catalog_sync_run_123");
    expect(location.searchParams.get("commandStatus")).toBe("success");
    expect(location.searchParams.get("commandIntent")).toBe("scope.sync");
    expect(location.searchParams.get("commandResult")).toBe("job-queued");
    expect(location.searchParams.get("importScope")).toBe("ja:SV:SV8");
  });

  it("resolves a set-name Catalog sync run to its scope record without carrying provider coordinates", async () => {
    const enqueueCatalogSyncRun = vi.fn().mockResolvedValue({ syncRunId: "catalog_sync_run_tcgplayer_base" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueCatalogSyncRun,
    });

    const response = await runDailyActionRedirect(
      {
        _intent: "scope.sync",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        referenceKind: "set",
        scopeRecordId: "scope_pokemon_base_set",
        selectedUnitKeys: "tcgplayer:pokemon:single-card:source-observation-import",
        // Any legacy provider-coordinate form fields are ignored — coordinates
        // come from accepted Provider Scope Mappings server-side.
        providerHints: JSON.stringify({
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          productLineId: "3",
          setName: "Base Set",
        }),
      },
      "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:pokemon:single-card:source-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base%20Set",
    );
    const location = redirectLocation(response);

    expect(enqueueCatalogSyncRun).toHaveBeenCalledWith({
      scopeVersion: "catalog-sync-scope-v2",
      productDomain: "pokemon",
      productForm: "single-card",
      languageCode: "en",
      reference: {
        kind: "set",
        scopeRecordId: "scope_pokemon_base_set",
      },
      providerParticipation: {
        requiredUnitKeys: [],
        selectedUnitKeys: ["tcgplayer:pokemon:single-card:source-observation-import"],
        excludedUnitKeys: [],
      },
    });
    const enqueuedScope = enqueueCatalogSyncRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(enqueuedScope).not.toHaveProperty("providerHints");
    expect(location.searchParams.get("jobId")).toBe("catalog_sync_run_tcgplayer_base");
    expect(location.searchParams.get("commandIntent")).toBe("scope.sync");
    expect(location.searchParams.get("commandResult")).toBe("job-queued");
  });

  it("keeps Catalog sync scope API blockers specific without leaking raw provider errors", async () => {
    const enqueueCatalogSyncRun = vi.fn().mockRejectedValue(
      new CatalogApiError(400, {
        error: {
          code: "invalid_scope",
          message: "provider secret leaked",
        },
      }),
    );
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueCatalogSyncRun,
    });

    const result = await runDailyAction(
      {
        _intent: "scope.sync",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        referenceKind: "set",
        referenceId: "Base Set",
        referenceName: "Base Set",
        selectedUnitKeys: "tcgplayer:pokemon:single-card:source-observation-import",
        providerHints: JSON.stringify({
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          productLineId: "3",
          setName: "Base Set",
        }),
      },
      "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:pokemon:single-card:source-observation-import&languageCode=en&productLineId=3&expansionName=Base%20Set",
    );

    expect(enqueueCatalogSyncRun).toHaveBeenCalled();
    expect(result.feedback).toMatchObject({
      status: "error",
      intent: "scope.sync",
      result: "catalog-sync-blocked",
    });
    expect(JSON.stringify(result)).not.toContain("provider secret leaked");
  });

  it("queues a TCGdex native language-series-set scope as a concrete expansion import", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_ja_sv8" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    await runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      importScope: "ja:SV:SV8",
      profileVersion: "2026.06.03",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgdex",
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
      language: "ja",
      seriesId: "SV",
      setId: "SV8",
    });
  });

  it("queues provider imports from structured scope fields without requiring legacy importScope", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_structured" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const result = await runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: "SV8",
      profileVersion: "2026.06.03",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgdex",
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
      language: "ja",
      seriesId: "SV",
      setId: "SV8",
    });
    expect(result.context.importScope).toBe("ja:SV:SV8");
    expect(result.context.scope).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: "SV8",
    });
  });

  it("queues shared source-scope workset row imports with the selected ingestion unit and set scope", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_magic_5dn" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const result = await runDailyAction({
      _intent: "scope.import",
      providerKey: "mtgjson",
      unitKey: "mtgjson:mtg:single-card:reference-data",
      importScope: "en:5DN",
      languageCode: "en",
      productLineName: "Magic: The Gathering",
      seriesId: "",
      expansionId: "5DN",
      expansionName: "Fifth Dawn",
      profileVersion: "2026.06.19",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "mtgjson",
      ingestionUnitKey: "mtgjson:mtg:single-card:reference-data",
      language: "en",
      setId: "5DN",
      setName: "Fifth Dawn",
    });
    expect(result.feedback.result).toBe("job-queued");
    expect(result.context.jobId).toBe("job_magic_5dn");
  });

  it("queues TCGplayer set-name imports as setName, not a setId fallback", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_tcgplayer_classic_sixth" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const result = await runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgplayer",
      unitKey: "tcgplayer:mtg:single-card:source-observation-import",
      importScope: "en:1:Classic Sixth Edition",
      languageCode: "en",
      productLineId: "1",
      productLineName: "Magic: The Gathering",
      seriesId: "",
      seriesName: "",
      expansionId: "",
      expansionName: "Classic Sixth Edition",
      profileVersion: "2026.06.19",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgplayer",
      ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
      language: "en",
      productLineId: "1",
      setName: "Classic Sixth Edition",
    });
    expect(result.context.scope).toMatchObject({
      providerKey: "tcgplayer",
      languageCode: "en",
      productLineId: "1",
      expansionId: null,
      expansionName: "Classic Sixth Edition",
    });
    expect(result.context.importScope).toBe("en:1:Classic Sixth Edition");
  });

  it("does not enqueue a provider import until a concrete source scope is selected", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_provider_wide" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const result = await runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      profileVersion: "2026.06.03",
    });

    expect(enqueueSourceObservationIntegrationJob).not.toHaveBeenCalled();
    expect(result.section).toBe("import-to-promotion");
    expect(result.context.jobId).toBeNull();
    expect(result.feedback).toMatchObject({
      status: "error",
      intent: "scope.import",
      result: "command-failed",
    });
  });

  it("does not fall back to a stale URL importScope when the command form explicitly clears scope", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_stale_scope" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const result = await runDailyAction(
      {
        _intent: "scope.import",
        providerKey: "ygoprodeck",
        unitKey: "ygoprodeck:yugioh:single-card:reference-data",
        importScope: "",
        languageCode: "",
        seriesId: "",
        expansionId: "",
        expansionName: "",
        profileVersion: "2026.06.21",
      },
      "https://admin.example/catalog/integrations?providerKey=ygoprodeck&unitKey=ygoprodeck%3Ayugioh%3Asingle-card%3Areference-data&importScope=ja%3ASV%3ASV8&seriesId=SV&expansionId=SV8",
    );

    expect(enqueueSourceObservationIntegrationJob).not.toHaveBeenCalled();
    expect(result.context.importScope).toBeNull();
    expect(result.context.scope).toMatchObject({
      providerKey: "ygoprodeck",
      languageCode: null,
      seriesId: null,
      expansionId: null,
      expansionName: null,
    });
    expect(result.feedback).toMatchObject({
      status: "error",
      intent: "scope.import",
      result: "command-failed",
    });
  });

  it("preserves selected IDs while carrying the Catalog API's promotion preview token", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      validation: emptyPromotionValidation(),
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "changed", search: "" },
      previewToken: "spp1.selected",
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservationIds });

    const result = await runDailyAction(
      {
        _intent: "observation.promote",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        selectedObservationIds: " obs_001,obs_001 ",
      },
      "https://admin.example/catalog/integrations?filter.status=changed",
    );
    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledWith(["obs_001"], {
      promoteAsDraft: false,
      confirmation: {
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        scope: expect.objectContaining({ provider: "tcgdex", setId: "base1" }),
      },
    });
    expect(result.context.selectedObservationIds).toEqual(["obs_001"]);
    expect(result.feedback.result).toBe("preview-ready");
    expect(result.context.promotionPreviewId).toBe("spp1.selected");
  });

  it("renders the original action receipt instead of loader validation and keeps its token out of links", async () => {
    window.sessionStorage.clear();
    const original = syntheticPromotionReceipt().preview;
    original.matched = 7;
    original.terminal = 6;
    original.validation.coveredObservationIds = ["synthetic-returned-not-submitted"];
    original.validation.diagnostics = [
      {
        observationId: "synthetic-returned-not-submitted",
        code: "synthetic-warning",
        path: "synthetic-path",
        diagnosticText: "<img src=x onerror=synthetic()> is plain text",
        blocking: false,
        displayIdentity: {
          missingTokens: ["synthetic-missing"],
          templateKey: "https://example.invalid/synthetic-not-a-link",
          templateTargetKind: "blueprint",
          templateTargetId: "synthetic-target",
          templateReason: "missing-required-fields",
        },
      },
    ];
    const previewBulkPromoteSourceObservationIds = vi
      .fn()
      .mockResolvedValue(syntheticPromotionPreviewResponse(original));
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservationIds });
    const result = await runDailyAction({
      _intent: "observation.promote",
      promotionPhase: "preview",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
    });
    expect(result.promotionReceipt?.preview).toEqual(original);
    expect(result.promotionReceipt?.previewId).toBe(result.context.promotionPreviewId);
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04";
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
    });
    mockUseLoaderData.mockReturnValue(loaderData({ requestUrl, readModel }));
    mockUseActionData.mockReturnValue(result);
    const { rerender } = render(<IntegrationsRoute />);
    const disclosure = screen
      .getAllByRole("button", { name: /Preview promotion/ })
      .find((button) => button.hasAttribute("aria-expanded"));
    expect(disclosure).toBeTruthy();
    fireEvent.click(disclosure!);
    const receiptNode = document.querySelector(
      '[data-catalog-promotion-receipt="source-observation-promotion-receipt/v1"]',
    );
    expect(receiptNode).not.toBeNull();
    expect(readOriginalReceiptDom(receiptNode!)).toEqual(result.promotionReceipt);
    expect(receiptNode?.textContent).toContain("synthetic-returned-not-submitted");
    expect(
      receiptNode?.querySelector('[data-catalog-receipt-field="preview.validation.coveredObservationIds.0"]')
        ?.textContent,
    ).not.toBe("obs_001");
    expect(receiptNode?.querySelector("img,a,script")).toBeNull();
    expect(receiptNode?.innerHTML).toContain("&lt;img");
    expect(mockUseNavigate).not.toHaveBeenCalled();
    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1);
    for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      expect(link.href).not.toContain("promotionPreviewId");
      expect(link.href).not.toContain(original.fingerprint);
    }
    expect(screen.getByLabelText(/I confirm this will promote/).hasAttribute("disabled")).toBe(true);
    mockUseActionData.mockReturnValue(undefined);
    rerender(<IntegrationsRoute />);
    expect(document.querySelector("[data-catalog-promotion-receipt]")).toBeNull();
    expect(screen.getByLabelText(/I confirm this will promote/).hasAttribute("disabled")).toBe(true);
  });

  it.each(["empty", "partial", "complete"] as const)(
    "renders the complete typed original receipt for a %s page",
    (coverage) => {
      const receipt = syntheticPromotionReceipt();
      receipt.preview.matched = 3;
      receipt.preview.eligible = coverage === "empty" ? 0 : 3;
      receipt.selection.observationIds = ["synthetic-c", "synthetic-a", "synthetic-b"];
      receipt.preview.validation.coveredObservationIds =
        coverage === "empty" ? [] : ["synthetic-b", "synthetic-c", "synthetic-a"];
      receipt.preview.validation.coverage = coverage === "partial" ? "partial" : "complete";
      receipt.preview.validation.continuation = coverage === "partial" ? "synthetic-next-page" : null;
      receipt.preview.validation.diagnostics =
        coverage === "empty"
          ? []
          : [
              {
                observationId: "synthetic-c",
                code: "synthetic-warning",
                path: "facts",
                diagnosticText: "synthetic-text",
                blocking: false,
              },
              {
                observationId: "synthetic-a",
                code: "synthetic-identity",
                path: "displayIdentity",
                diagnosticText: "synthetic-identity-text",
                blocking: false,
                displayIdentity: {
                  missingTokens: [],
                  templateKey: null,
                  templateTargetKind: null,
                  templateTargetId: null,
                  templateReason: "no-targeted-template",
                },
              },
            ];
      const model = loaderData().readModel;
      const readModel = {
        ...model,
        promotionPreview: { ...model.promotionPreview, previewId: receipt.previewId, receipt },
      };
      render(
        <CatalogIntegrationCreateItemsStage
          readModel={readModel}
          selectedObservationIds={receipt.selection.observationIds}
        />,
      );
      const disclosure = screen
        .getAllByRole("button", { name: /Preview promotion/ })
        .find((button) => button.hasAttribute("aria-expanded"));
      fireEvent.click(disclosure!);
      const node = document.querySelector("[data-catalog-promotion-receipt]");
      expect(node).not.toBeNull();
      expect(readOriginalReceiptDom(node!)).toEqual(receipt);
      const emptyArrayPaths =
        coverage === "empty"
          ? ["preview.validation.coveredObservationIds", "preview.validation.diagnostics"]
          : ["preview.validation.diagnostics.1.displayIdentity.missingTokens"];
      for (const path of emptyArrayPaths) {
        const array = node!.querySelector(`[data-catalog-receipt-array="${path}"]`)!;
        expect(isInaccessible(within(array as HTMLElement).getByText(path, { exact: true }))).toBe(false);
        expect(isInaccessible(within(array as HTMLElement).getByText("None", { exact: true }))).toBe(false);
      }
      const nullField = node!.querySelector('[data-catalog-receipt-field="selection.scopeRecordId"]')!;
      expect(nullField.textContent).toBe("null");
      expect(isInaccessible(nullField)).toBe(false);
      expect(node?.querySelector("input,textarea,script,a")).toBeNull();
      expect(screen.getByLabelText(/I confirm this will promote/).hasAttribute("disabled")).toBe(true);
    },
  );

  it.each([
    [undefined, "Not returned"],
    ["", "Empty string"],
    ["synthetic-search", "synthetic-search"],
  ] as const)("renders the localized scalar state for selected search %s", (search, expectedText) => {
    const receipt = syntheticPromotionReceipt();
    receipt.selection.scope.search = search;
    const model = loaderData().readModel;
    render(
      <CatalogIntegrationCreateItemsStage
        readModel={{ ...model, promotionPreview: { ...model.promotionPreview, previewId: receipt.previewId, receipt } }}
        selectedObservationIds={receipt.selection.observationIds}
      />,
    );
    const disclosure = screen
      .getAllByRole("button", { name: /Preview promotion/ })
      .find((button) => button.hasAttribute("aria-expanded"));
    fireEvent.click(disclosure!);
    const node = document.querySelector("[data-catalog-promotion-receipt]")!;
    expect(readOriginalReceiptDom(node)).toEqual(receipt);
    const field = node.querySelector('[data-catalog-receipt-field="selection.scope.search"]')!;
    expect(field.textContent).toBe(expectedText);
    expect(isInaccessible(field)).toBe(false);
  });

  it("binds confirmation and execute to the action token, invalidates observed drift, and rebinds only a new Preview", async () => {
    window.sessionStorage.clear();
    const original = syntheticPromotionReceipt().preview;
    const previewBulkPromoteSourceObservationIds = vi
      .fn()
      .mockResolvedValue(syntheticPromotionPreviewResponse(original));
    const bulkPromoteSourceObservations = vi.fn().mockResolvedValue({ jobId: "synthetic-receipt-job" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      previewBulkPromoteSourceObservationIds,
      bulkPromoteSourceObservations,
    });
    const fields = {
      _intent: "observation.promote",
      promotionPhase: "preview",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
    };
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04";
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
    });
    writePersistedObservationSelection(observationSelectionScopeKey(readModel.routeContext), ["obs_001"]);
    mockUseLoaderData.mockReturnValue(loaderData({ requestUrl, readModel }));
    const { rerender } = render(<IntegrationsRoute />);
    mockUseNavigation.mockReturnValue({ state: "submitting" });
    rerender(<IntegrationsRoute />);
    const result = await runDailyAction(fields);
    mockUseActionData.mockReturnValue(result);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    rerender(<IntegrationsRoute />);
    const confirmation = screen.getByLabelText(/I confirm this will promote/);
    expect(confirmation.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirmation);
    const commit = screen.getByRole("button", { name: "Create or update Catalog Items" }) as HTMLButtonElement;
    expect(commit.disabled).toBe(false);
    expect(commit.form?.querySelector<HTMLInputElement>('[name="promotionPreviewId"]')?.value).toBe(
      result.promotionReceipt?.previewId,
    );
    expect(commit.form?.action).not.toContain("promotionPreviewId");
    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1);
    expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();

    mockUseNavigation.mockReturnValue({ state: "submitting" });
    rerender(<IntegrationsRoute />);
    expect(confirmation.hasAttribute("disabled")).toBe(true);
    expect(commit.disabled).toBe(true);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    rerender(<IntegrationsRoute />);
    expect(confirmation.hasAttribute("disabled")).toBe(true);
    mockUseActionData.mockReturnValue(await runDailyAction(fields));
    rerender(<IntegrationsRoute />);
    expect(confirmation.hasAttribute("disabled")).toBe(false);

    const drifted = {
      ...readModel,
      sourceObservationReview: {
        ...readModel.sourceObservationReview,
        rows: readModel.sourceObservationReview.rows.map((row) => ({ ...row, changedAt: "2026-11-06T00:00:00Z" })),
      },
    };
    mockUseLoaderData.mockReturnValue(loaderData({ requestUrl, readModel: drifted }));
    rerender(<IntegrationsRoute />);
    expect(confirmation.hasAttribute("disabled")).toBe(true);
    expect(commit.disabled).toBe(true);
    mockUseLoaderData.mockReturnValue(loaderData({ requestUrl, readModel }));
    rerender(<IntegrationsRoute />);
    expect(confirmation.hasAttribute("disabled")).toBe(true);

    const renewed = await runDailyAction(fields);
    mockUseActionData.mockReturnValue(renewed);
    rerender(<IntegrationsRoute />);
    expect(confirmation.hasAttribute("disabled")).toBe(false);
    expect(commit.disabled).toBe(true);
    fireEvent.click(confirmation);
    const submitted = Object.fromEntries(
      [...new FormData(commit.form!).entries()].map(([key, value]) => [key, String(value)]),
    );
    expect(submitted.promotionPreviewId).toBe(renewed.promotionReceipt?.previewId);
    const queued = await runDailyActionRedirect(submitted, requestUrl);
    expect(redirectLocation(queued).searchParams.get("jobId")).toBe("synthetic-receipt-job");
    expect(bulkPromoteSourceObservations).toHaveBeenCalledWith(
      ["obs_001"],
      expect.objectContaining({ promoteAsDraft: false, previewToken: renewed.promotionReceipt!.previewId }),
    );
    expect(JSON.stringify(window.sessionStorage)).not.toContain(original.fingerprint);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(renewed.promotionReceipt!.previewId);
  });

  it("retains Scope Detail Preview data while preserving its queued-job handoff", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue(syntheticPromotionPreviewResponse());
    const bulkPromoteSourceObservations = vi.fn().mockResolvedValue({ jobId: "synthetic-scope-receipt-job" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      previewBulkPromoteSourceObservationIds,
      bulkPromoteSourceObservations,
    });
    const fields = {
      _intent: "observation.promote",
      promotionPhase: "preview",
      providerKey: "tcgdex",
      scopeRecordId: "synthetic-scope-record",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
    };
    const result = await scopeDetailAction(
      actionRequest(fields, "https://admin.example/catalog/scopes/synthetic-scope-record"),
    );
    expect(result.promotionReceipt?.selection.scopeRecordId).toBe("synthetic-scope-record");
    expect(commandResultNeedsRoutableHandoff(result)).toBe(false);
    const queued = await scopeDetailAction(
      actionRequest(
        { ...fields, promotionPhase: "execute", promotionPreviewId: result.promotionReceipt!.previewId },
        "https://admin.example/catalog/scopes/synthetic-scope-record",
      ),
    );
    expect(queued.feedback.result).toBe("job-queued");
    expect(commandResultNeedsRoutableHandoff(queued)).toBe(true);
    expect(queued.context.jobId).toBe("synthetic-scope-receipt-job");
    expect(queued.promotionReceipt).toBeUndefined();
  });

  it("independently refuses mismatched action and loader bindings without substituting original evidence", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue(syntheticPromotionPreviewResponse());
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservationIds });
    const actionResult = await runDailyAction({
      _intent: "observation.promote",
      promotionPhase: "preview",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
    });
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04";
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
    });
    const data = loaderData({ requestUrl, readModel });
    const positive = renderHook(() => useOriginalPromotionReceipt(data, actionResult, false));
    expect(positive.result.current.promotionPreview.executionSafeguards.previewFresh).toBe(true);
    positive.unmount();
    const controls: Parameters<typeof useOriginalPromotionReceipt>[] = [
      [data, { ...actionResult, context: { ...actionResult.context, promotionPreviewId: "synthetic-token-b" } }, false],
      [
        data,
        { ...actionResult, context: { ...actionResult.context, selectedObservationIds: ["synthetic-other-id"] } },
        false,
      ],
      [data, { ...actionResult, context: { ...actionResult.context, promoteAsDraft: true } }, false],
      [
        {
          ...data,
          readModel: {
            ...readModel,
            routeContext: { ...readModel.routeContext, providerKey: "synthetic-other-provider" },
          },
        },
        actionResult,
        false,
      ],
      [
        {
          ...data,
          readModel: {
            ...readModel,
            promotionPreview: { ...readModel.promotionPreview, currentFingerprint: "synthetic-fingerprint-b" },
          },
        },
        actionResult,
        false,
      ],
      [
        {
          ...data,
          readModel: {
            ...readModel,
            promotionPreview: { ...readModel.promotionPreview, previewId: "synthetic-token-b" },
          },
        },
        actionResult,
        false,
      ],
      [
        { ...data, readModel: { ...readModel, readiness: { ...readModel.readiness, rbacAllowed: false } } },
        actionResult,
        false,
      ],
      [
        {
          ...data,
          readModel: {
            ...readModel,
            sourceObservationReview: { ...readModel.sourceObservationReview, freshness: "stale" },
          },
        },
        actionResult,
        false,
      ],
      [
        {
          ...data,
          readModel: {
            ...readModel,
            promotionPreview: { ...readModel.promotionPreview, blockers: ["permission-denied"] },
          },
        },
        actionResult,
        false,
      ],
      [data, actionResult, true],
    ];
    for (const args of controls) {
      const probe = renderHook(() => useOriginalPromotionReceipt(...args));
      expect(probe.result.current.promotionPreview.executionSafeguards.previewFresh).toBe(false);
      expect(probe.result.current.promotionPreview.receipt).toEqual(actionResult.promotionReceipt);
      expect(probe.result.current.routeContext.promotionPreviewId).toBeNull();
      probe.unmount();
    }
    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledTimes(1);
  });

  it("does not expose failed or missing Preview payloads as receipts", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservationIds });
    const fields = {
      _intent: "observation.promote",
      promotionPhase: "preview",
      providerKey: "tcgdex",
      selectedObservationIds: "obs_001",
    };
    for (const missing of [undefined, { ...syntheticPromotionReceipt().preview, validation: undefined }]) {
      previewBulkPromoteSourceObservationIds.mockResolvedValueOnce(missing);
      const result = await runDailyAction(fields);
      expect(result.feedback.status).toBe("error");
      expect(result.promotionReceipt).toBeUndefined();
    }
    previewBulkPromoteSourceObservationIds.mockRejectedValueOnce(new Error("synthetic-private-exception"));
    const failed = await runDailyAction(fields);
    expect(failed.feedback.status).toBe("error");
    expect(JSON.stringify(failed)).not.toContain("synthetic-private-exception");
  });

  it("previews the matching TCGdex scope without silently narrowing fresh observations out", async () => {
    const previewBulkPromoteSourceObservations = vi.fn().mockResolvedValue({
      matched: 124,
      eligible: 124,
      terminal: 0,
      validation: emptyPromotionValidation(),
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
      previewToken: "spp1.scope",
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservations });

    const result = await runDailyAction({
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });
    expect(previewBulkPromoteSourceObservations).toHaveBeenCalledWith(
      {
        provider: "tcgdex",
        language: "en",
        productLineId: "3",
        seriesId: "base",
        expansionId: "base1",
        setId: "base1",
      },
      { promoteAsDraft: false, confirmation: reviewPage },
    );
    expect(result.feedback.result).toBe("preview-ready");
    expect(result.context.promotionPreviewId).toBe("spp1.scope");
  });

  it("fails closed when a scope preview has provider and unit but no concrete scope", async () => {
    const previewBulkPromoteSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservations });

    const result = await runDailyAction({
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      profileVersion: "2026.06.04",
    });

    expect(previewBulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("command-failed");
    expect(result.context.promotionPreviewId).toBeNull();
  });

  it("bridges profile draft creation through the typed provider profile clone API", async () => {
    const cloneSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04-draft",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      cloneSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderDetailAction({
      _intent: "provider-profile.clone",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      sourceProviderKey: "tcgdex",
      sourceProfileVersion: "2026.06.04",
      targetProfileVersion: "2026.06.04-draft",
      targetLifecycle: "draft",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(cloneSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.04", {
      targetProfileVersion: "2026.06.04-draft",
      lifecycle: "draft",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("profileVersion=2026.06.04-draft");
    // The v2 Provider detail page carries only entity references (providerKey,
    // profileVersion) — no daily-review selection/preview state (#3832).
    expect(response.headers.get("Location")).not.toContain("selectedObservationIds=");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(response.headers.get("Location")).toContain("commandStatus=success");
    expect(response.headers.get("Location")).toContain("commandResult=draft-created");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_draft_created",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        scopeId: "en:3:base:base1",
        profileRef: "tcgdex:2026.06.04-draft",
        promotionResult: "draft-created",
        detourTarget: "profile-authoring",
        detourOutcome: "returned",
      }),
    );
  });

  it("fails closed when profile draft creation receives a non-draft lifecycle", async () => {
    const cloneSourceObservationProviderProfile = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ cloneSourceObservationProviderProfile });

    const response = await runProviderDetailAction({
      _intent: "provider-profile.clone",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      sourceProviderKey: "tcgdex",
      sourceProfileVersion: "2026.06.04",
      targetProfileVersion: "2026.06.04-test",
      targetLifecycle: "test",
    });

    expect(cloneSourceObservationProviderProfile).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=invalid-intent");
  });

  it("bridges guided profile section saves through the typed section PATCH API", async () => {
    const getSourceObservationProviderProfileAuthoringModel = vi.fn().mockResolvedValue(
      profileAuthoringModel({
        review: profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" }),
      }),
    );
    const updateSourceObservationProviderProfileSection = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04-draft",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getSourceObservationProviderProfileAuthoringModel,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderDetailAction({
      _intent: "provider-profile.edit-section",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04-draft",
      sectionKey: "basics",
      displayName: "TCGdex Pokemon cards draft",
      lifecycle: "draft",
      status: "planned",
      capabilities: "source-observation-import, catalog-item-promotion",
      supportedScopes: "pokemon/card",
      languageOptions: "en, fr",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(updateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "tcgdex",
      "2026.06.04-draft",
      "basics",
      expect.objectContaining({
        section: "basics",
        displayName: "TCGdex Pokemon cards draft",
        lifecycle: "draft",
        status: "planned",
        capabilities: ["source-observation-import", "catalog-item-promotion"],
        languageOptions: ["en", "fr"],
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("profileVersion=2026.06.04-draft");
    expect(response.headers.get("Location")).toContain("commandResult=section-saved");
    expect(response.headers.get("Location")).toContain("commandSection=basics");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_section_saved",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.04-draft",
        promotionResult: "section-saved",
        detourTarget: "profile-authoring",
      }),
    );
  });

  it("keeps migration-evidence saves inside validation readiness", async () => {
    const getSourceObservationProviderProfileAuthoringModel = vi.fn().mockResolvedValue(
      profileAuthoringModel({
        review: profileReview({ active: true, lifecycle: "active", profileVersion: "2026.06.04" }),
      }),
    );
    const updateSourceObservationProviderProfileSection = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getSourceObservationProviderProfileAuthoringModel,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderDetailAction(
      {
        _intent: "provider-profile.edit-section",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        sectionKey: "migration-evidence",
        migrationEvidenceText: "Dry-run and replay evidence reviewed for the activation decision.",
        migrationFixtureRunId: "fixture-run-1037",
        migrationFingerprintBefore: "sha256:active-mapping",
        migrationFingerprintAfter: "sha256:candidate-mapping",
        migrationRecordedAt: "2026-06-11T00:00:00.000Z",
        promotionPreviewId: "preview-stale",
      },
      "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04",
    );

    expect(updateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "tcgdex",
      "2026.06.04",
      "migration-evidence",
      expect.objectContaining({
        section: "migration-evidence",
        migrationEvidence: expect.objectContaining({
          evidenceText: "Dry-run and replay evidence reviewed for the activation decision.",
          fixtureRunId: "fixture-run-1037",
          mappingFingerprintBefore: "sha256:active-mapping",
          mappingFingerprintAfter: "sha256:candidate-mapping",
          recordedAt: "2026-06-11T00:00:00.000Z",
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("commandResult=section-saved");
    expect(response.headers.get("Location")).toContain("commandSection=migration-evidence");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    // The provider-profile handler keeps migration-evidence saves on validation readiness.
    // off an incoming context.section === "validation-readiness", which can no
    // longer be parsed from a URL (#3832 retires that workspace key), so this
    // section save now always returns the profile-authoring detour target. The
    // v2 page's own action ignores this field for routing — it always redirects
    // to itself — so this is a telemetry-label detail, not a behavior change.
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_section_saved",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.04",
        promotionResult: "section-saved",
        detourTarget: "profile-authoring",
        detourOutcome: "returned",
      }),
    );
  });

  it("activates provider profiles from validation readiness", async () => {
    const activateSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      activateSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderDetailAction(
      {
        _intent: "provider-profile.activate",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        selectedObservationIds: "obs_001",
        promotionPreviewId: "preview-stale",
      },
      "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04",
    );

    expect(activateSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.04");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("profileVersion=2026.06.04");
    expect(response.headers.get("Location")).not.toContain("selectedObservationIds=");
    expect(response.headers.get("Location")).toContain("commandStatus=success");
    expect(response.headers.get("Location")).toContain("commandResult=profile-activated");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_activated",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        scopeId: "en:3:base:base1",
        profileRef: "tcgdex:2026.06.04",
        promotionResult: "profile-activated",
        detourTarget: "validation-readiness",
        detourOutcome: "returned",
      }),
    );
  });

  it("runs provider profile rollback, deprecation, and retirement from lifecycle recovery", async () => {
    const rollbackSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.03",
    });
    const deprecateSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
    });
    const retireSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.02",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      rollbackSourceObservationProviderProfile,
      deprecateSourceObservationProviderProfile,
      retireSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const lifecycleUrl = "https://admin.example/catalog/providers/tcgdex";
    const rollbackResponse = await runProviderDetailAction(
      {
        _intent: "provider-profile.rollback",
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
        lifecycleConfirmation: lifecycleConfirmationValue("provider-profile.rollback", "tcgdex", "2026.06.03"),
        selectedObservationIds: "obs_001",
        promotionPreviewId: "preview-stale",
      },
      lifecycleUrl,
    );
    const deprecateResponse = await runProviderDetailAction(
      {
        _intent: "provider-profile.deprecate",
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        lifecycleConfirmation: lifecycleConfirmationValue("provider-profile.deprecate", "tcgdex", "2026.06.04"),
      },
      lifecycleUrl,
    );
    const retireResponse = await runProviderDetailAction(
      {
        _intent: "provider-profile.retire",
        providerKey: "tcgdex",
        profileVersion: "2026.06.02",
        lifecycleConfirmation: lifecycleConfirmationValue("provider-profile.retire", "tcgdex", "2026.06.02"),
      },
      lifecycleUrl,
    );

    expect(rollbackSourceObservationProviderProfile).toHaveBeenCalledWith(
      "tcgdex",
      "2026.06.03",
      lifecycleConfirmationValue("provider-profile.rollback", "tcgdex", "2026.06.03"),
    );
    expect(deprecateSourceObservationProviderProfile).toHaveBeenCalledWith(
      "tcgdex",
      "2026.06.04",
      lifecycleConfirmationValue("provider-profile.deprecate", "tcgdex", "2026.06.04"),
    );
    expect(retireSourceObservationProviderProfile).toHaveBeenCalledWith(
      "tcgdex",
      "2026.06.02",
      lifecycleConfirmationValue("provider-profile.retire", "tcgdex", "2026.06.02"),
    );
    expect(rollbackResponse.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(rollbackResponse.headers.get("Location")).toContain("commandResult=profile-rolled-back");
    expect(rollbackResponse.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(deprecateResponse.headers.get("Location")).toContain("commandResult=profile-deprecated");
    expect(retireResponse.headers.get("Location")).toContain("commandResult=profile-retired");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_rolled_back",
        detourTarget: "lifecycle-recovery",
        detourOutcome: "returned",
        promotionResult: "profile-rolled-back",
      }),
    );
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_deprecated",
        promotionResult: "profile-deprecated",
      }),
    );
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_retired",
        promotionResult: "profile-retired",
      }),
    );
  });

  it("forwards unchecked lifecycle submission and reports the API confirmation refusal", async () => {
    const retireSourceObservationProviderProfile = vi.fn().mockRejectedValue(
      new CatalogApiError(400, {
        error: { code: "lifecycle_confirmation_required", message: "Confirm this lifecycle operation." },
      }),
    );
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      retireSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderDetailAction(
      {
        _intent: "provider-profile.retire",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.02",
      },
      "https://admin.example/catalog/providers/tcgdex",
    );

    expect(retireSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.02", null);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=confirmation-required");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.blocker_hit",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.02",
        promotionResult: "confirmation-required",
        detourTarget: "lifecycle-recovery",
        detourOutcome: "blocked",
        blockerCategory: "readiness",
      }),
    );
  });

  it.each([
    ["rollback", "rollbackSourceObservationProviderProfile"],
    ["deprecate", "deprecateSourceObservationProviderProfile"],
    ["retire", "retireSourceObservationProviderProfile"],
  ] as const)("forwards raw mismatched confirmation for %s to the API", async (operation, method) => {
    const command = vi
      .fn()
      .mockRejectedValue(new CatalogApiError(400, { error: { code: "lifecycle_confirmation_required" } }));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      [method]: command,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });
    const confirmation = " confirm:provider-profile.retire:other-provider:other-version ";
    const response = await runProviderDetailAction(
      {
        _intent: `provider-profile.${operation}`,
        providerKey: "tcgdex",
        profileVersion: "2026.06.02",
        lifecycleConfirmation: confirmation,
      },
      "https://admin.example/catalog/providers/tcgdex",
    );
    expect(command).toHaveBeenCalledWith("tcgdex", "2026.06.02", confirmation);
    expect(response.headers.get("Location")).toContain("commandResult=confirmation-required");
  });

  it.each([
    [400, "other_error", "command-failed"],
    [403, "lifecycle_confirmation_required", "command-failed"],
    [500, "lifecycle_confirmation_required", "command-failed"],
    [409, "lifecycle_confirmation_required", "lifecycle-conflict"],
  ] as const)("preserves feedback for lifecycle API status %s code %s", async (status, code, result) => {
    const command = vi.fn().mockRejectedValue(new CatalogApiError(status, { error: { code } }));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      retireSourceObservationProviderProfile: command,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });
    const response = await runProviderDetailAction(
      { _intent: "provider-profile.retire", providerKey: "tcgdex", profileVersion: "2026.06.02" },
      "https://admin.example/catalog/providers/tcgdex",
    );
    expect(command).toHaveBeenCalledWith("tcgdex", "2026.06.02", null);
    expect(response.headers.get("Location")).toContain(`commandResult=${result}`);
  });

  it("returns lifecycle-scoped feedback for profile lifecycle consistency conflicts", async () => {
    const retireSourceObservationProviderProfile = vi
      .fn()
      .mockRejectedValue(new CatalogApiError(409, { error: { code: "profile_lifecycle_active_jobs" } }));
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      retireSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderDetailAction(
      {
        _intent: "provider-profile.retire",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.02",
        lifecycleConfirmation: lifecycleConfirmationValue("provider-profile.retire", "tcgdex", "2026.06.02"),
        promotionPreviewId: "preview-stale",
      },
      "https://admin.example/catalog/providers/tcgdex",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=lifecycle-conflict");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.blocker_hit",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.02",
        promotionResult: "lifecycle-conflict",
        detourTarget: "lifecycle-recovery",
        detourOutcome: "blocked",
        blockerCategory: "active-job",
      }),
    );
  });

  it("returns section-scoped feedback for stale and invalid section saves", async () => {
    const getSourceObservationProviderProfileAuthoringModel = vi.fn().mockResolvedValue(
      profileAuthoringModel({
        review: profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" }),
      }),
    );
    const updateSourceObservationProviderProfileSection = vi
      .fn()
      .mockRejectedValueOnce(new CatalogApiError(409, { error: { code: "stale" } }))
      .mockRejectedValueOnce(new CatalogApiError(400, { error: { code: "invalid" } }));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getSourceObservationProviderProfileAuthoringModel,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const conflictResponse = await runProviderDetailAction({
      _intent: "provider-profile.edit-section",
      providerKey: "tcgdex",
      profileVersion: "2026.06.04-draft",
      sectionKey: "source-contract",
      sourceOwner: "chase-sets/catalog",
      sourceDocumentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "tcgdex-proof-v1",
    });
    const invalidResponse = await runProviderDetailAction({
      _intent: "provider-profile.edit-section",
      providerKey: "tcgdex",
      profileVersion: "2026.06.04-draft",
      sectionKey: "source-contract",
      sourceOwner: "chase-sets/catalog",
      sourceDocumentPath: "",
      fixtureSetVersion: "tcgdex-proof-v1",
    });

    expect(conflictResponse.headers.get("Location")).toContain("commandResult=section-conflict");
    expect(conflictResponse.headers.get("Location")).toContain("commandSection=source-contract");
    expect(invalidResponse.headers.get("Location")).toContain("commandResult=section-invalid");
    expect(invalidResponse.headers.get("Location")).toContain("commandSection=source-contract");
  });

  it("fails closed when promotion execution has no fresh preview", async () => {
    const bulkPromoteSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkPromoteSourceObservations });

    const result = await runDailyAction({
      _intent: "observation.promote",
      promotionPhase: "execute",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
    });

    expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(result.section).toBe("import-to-promotion");
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("preview-required");
  });

  it("executes promotion with the submitted preview token and leaves the freshness check to the Catalog API", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn();
    const bulkPromoteSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_promote_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservations,
      previewBulkPromoteSourceObservationIds,
    });

    const response = await runDailyActionRedirect({
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "spp1.previewed",
    });

    expect(previewBulkPromoteSourceObservationIds).not.toHaveBeenCalled();
    expect(bulkPromoteSourceObservations).toHaveBeenCalledWith(["obs_001"], {
      promoteAsDraft: false,
      previewToken: "spp1.previewed",
      confirmation: reviewPage,
    });
    const location = redirectLocation(response);
    expect(location.pathname).toBe("/catalog/integrations");
    expect(location.searchParams.get("jobId")).toBe("job_promote_123");
    expect(location.searchParams.get("promotionPreviewId")).toBeNull();
    expect(location.searchParams.get("commandStatus")).toBe("success");
    expect(location.searchParams.get("commandResult")).toBe("job-queued");
  });

  it("carries the explicit promote-as-draft choice into the preview and the confirmed execution", async () => {
    const previewBulkPromoteSourceObservationIds = vi
      .fn()
      .mockImplementation(async (_ids: string[], options: { promoteAsDraft: boolean }) => ({
        matched: 1,
        eligible: 1,
        terminal: 0,
        scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
        validation: emptyPromotionValidation(options.promoteAsDraft),
        previewToken: options.promoteAsDraft ? "spp1.draft" : "spp1.publishable",
      }));
    // The Catalog API confirms the token against a fresh preview of the
    // submitted draft choice; a token minted for the other choice is refused.
    const bulkPromoteSourceObservations = vi
      .fn()
      .mockImplementation(async (_ids: string[], options: { promoteAsDraft: boolean; previewToken: string }) => {
        if (options.previewToken !== (options.promoteAsDraft ? "spp1.draft" : "spp1.publishable")) {
          throw new CatalogApiError(409, { error: { code: "stale_promotion_preview", message: "Preview again." } });
        }
        return { jobId: "job_promote_draft" };
      });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservations,
      previewBulkPromoteSourceObservationIds,
    });
    const baseForm = {
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
    };

    const publishablePreview = await runDailyAction({ ...baseForm, promotionPhase: "preview" });
    const draftPreview = await runDailyAction({ ...baseForm, promotionPhase: "preview", promoteAsDraft: "true" });
    const publishableToken = publishablePreview.context.promotionPreviewId!;
    const draftToken = draftPreview.context.promotionPreviewId!;

    expect(previewBulkPromoteSourceObservationIds).toHaveBeenNthCalledWith(
      1,
      ["obs_001"],
      expect.objectContaining({ promoteAsDraft: false }),
    );
    expect(previewBulkPromoteSourceObservationIds).toHaveBeenNthCalledWith(
      2,
      ["obs_001"],
      expect.objectContaining({ promoteAsDraft: true }),
    );
    expect(publishablePreview.context.promoteAsDraft).toBe(false);
    expect(draftPreview.context.promoteAsDraft).toBe(true);
    expect(publishableToken).toBe("spp1.publishable");
    expect(draftToken).toBe("spp1.draft");

    // Executing with a different choice than the previewed one is refused and re-previews.
    const changedChoice = await runDailyAction({
      ...baseForm,
      promotionPhase: "execute",
      promoteAsDraft: "true",
      promotionPreviewId: "spp1.publishable",
    });
    expect(changedChoice.feedback.status).toBe("error");
    expect(changedChoice.feedback.result).toBe("preview-required");
    expect(changedChoice.context.promotionPreviewId).toBeNull();
    expect(changedChoice.context.jobId).toBeNull();

    // Executing with the previewed draft choice carries it into the job.
    const executed = redirectLocation(
      await runDailyActionRedirect({
        ...baseForm,
        promotionPhase: "execute",
        promoteAsDraft: "true",
        promotionPreviewId: "spp1.draft",
      }),
    );
    expect(bulkPromoteSourceObservations).toHaveBeenLastCalledWith(["obs_001"], {
      promoteAsDraft: true,
      previewToken: "spp1.draft",
      confirmation: reviewPage,
    });
    expect(executed.searchParams.get("jobId")).toBe("job_promote_draft");
    expect(executed.searchParams.get("promoteAsDraft")).toBeNull();
  });

  it("asks for a new preview when the Catalog API refuses a stale promotion preview", async () => {
    const bulkPromoteSourceObservations = vi
      .fn()
      .mockRejectedValue(
        new CatalogApiError(409, { error: { code: "stale_promotion_preview", message: "Preview again." } }),
      );
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkPromoteSourceObservations });

    const result = await runDailyAction({
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "spp1.content-a",
    });

    expect(bulkPromoteSourceObservations).toHaveBeenCalledWith(["obs_001"], {
      promoteAsDraft: false,
      previewToken: "spp1.content-a",
      confirmation: reviewPage,
    });
    expect(result.context.promotionPreviewId).toBeNull();
    expect(result.context.jobId).toBeNull();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("preview-required");
  });

  // The Catalog API binds the review page into the token: here it is stood in
  // for by a client whose token names the page and which refuses another one.
  it.each([
    ["the same page", {}, "job-queued"],
    ["another profile version", { profileVersion: "2026.06.05" }, "preview-required"],
    ["another ingestion unit", { unitKey: "tcgdex:pokemon:sealed:import" }, "preview-required"],
    ["another import scope", { importScope: "en:3:base:base2" }, "preview-required"],
  ])("sends the review page with the preview and the execution: %s", async (_name, changed, expected) => {
    type Page = { unitKey: string | null; importScope: string | null; profileVersion: string | null };
    const tokenFor = (page: Page) => `spp1.${page.unitKey}|${page.importScope}|${page.profileVersion}`;
    const previewBulkPromoteSourceObservationIds = vi.fn(async (_ids: string[], options: { confirmation: Page }) => ({
      matched: 1,
      eligible: 1,
      terminal: 0,
      validation: emptyPromotionValidation(),
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
      previewToken: tokenFor(options.confirmation),
    }));
    const bulkPromoteSourceObservations = vi.fn(
      async (_ids: string[], options: { previewToken: string; confirmation: Page }) => {
        if (options.previewToken !== tokenFor(options.confirmation)) {
          throw new CatalogApiError(409, { error: { code: "stale_promotion_preview", message: "Preview again." } });
        }
        return { jobId: "job_promote_page" };
      },
    );
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservations,
      previewBulkPromoteSourceObservationIds,
    });
    const page = {
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
    };

    const preview = await runDailyAction({ ...page, promotionPhase: "preview" });
    const execute = {
      ...page,
      ...changed,
      promotionPhase: "execute",
      promotionPreviewId: preview.context.promotionPreviewId ?? "",
    };
    // A queued job redirects to the page that follows it; a refusal answers in place.
    const result =
      expected === "job-queued"
        ? redirectLocation(await runDailyActionRedirect(execute)).searchParams.get("commandResult")
        : (await runDailyAction(execute)).feedback.result;

    expect(bulkPromoteSourceObservations).toHaveBeenCalledWith(
      ["obs_001"],
      expect.objectContaining({ confirmation: expect.objectContaining({ ...pick(page), ...changed }) }),
    );
    expect(result).toBe(expected);
  });

  it("does not treat another promotion conflict as a stale preview", async () => {
    const bulkPromoteSourceObservations = vi
      .fn()
      .mockRejectedValue(new CatalogApiError(409, { error: { code: "conflict", message: "Busy." } }));
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkPromoteSourceObservations });

    const result = await runDailyAction({
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "spp1.content-a",
    });

    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).not.toBe("preview-required");
  });

  it("executes matching-filter promotion with the same explicit broad scope used for preview", async () => {
    const previewBulkPromoteSourceObservations = vi.fn();
    const bulkPromoteSourceObservationsByScope = vi.fn().mockResolvedValue({ jobId: "job_promote_scope" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservationsByScope,
      previewBulkPromoteSourceObservations,
    });

    const response = await runDailyActionRedirect({
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      promotionPreviewId: "spp1.scope",
    });

    expect(previewBulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(bulkPromoteSourceObservationsByScope).toHaveBeenCalledWith(
      {
        provider: "tcgdex",
        language: "en",
        productLineId: "3",
        seriesId: "base",
        expansionId: "base1",
        setId: "base1",
      },
      { promoteAsDraft: false, previewToken: "spp1.scope", confirmation: reviewPage },
    );
    const location = redirectLocation(response);
    expect(location.searchParams.get("jobId")).toBe("job_promote_scope");
    expect(location.searchParams.get("commandResult")).toBe("job-queued");
  });
  it("fails closed when scoped promotion execution has no concrete scope", async () => {
    const previewBulkPromoteSourceObservations = vi.fn();
    const bulkPromoteSourceObservationsByScope = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservationsByScope,
      previewBulkPromoteSourceObservations,
    });

    const result = await runDailyAction({
      _intent: "observation.promote",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      profileVersion: "2026.06.04",
      promotionPreviewId: "preview-tcgdex_tcgdex_pokemon_card_import_none-124-124",
    });

    expect(previewBulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(bulkPromoteSourceObservationsByScope).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("preview-required");
    expect(result.context.promotionPreviewId).toBeNull();
  });

  it("requires a rejection reason before enqueueing reject jobs", async () => {
    const bulkRejectSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkRejectSourceObservations });

    const result = await runDailyAction({
      _intent: "observation.reject",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
    });

    expect(bulkRejectSourceObservations).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("reason-required");
  });

  it("enqueues reject jobs once the operator supplies an audit reason", async () => {
    const bulkRejectSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_reject_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkRejectSourceObservations });

    const result = await runDailyAction({
      _intent: "observation.reject",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
      reason: "Provider evidence is not launch-ready.",
    });

    expect(bulkRejectSourceObservations).toHaveBeenCalledWith(["obs_001"], "Provider evidence is not launch-ready.");
    expect(result.context.jobId).toBe("job_reject_123");
    expect(result.feedback.result).toBe("job-queued");
  });

  it("enqueues active-profile reapply jobs for selected Source Observations", async () => {
    const reapplySourceObservations = vi.fn().mockResolvedValue({ jobId: "job_reapply_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ reapplySourceObservations });

    const result = await runDailyAction({
      _intent: "observation.reapply",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(reapplySourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(result.context.jobId).toBe("job_reapply_123");
    expect(result.context.promotionPreviewId).toBeNull();
    expect(result.feedback.result).toBe("job-queued");
  });

  it("bridges provider import lifecycle commands to durable job APIs", async () => {
    const retrySourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    const resumeSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    const cancelSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      retrySourceObservationIntegrationJob,
      resumeSourceObservationIntegrationJob,
      cancelSourceObservationIntegrationJob,
    });

    const retryResult = await runDailyAction({ _intent: "job.retry", jobId: "job_import_123" });
    const resumeResult = await runDailyAction({ _intent: "job.resume", jobId: "job_import_123" });
    const cancelResult = await runDailyAction({ _intent: "job.cancel", jobId: "job_import_123" });

    expect(retrySourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(resumeSourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(cancelSourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(retryResult.feedback.result).toBe("job-queued");
    expect(resumeResult.feedback.result).toBe("job-queued");
    expect(cancelResult.feedback.result).toBe("job-cancelled");
  });

  it("requires a durable import job id before lifecycle commands can run", async () => {
    const retrySourceObservationIntegrationJob = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ retrySourceObservationIntegrationJob });

    const result = await runDailyAction({ _intent: "job.retry" });

    expect(retrySourceObservationIntegrationJob).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("job-required");
  });

  it("enqueues defer jobs and clears stale promotion previews", async () => {
    const deferSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_defer_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ deferSourceObservations });

    const deferResult = await runDailyAction({
      _intent: "observation.defer",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(deferSourceObservations).toHaveBeenCalledWith(["obs_001"], "Deferred from the primary workbench.");
    expect(deferResult.context.jobId).toBe("job_defer_123");
    expect(deferResult.feedback.result).toBe("job-queued");
    expect(deferResult.context.promotionPreviewId).toBeNull();
    expect(deferResult.context.selectedObservationIds).toEqual([]);
  });

  it("enqueues original-profile replay jobs for selected Source Observations", async () => {
    const replaySourceObservations = vi.fn().mockResolvedValue({ jobId: "job_replay_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ replaySourceObservations });

    const replayResult = await runDailyAction({
      _intent: "observation.replay",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(replaySourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(replayResult.context.jobId).toBe("job_replay_123");
    expect(replayResult.feedback.result).toBe("job-queued");
    expect(replayResult.context.promotionPreviewId).toBeNull();
  });

  it("returns sanitized feedback for invalid intents and API failures", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockRejectedValue(new Error("provider secret leaked"));
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const invalidResult = await runDailyAction({ _intent: "legacy-json-patch" });
    const failureResult = await runDailyAction({
      _intent: "scope.import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
    });

    expect(invalidResult.feedback.result).toBe("invalid-intent");
    expect(failureResult.feedback.result).toBe("command-failed");
    // The sanitized result never carries the underlying error message.
    expect(JSON.stringify(failureResult)).not.toContain("provider secret leaked");
  });

  it("loads the alias-review read model into the daily surface route data (#1908)", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const getCatalogAliasReviewReadModel = vi.fn().mockResolvedValue(aliasReviewReadModel());
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      getCatalogAliasReviewReadModel,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const aliasReviewQuery = new URLSearchParams(getCatalogAliasReviewReadModel.mock.calls[0]?.[0] ?? "");
    expect(aliasReviewQuery.get("providerKey")).toBe("tcgdex");
    expect(aliasReviewQuery.get("sourceProfileVersion")).toBe("2026.06.04");
    // Alias review is deferred (#1970): it streams in behind the deferred slice.
    expect((await routeData.deferredAliasReview)?.counts.needsReview).toBe(1);
  });

  it("keeps the daily surface rendering when the alias-review read model is unavailable", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      getCatalogAliasReviewReadModel: vi.fn().mockRejectedValue(new CatalogApiError(503, { error: { code: "boom" } })),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgdex"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    // Alias review is supplementary and deferred (#1970): a transient failure
    // resolves to null inside the streamed boundary, never breaking the
    // import-to-promotion workflow or rejecting the boundary into an error page.
    expect(await routeData.deferredAliasReview).toBeNull();
  });

  it("streams the alias-review supplementary slot inline on the daily surface when the loader defers it", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgdex";
    // The daily loader defers the alias-review read model; the route view renders
    // it behind a Suspense/Await boundary, so the workspace appears once the
    // streamed promise resolves rather than at first paint. The language-edition
    // equivalence review now lives on Scope Detail (see
    // language-editions-panel.test.tsx); the all-scopes table here stops
    // streaming open by default (see integrations-surface-route-view.tsx), which
    // this bare (non-router) render harness cannot resolve past the Suspense
    // fallback, so this test keeps asserting the fallback/shared title renders.
    mockUseLoaderData.mockReturnValue(
      loaderData({
        data: scopes,
        profileReviews,
        requestUrl,
        commandFeedback: null,
        deferredAliasReview: Promise.resolve(aliasReviewReadModel()),
      }),
    );
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });

    render(<IntegrationsRoute />);

    expect((await screen.findAllByText("Alias review")).length).toBeGreaterThan(0);
  });
});
