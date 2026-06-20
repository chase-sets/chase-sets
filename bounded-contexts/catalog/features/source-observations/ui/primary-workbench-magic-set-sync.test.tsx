// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  type CatalogPrimaryWorkbenchSourceOptionRequest,
} from "./primary-workbench-read-model";
import { CatalogMagicSetSyncModule } from "./admin-control-plane/import-to-promotion/magic-set-sync-module";
import type {
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationOptionResponse,
  SourceObservationIntegrationScope,
} from "./contracts";
import { controlPlaneOverview, profileReview, sourceObservationScope } from "./primary-workbench-test-fixtures";

describe("Catalog Magic set sync workbench", () => {
  afterEach(() => cleanup());

  it("ties one selected Magic set to MTGJSON, Scryfall, and TCGplayer sync actions", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=mtgjson&unitKey=mtgjson:magic:set:import&languageCode=en&productLineId=magic&productLineName=Magic%3A%20The%20Gathering&seriesId=dft&seriesName=Tarkir%20Dragonstorm&expansionId=dft&expansionName=Tarkir%3A%20Dragonstorm&profileVersion=2026.06.19",
      scopes: { items: magicSetScopes(), total: 3, count: 3 },
      profileReviews: { items: magicProfiles(), total: 3, count: 3 },
      controlPlaneOverview: magicOverview(),
      canManageCatalog: true,
    });

    expect(readModel.magicSetSync.status).toBe("ready");
    expect(readModel.magicSetSync.selectedSet).toMatchObject({
      setId: "dft",
      setName: "Tarkir: Dragonstorm",
    });
    expect(readModel.magicSetSync.providers.map((provider) => provider.providerKey)).toEqual([
      "mtgjson",
      "scryfall",
      "tcgplayer",
    ]);
    expect(readModel.magicSetSync.providers.every((provider) => provider.actions.import.state === "available")).toBe(
      true,
    );

    render(<CatalogMagicSetSyncModule readModel={readModel} />);

    expect(screen.getByText("Magic set sync")).toBeTruthy();
    expect(screen.getByLabelText("Magic set")).toHaveProperty("value", "dft");
    expect(screen.getByText("Current set: Tarkir: Dragonstorm")).toBeTruthy();
    expect(screen.getAllByText("MTGJSON").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Scryfall").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCGplayer").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Sync MTGJSON" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Preview Scryfall" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Reapply TCGplayer" }).length).toBeGreaterThan(0);

    const mtgjsonSyncForm = magicCommandForm("start-provider-import", "mtgjson");
    expect(formPathname(mtgjsonSyncForm)).toBe("/catalog/integrations");
    expect(mtgjsonSyncForm?.getAttribute("action")).not.toContain("/api/");
    expect(hiddenValue(mtgjsonSyncForm, "providerKey")).toBe("mtgjson");
    expect(hiddenValue(mtgjsonSyncForm, "unitKey")).toBe("mtgjson:magic:set:import");
    expect(hiddenValue(mtgjsonSyncForm, "importScope")).toBe("en:magic:dft:dft");
    expect(hiddenValue(mtgjsonSyncForm, "expansionId")).toBe("dft");
    expect(hiddenValue(mtgjsonSyncForm, "expansionName")).toBe("Tarkir: Dragonstorm");

    const providerSetLinks = screen.getAllByRole("link", { name: "Open provider set" });
    expect(new Set(providerSetLinks.map((link) => link.getAttribute("href"))).size).toBe(3);
    expect(providerSetLinks.every((link) => !link.getAttribute("href")?.includes("/api/"))).toBe(true);
    const tcgplayerSetHref = providerSetLinks
      .map((link) => new URL(link.getAttribute("href") ?? "", "https://admin.example"))
      .find((href) => href.searchParams.get("providerKey") === "tcgplayer");
    expect(tcgplayerSetHref?.searchParams.get("expansionName")).toBe("Tarkir: Dragonstorm");
  });

  it("fails closed until one Magic set is selected", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=scryfall",
      scopes: { items: magicSetScopes(), total: 3, count: 3 },
      profileReviews: { items: magicProfiles(), total: 3, count: 3 },
      controlPlaneOverview: magicOverview(),
      canManageCatalog: true,
    });

    expect(readModel.magicSetSync.status).toBe("set-required");
    for (const provider of readModel.magicSetSync.providers) {
      expect(provider.commandContext.importScope).toBeNull();
      expect(provider.actions.import).toMatchObject({
        state: "disabled",
        blockers: ["import-scope-required"],
      });
      expect(provider.actions.previewPromotion.state).toBe("disabled");
      expect(provider.actions.reapply.state).toBe("disabled");
    }

    render(<CatalogMagicSetSyncModule readModel={readModel} />);

    expect(screen.getByText("Current set: Select one Magic set")).toBeTruthy();
    for (const label of ["Sync MTGJSON", "Preview Scryfall", "Reapply TCGplayer"]) {
      expect(screen.getAllByRole("button", { name: label }).every((button) => button.hasAttribute("disabled"))).toBe(
        true,
      );
    }

    const scryfallPreviewForm = magicCommandForm("preview-promotion", "scryfall");
    expect(formPathname(scryfallPreviewForm)).toBe("/catalog/integrations");
    expect(scryfallPreviewForm?.getAttribute("action")).not.toContain("/api/");
    expect(hiddenValue(scryfallPreviewForm, "importScope")).toBe("");
    expect(hiddenValue(scryfallPreviewForm, "expansionId")).toBe("");
    expect(within(scryfallPreviewForm!).queryByDisplayValue(/api\//i)).toBeNull();
  });

  it("normalizes the three-provider Magic set workflow to the English set scope", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=mtgjson&unitKey=mtgjson:magic:set:import&languageCode=ja&productLineName=Magic%3A%20The%20Gathering&expansionId=5DN&expansionName=Fifth%20Dawn&profileVersion=2026.06.19",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: magicProfiles(), total: 3, count: 3 },
      controlPlaneOverview: magicOverview(),
      canManageCatalog: true,
    });

    expect(readModel.magicSetSync.selectedSet).toMatchObject({
      setId: "5DN",
      setName: "Fifth Dawn",
    });
    expect(readModel.magicSetSync.providers.map((provider) => provider.commandContext.importScope)).toEqual([
      "en:5DN",
      "en:5DN",
      "en:5DN",
    ]);
    expect(readModel.magicSetSync.providers.map((provider) => provider.commandContext.languageCode)).toEqual([
      "en",
      "en",
      "en",
    ]);

    render(<CatalogMagicSetSyncModule readModel={readModel} />);

    const selectorForm = screen.getByLabelText("Magic set").closest("form") as HTMLFormElement | null;
    expect(hiddenValue(selectorForm, "languageCode")).toBe("en");

    for (const providerKey of ["mtgjson", "scryfall", "tcgplayer"]) {
      const form = magicCommandForm("start-provider-import", providerKey);
      expect(hiddenValue(form, "languageCode")).toBe("en");
      expect(hiddenValue(form, "importScope")).toBe("en:5DN");
      expect(hiddenValue(form, "expansionName")).toBe("Fifth Dawn");
    }
  });

  it("hydrates selectable Magic sets from deferred provider options and submits the set name", async () => {
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=mtgjson&unitKey=mtgjson:magic:set:import&languageCode=en&productLineName=Magic%3A%20The%20Gathering&profileVersion=2026.06.19";
    const profiles = magicProfiles();
    const baseReadModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: magicOverview(),
      canManageCatalog: true,
    });
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl,
      scopes: [],
      profiles,
      cacheOnly: true,
    });
    const setRequest = requests.find((request) => request.queryKind === "sets");
    expect(baseReadModel.magicSetSync.setOptions).toEqual([]);
    expect(setRequest).toBeTruthy();

    const hydratedReadModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      sourceOptionPages: [
        {
          request: setRequest!,
          response: optionResponse(setRequest!, "fresh", "cache", [
            { value: "5DN", label: "Fifth Dawn", parentValue: null },
          ]),
        },
      ],
      controlPlaneOverview: magicOverview(),
      canManageCatalog: true,
    });

    render(
      <CatalogMagicSetSyncModule
        readModel={baseReadModel}
        deferredSourceOptions={Promise.resolve(hydratedReadModel.sourceOptions)}
      />,
    );

    const option = await screen.findByRole("option", { name: "Fifth Dawn" });
    expect(option).toBeTruthy();
    const select = screen.getByLabelText("Magic set") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "5DN" } });

    const selectorForm = select.closest("form") as HTMLFormElement | null;
    expect(selectorForm?.getAttribute("action")).toBe("/catalog/integrations");
    expect(hiddenValue(selectorForm, "providerKey")).toBe("mtgjson");
    expect(hiddenValue(selectorForm, "unitKey")).toBe("mtgjson:magic:set:import");
    expect(hiddenValue(selectorForm, "expansionName")).toBe("Fifth Dawn");
    expect(screen.getByRole("button", { name: "Select Magic set" }).hasAttribute("disabled")).toBe(false);
  });
});

function magicProfiles(): CatalogProviderProfileVersionReview[] {
  return [
    magicProfile("mtgjson", "MTGJSON Magic set reference", "mtgjson:magic:set:import"),
    magicProfile("scryfall", "Scryfall Magic card prints", "scryfall:magic:card:import"),
    magicProfile("tcgplayer", "TCGplayer Magic products", "tcgplayer:magic:single-card:source-observation-import"),
  ];
}

function magicProfile(
  providerKey: "mtgjson" | "scryfall" | "tcgplayer",
  displayName: string,
  ingestionUnitKey: string,
): CatalogProviderProfileVersionReview {
  return profileReview({
    providerKey,
    profileKey: `${providerKey}-magic`,
    profileVersion: "2026.06.19",
    ingestionUnitKey,
    displayName,
    active: true,
    lifecycle: "active",
    status: "active",
    profile: { providerKey, supportedScopes: ["magic/card"] },
    supportedScopes: ["magic/card"],
    mappingOutputKind: providerKey === "tcgplayer" ? "magic-sealed-product" : "magic-card-print",
    sourceOptionKinds: [
      {
        queryKind: providerKey === "tcgplayer" ? "set-names" : "sets",
        queryKeySynonyms: providerKey === "tcgplayer" ? ["set-name"] : ["set"],
        displayName: "Magic set",
        scope: providerKey === "tcgplayer" ? "set-name" : "expansion",
        parentScope: "product-line/category",
        parentRequired: false,
        parentValueKind: "product-line",
        parentDiagnosticText: null,
      },
    ],
  });
}

function magicSetScopes(): SourceObservationIntegrationScope[] {
  return [
    magicScope("mtgjson", "MTGJSON", "mtgjson:magic:set:import", {
      observed_observations: 1,
      changed_observations: 1,
      promoted_observations: 0,
    }),
    magicScope("scryfall", "Scryfall", "scryfall:magic:card:import", {
      observed_observations: 400,
      changed_observations: 12,
      promoted_observations: 320,
    }),
    magicScope("tcgplayer", "TCGplayer", "tcgplayer:magic:single-card:source-observation-import", {
      observed_observations: 80,
      changed_observations: 6,
      promoted_observations: 70,
    }),
  ];
}

function magicScope(
  providerKey: "mtgjson" | "scryfall" | "tcgplayer",
  providerName: string,
  _unitKey: string,
  counts: Partial<SourceObservationIntegrationScope>,
): SourceObservationIntegrationScope {
  return sourceObservationScope({
    provider_key: providerKey,
    language_code: "en",
    product_line_id: "magic",
    product_line_name: "Magic: The Gathering",
    series_id: "dft",
    series_name: "Tarkir Dragonstorm",
    expansion_id: "dft",
    expansion_name: "Tarkir: Dragonstorm",
    total_observations: 400,
    rejected_observations: 0,
    ...counts,
    latest_source_updated_at: "2026-06-19T12:00:00.000Z",
    latest_observed_at: "2026-06-19T12:05:00.000Z",
    first_observed_at: "2026-06-19T12:00:00.000Z",
  });
}

function magicOverview() {
  const base = controlPlaneOverview();
  const units = magicProfiles().map((profile) => ({
    ...base.readiness.units[0]!,
    unitKey: profile.ingestionUnitKey,
    providerKey: profile.providerKey,
    displayName: profile.displayName,
    productDomain: "magic",
    productForm: profile.providerKey === "mtgjson" ? "set" : "card",
    profileVersion: profile.profileVersion,
    observationFacts: 1,
  }));

  return controlPlaneOverview({
    readiness: {
      ...base.readiness,
      units,
    },
    unitActivity: {
      generatedAt: base.generatedAt,
      units: units.map((unit) => ({ unitKey: unit.unitKey, recentJobs: [] })),
    },
    providerReadiness: {
      generatedAt: base.generatedAt,
      providers: units.map((unit) => ({
        providerKey: unit.providerKey,
        adapterKey: unit.providerKey,
        readiness: "ready",
        credentialReadiness: "not-required",
        credentialReadinessState: "not-required",
        credentialRequirement: "not-required",
        unitKeys: [unit.unitKey],
        apiReachability: { status: "ready", diagnosticCodes: [], message: null },
        optionQueryHealth: { status: "ready", diagnosticCodes: [], message: null },
        rateLimitStatus: { status: "ready", diagnosticCodes: [], message: null },
        payloadAcquisition: { status: "ready", diagnosticCodes: [], message: null },
        diagnostics: [],
      })),
    },
  });
}

function magicCommandForm(intent: string, providerKey: string): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>(
    `form[data-catalog-primary-workbench-command="${intent}"][data-catalog-magic-set-provider="${providerKey}"]`,
  );
}

function hiddenValue(form: HTMLFormElement | null, name: string): string | undefined {
  return form?.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
}

function formPathname(form: HTMLFormElement | null): string | undefined {
  const action = form?.getAttribute("action");
  return action ? new URL(action, "https://admin.example").pathname : undefined;
}

function optionResponse(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  status: NonNullable<SourceObservationIntegrationOptionResponse["cache"]>["status"],
  source: NonNullable<SourceObservationIntegrationOptionResponse["cache"]>["source"],
  items: readonly { value: string; label: string; parentValue: string | null }[],
): SourceObservationIntegrationOptionResponse {
  return {
    items: items.map((item) => ({
      providerKey: request.providerKey,
      queryKind: request.queryKind,
      value: item.value,
      label: item.label,
      description: null,
      parentValue: item.parentValue,
      imageUrl: null,
      aliases: [],
      metadata: {},
    })),
    total: items.length,
    count: items.length,
    page: { cursor: request.cursor, nextCursor: null, limit: request.limit, hasMore: false },
    cache: {
      status,
      source,
      cacheKey: `sha256:${request.queryKind}`,
      fetchedAt: "2026-06-19T00:00:00.000Z",
      expiresAt: "2026-06-19T00:15:00.000Z",
      staleUntil: "2026-06-20T00:00:00.000Z",
      cacheOnly: request.cacheOnly,
      forceRefresh: false,
      degraded: false,
      diagnostics: [],
    },
  };
}
