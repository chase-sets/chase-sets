import { expect, test, type Locator, type Page } from "@playwright/test";

const runStagingProviderUat = process.env.CATALOG_STAGING_PROVIDER_UAT === "true";
const providerUatJourneyScope = process.env.CATALOG_STAGING_PROVIDER_UAT_SCOPE?.trim() || "one-piece-launch";
const catalogAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const catalogAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const pageReadyTimeoutMs = 90_000;
const sourceOptionTimeoutMs = 90_000;
const syncTimeoutMs = 120_000;
const terminalSyncTimeoutMs = 720_000;
const downstreamProjectionTimeoutMs = 300_000;
const uatTestTimeoutMs = 3_600_000;

type SelectChoice = Readonly<{
  labels?: readonly string[];
  values?: readonly string[];
  fallbackToFirstAvailableOption?: Readonly<{
    valuePattern?: RegExp;
  }>;
}>;

type ScopeSelection = Readonly<{
  label: string | RegExp;
  choice: SelectChoice;
}>;

type ProviderSyncJourney = Readonly<{
  name: string;
  providerKey: string;
  unitKey: string;
  scope: readonly ScopeSelection[];
  preflight?: ImportPreflightExpectation;
  requiresTerminalSync?: boolean;
}>;

type ImportPreflightExpectation = Readonly<{
  requestStrategy?: string;
  allowedUsageStates?: readonly string[];
  visibleText: readonly (string | RegExp)[];
}>;

type SelectedProviderScope = Readonly<{
  providerKey: string;
  importScope: string | null;
  displayLabel: string;
  fields: readonly SelectedProviderScopeField[];
}>;

type SelectedProviderScopeField = Readonly<{
  name: string;
  value: string;
}>;

type ProviderSyncAttempt = Readonly<{
  previousJobRows: readonly string[];
}>;

type LorcanaDownstreamSmokeResult = Readonly<{
  mode: "promote" | "reapply";
  providerKey: string;
  unitKey: string;
  selectedScope: string;
  selectedObservationIds: readonly string[];
  promotionPreviewId: string | null;
  jobId: string | null;
}>;

type MissingOptionRecovery = () => Promise<boolean>;

const preferredYugiohSetLabels = [
  "25th Anniversary Rarity Collection",
  "2-Player Starter Set",
  "Starter Deck: Yugi",
  "Legend of Blue Eyes White Dragon",
] as const;

const yugiohSetChoice: SelectChoice = {
  labels: preferredYugiohSetLabels,
};

const ygojsonSetChoice: SelectChoice = {
  labels: preferredYugiohSetLabels,
  fallbackToFirstAvailableOption: {
    valuePattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
};

const tcgplayerYugiohSetChoice: SelectChoice = {
  labels: ["Ancient Sanctuary", "Absolute Powerforce", "Bonds Beyond Time Movie Pack"],
  fallbackToFirstAvailableOption: {},
};

const onePieceScrydexSetChoice: SelectChoice = {
  labels: ["Romance Dawn"],
  values: ["op-01", "OP01", "OP-01"],
  fallbackToFirstAvailableOption: { valuePattern: /^(?:OP|ST|EB|PRB)-?\d+$/i },
};

const onePieceScrydexSealedSetChoice: SelectChoice = {
  labels: ["Emperors In The New World", "Romance Dawn"],
  values: ["OP09", "op-01", "OP01", "OP-01"],
  fallbackToFirstAvailableOption: { valuePattern: /^OP-?0?9$/i },
};

const tcgplayerOnePieceSetChoice: SelectChoice = {
  labels: ["Romance Dawn"],
  fallbackToFirstAvailableOption: {},
};

const mtgjsonMtgSetChoice: SelectChoice = {
  labels: ["Fifth Dawn", "Time Spiral"],
  values: ["5DN", "TSP"],
  fallbackToFirstAvailableOption: { valuePattern: /^[A-Z0-9]+$/ },
};

const lorcanaSetChoice: SelectChoice = {
  labels: ["The First Chapter"],
  values: ["TFC", "1"],
  fallbackToFirstAvailableOption: { valuePattern: /^[A-Z0-9]+$/i },
};

const tcgplayerLorcanaSetChoice: SelectChoice = {
  labels: ["The First Chapter"],
  fallbackToFirstAvailableOption: {},
};

const tcgplayerLorcanaProductLineChoice: SelectChoice = {
  labels: ["Disney Lorcana", "Lorcana"],
  fallbackToFirstAvailableOption: {},
};

const onePieceLaunchProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "One Piece card set through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:one-piece:single-card:source-observation-import",
    scope: [{ label: "Set", choice: onePieceScrydexSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "250",
        "id, name, number, printed_number, rarity, rarity_code, type, images, language, language_code, expansion, printings, variants",
        "Bulk-first",
        /Scrydex One Piece cards .*max page size/i,
        /scrydex:one-piece:expansion:[a-z0-9-]+:cards/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "One Piece sealed products through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:one-piece:sealed-product:source-observation-import",
    scope: [{ label: "Set", choice: onePieceScrydexSealedSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "100",
        "id, name, type, images, language, language_code, expansion",
        "Bulk-first",
        "Fetch Scrydex One Piece expansion sealed products with max page size",
        /scrydex:one-piece:expansion:[a-z0-9-]+:sealed/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "One Piece set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["One Piece Card Game"], values: ["68"] } },
      { label: "Set Name", choice: tcgplayerOnePieceSetChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Pokemon set regression through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["Japanese"], values: ["ja"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: { labels: ["Super Electric Breaker"], values: ["SV8"] } },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "MTG set regression through MTGJSON shared importer",
    providerKey: "mtgjson",
    unitKey: "mtgjson:mtg:set:reference-data",
    scope: [{ label: "Set", choice: mtgjsonMtgSetChoice }],
    requiresTerminalSync: true,
  },
];

const lorcanaLaunchProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "Lorcana card set through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:lorcana:single-card:source-observation-import",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "250",
        "id, name, number, printed_number, rarity, rarity_code, type, ink, ink_color, images, language, language_code, expansion, printings, variants, tcgplayer_id",
        "Bulk-first",
        /Scrydex Lorcana cards .*max page size/i,
        /scrydex:lorcana:expansion:[a-z0-9-]+:cards/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana set reference through Scrydex shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:lorcana:set:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "single-record",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Fetch Scrydex Lorcana expansion by id",
        "Selected set-reference import uses the Scrydex expansion detail endpoint.",
        /scrydex:lorcana:set:[a-z0-9-]+$/i,
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana card set through LorcanaJSON bulk-first shared importer",
    providerKey: "lorcanajson",
    unitKey: "lorcanajson:lorcana:single-card:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["not-supported", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Bulk-first",
        "Fetch LorcanaJSON set file",
        "Select all card payloads from the selected set",
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana set reference through LorcanaJSON bulk-first shared importer",
    providerKey: "lorcanajson",
    unitKey: "lorcanajson:lorcana:set:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["not-supported", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Bulk-first",
        "Fetch LorcanaJSON set file",
        "Use allCards.json only for option discovery",
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana card set through Lorcast bulk-first shared importer",
    providerKey: "lorcast",
    unitKey: "lorcast:lorcana:single-card:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["not-supported", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Bulk-first",
        "Fetch Lorcast set cards endpoint",
        "Prefer cached set payloads for repeat diagnostics",
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana set reference through Lorcast bulk-first shared importer",
    providerKey: "lorcast",
    unitKey: "lorcast:lorcana:set:reference-data",
    scope: [{ label: "Set", choice: lorcanaSetChoice }],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["not-supported", "unknown"],
      visibleText: [
        "Import preflight",
        "1",
        "Bulk-first",
        "Fetch Lorcast selected set endpoint",
        "Prefer cached set payloads for repeat diagnostics",
      ],
    },
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana card set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:lorcana:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerLorcanaProductLineChoice },
      { label: "Set Name", choice: tcgplayerLorcanaSetChoice },
    ],
    requiresTerminalSync: true,
  },
  {
    name: "Lorcana sealed products through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:lorcana:sealed-product:source-observation-import",
    scope: [
      { label: "Product Line", choice: tcgplayerLorcanaProductLineChoice },
      { label: "Set Name", choice: tcgplayerLorcanaSetChoice },
    ],
    requiresTerminalSync: true,
  },
  ...onePieceLaunchProviderSyncJourneys,
];

const yugiohProviderSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "Yu-Gi-Oh set through YGOPRODeck",
    providerKey: "ygoprodeck",
    unitKey: "ygoprodeck:yugioh:single-card:reference-data",
    scope: [{ label: "Set", choice: yugiohSetChoice }],
  },
  {
    name: "Yu-Gi-Oh set through YGOJSON / YAML Yugi upstream data",
    providerKey: "ygojson",
    unitKey: "ygojson:yugioh:set:reference-data",
    scope: [{ label: "Set", choice: ygojsonSetChoice }],
  },
  {
    name: "Yu-Gi-Oh set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:yugioh:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["Yu-Gi-Oh!", "Yu-Gi-Oh", "YuGiOh"], values: ["2"] } },
      { label: "Set Name", choice: tcgplayerYugiohSetChoice },
    ],
  },
];

const providerSyncJourneys =
  providerUatJourneyScope === "all-provider-regression"
    ? [...lorcanaLaunchProviderSyncJourneys, ...yugiohProviderSyncJourneys]
    : providerUatJourneyScope === "lorcana-launch"
      ? lorcanaLaunchProviderSyncJourneys
      : onePieceLaunchProviderSyncJourneys;

const lorcanaDownstreamCatalogItemsJourney: ProviderSyncJourney = {
  name: "Lorcana downstream Catalog Items projection through LorcanaJSON",
  providerKey: "lorcanajson",
  unitKey: "lorcanajson:lorcana:single-card:reference-data",
  scope: [{ label: "Set", choice: lorcanaSetChoice }],
};

test.describe("catalog staging provider sync UAT", () => {
  test("operator syncs provider scopes from the shared importer UI @catalog-staging-provider-uat", async ({ page }) => {
    test.setTimeout(uatTestTimeoutMs);
    test.skip(!runStagingProviderUat, "Set CATALOG_STAGING_PROVIDER_UAT=true to run the staging provider sync UAT.");
    test.skip(
      !["one-piece-launch", "lorcana-launch", "all-provider-regression"].includes(providerUatJourneyScope),
      `Unsupported CATALOG_STAGING_PROVIDER_UAT_SCOPE: ${providerUatJourneyScope}.`,
    );
    test.skip(
      !catalogAdminEmail || !catalogAdminPassword,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for staging provider sync UAT.",
    );

    await signInThroughVisibleForm(page);
    await openCatalogImporter(page);
    await assertSharedImporterSurface(page);

    for (const journey of providerSyncJourneys) {
      await test.step(journey.name, async () => {
        const selectedScope = await selectProviderScope(page, journey);
        if (journey.preflight) {
          await expectImportPreflight(page, journey.unitKey, selectedScope, journey.preflight);
        }
        const syncAttempt = await syncSelectedProviderUnit(page, journey.unitKey, selectedScope);
        if (journey.requiresTerminalSync) {
          await expectImportJobSettledForSelectedUnit(
            page,
            journey.unitKey,
            selectedScope,
            syncAttempt.previousJobRows,
          );
        }
      });
    }

    if (providerUatJourneyScope === "lorcana-launch" || providerUatJourneyScope === "all-provider-regression") {
      await test.step("Lorcana Catalog Items downstream projection through shared UI", async () => {
        await expectLorcanaCatalogItemsDownstreamProjection(page);
      });
    }
  });
});

async function signInThroughVisibleForm(page: Page): Promise<void> {
  await page.goto("/catalog/sign-in?returnTo=%2Fcatalog%2Fintegrations", {
    waitUntil: "domcontentloaded",
    timeout: pageReadyTimeoutMs,
  });

  const deadline = Date.now() + pageReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (await isImporterVisible(page, 3_000)) {
      return;
    }

    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
    if (await passwordInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await passwordInput.fill(catalogAdminPassword);
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await openCatalogImporter(page);
      return;
    }

    const passwordChoice = page.getByRole("radio", { name: /^Password$/ }).first();
    if (
      (await passwordChoice.isVisible({ timeout: 1_000 }).catch(() => false)) &&
      !(await passwordChoice.isChecked().catch(() => false))
    ) {
      await passwordChoice.click();
      continue;
    }

    const emailInput = page.getByRole("textbox", { name: /email|phone/i });
    if (await emailInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await emailInput.fill(catalogAdminEmail);
      await page.getByRole("button", { name: /^continue$/i }).click();
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error("The staging admin sign-in form did not reach the password step or importer before the timeout.");
}

async function openCatalogImporter(page: Page): Promise<void> {
  const deadline = Date.now() + pageReadyTimeoutMs;
  let nextNavigationAt = Date.now();

  while (Date.now() < deadline) {
    if (await isImporterVisible(page, 2_000)) {
      await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
      return;
    }

    if (await recoverImporterFromAdminError(page)) {
      continue;
    }

    if (Date.now() >= nextNavigationAt) {
      await page.goto("/catalog/integrations", { waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs });
      nextNavigationAt = Date.now() + 10_000;
      continue;
    }

    await page.waitForTimeout(1_000);
  }

  if (await recoverImporterFromAdminError(page)) {
    return;
  }
  if (!(await isImporterVisible(page, 1_000))) {
    await page.goto("/catalog/integrations", { waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs });
  }
  await expectImporterVisible(page);
  await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
}

async function assertSharedImporterSurface(page: Page): Promise<void> {
  await expect(page.locator("[data-catalog-import-context-bar='true']")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Step 0 · Choose import scope/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Lorcana.*sync|Magic.*sync|Yu-Gi-Oh.*sync|Pokemon.*sync/i }),
  ).toHaveCount(0);
}

async function selectProviderScope(page: Page, journey: ProviderSyncJourney): Promise<SelectedProviderScope> {
  const contextBar = page.locator("[data-catalog-import-context-bar='true']");
  await expandImportContextBar(contextBar);

  const provider = contextBar.getByRole("combobox", { name: "Provider" });
  await selectOption(provider, { values: [journey.providerKey] }, () => recoverImporterFromAdminError(page));
  await expect(provider).toHaveValue(journey.providerKey, { timeout: pageReadyTimeoutMs });

  const unit = contextBar.getByRole("combobox", { name: "Unit" });
  await selectOption(unit, { values: [journey.unitKey] }, () => recoverImporterFromAdminError(page));
  await expect(unit).toHaveValue(journey.unitKey, { timeout: pageReadyTimeoutMs });

  for (const selection of journey.scope) {
    const sourceScope = page.getByRole("group", { name: "Source scope" });
    await expect(sourceScope).toBeVisible({ timeout: sourceOptionTimeoutMs });
    const scopeSelect = sourceScope.getByRole("combobox", { name: selection.label });
    await selectOption(scopeSelect, selection.choice, () => recoverSourceOptionSelection(page, selection.label));
    await expect(scopeSelect).not.toHaveValue("", { timeout: sourceOptionTimeoutMs });
  }

  await contextBar.getByRole("button", { name: "Select source scope" }).click();
  const commandForm = sourceScopeSyncForms(page, journey.unitKey).first();
  await expect(commandForm).toBeVisible({ timeout: sourceOptionTimeoutMs });
  return selectedProviderScopeFromCommandForm(commandForm);
}

async function expandImportContextBar(contextBar: Locator): Promise<void> {
  const trigger = contextBar.getByRole("button", { name: /Step 0 · Choose import scope/ });
  await expect(trigger).toBeVisible({ timeout: pageReadyTimeoutMs });
  for (let attempt = 0; attempt < 3 && !(await isImportContextBarExpanded(trigger)); attempt += 1) {
    await trigger.click();
    if (await isImportContextBarExpanded(trigger)) {
      return;
    }
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: pageReadyTimeoutMs });
}

async function isImportContextBarExpanded(trigger: Locator): Promise<boolean> {
  return expect(trigger)
    .toHaveAttribute("aria-expanded", "true", { timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
}

async function syncSelectedProviderUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<ProviderSyncAttempt> {
  const commandForm = sourceScopeSyncForms(page, unitKey).first();
  await expect(commandForm).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await expandWorkflowStage(page, "run-sync");
  const previousJobRows = await visibleImportJobRowTexts(page, unitKey, selectedScope);

  const syncButton = commandForm.getByRole("button", { name: /^Sync / });
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    if (await syncButton.isEnabled().catch(() => false)) {
      await syncButton.click();
      await expectCommandQueuedOrActiveImport(page, unitKey, selectedScope);
      return { previousJobRows };
    }

    if (await hasActiveImportJobForSelectedUnit(page, unitKey, selectedScope, 1_000)) {
      await expectActiveImportJobForSelectedUnit(page, unitKey, selectedScope);
      return { previousJobRows };
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Sync action for ${unitKey} was neither enabled nor represented by a queued/running/completed import job row for the selected or covering scope in the shared UI.`,
  );
}

async function expectImportPreflight(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  expectation: ImportPreflightExpectation,
): Promise<void> {
  const panel = page
    .locator(`[data-catalog-import-preview="ready"][data-catalog-import-preview-unit="${cssAttrValue(unitKey)}"]`)
    .filter({ visible: true })
    .first();
  const deadline = Date.now() + sourceOptionTimeoutMs;
  // Deferred review data can move the operator stepper back to Review Changes
  // after a scope change; reopen Run Sync the way an operator would.
  while (Date.now() < deadline) {
    await expandWorkflowStage(page, "run-sync");
    if (await panel.isVisible().catch(() => false)) {
      break;
    }
    await page.waitForTimeout(1_000);
  }

  await expandWorkflowStage(page, "run-sync");
  await expect(panel).toBeVisible({ timeout: pageReadyTimeoutMs });
  if (selectedScope.importScope) {
    const scopeCandidates = importPreflightScopeCandidates(selectedScope.importScope);
    const observedScope = await waitForImportPreflightScope(panel, scopeCandidates);
    expect(
      scopeCandidates,
      `Import preflight scope ${observedScope ?? "none"} should match the selected or canonicalized scope.`,
    ).toContain(observedScope);
  }
  if (expectation.requestStrategy) {
    await expect(panel).toHaveAttribute("data-catalog-import-preview-strategy", expectation.requestStrategy, {
      timeout: sourceOptionTimeoutMs,
    });
  }
  const usageState = (await panel.getAttribute("data-catalog-import-preview-usage-state")) ?? "none";
  if (expectation.allowedUsageStates && !expectation.allowedUsageStates.includes(usageState)) {
    throw new Error(
      `Import preflight usage state ${usageState} was not one of ${expectation.allowedUsageStates.join(", ")}.`,
    );
  }
  for (const text of expectation.visibleText) {
    await expect(panel.getByText(text).filter({ visible: true }).first()).toBeVisible({
      timeout: sourceOptionTimeoutMs,
    });
  }
}

function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function waitForImportPreflightScope(panel: Locator, scopeCandidates: readonly string[]): Promise<string | null> {
  const deadline = Date.now() + sourceOptionTimeoutMs;
  let observedScope: string | null = null;
  while (Date.now() < deadline) {
    observedScope = await panel.getAttribute("data-catalog-import-preview-scope");
    if (observedScope && scopeCandidates.includes(observedScope)) {
      return observedScope;
    }
    await panel.page().waitForTimeout(500);
  }
  return observedScope;
}

function importPreflightScopeCandidates(importScope: string): readonly string[] {
  const candidates = new Set([importScope]);
  const segments = importScope.split(":").filter(Boolean);
  const penultimate = segments.at(-2);
  const final = segments.at(-1);
  if (segments.length >= 3 && penultimate && penultimate === final) {
    candidates.add([...segments.slice(0, -2), final].join(":"));
  }
  return [...candidates];
}

type WorkflowStageKey = "run-sync" | "review-changes" | "create-items";

const workflowStageNames: Record<WorkflowStageKey, RegExp> = {
  "run-sync": /^Run sync\b/i,
  "review-changes": /^Review changes\b/i,
  "create-items": /^Create \/ update items\b/i,
};

async function expandWorkflowStage(page: Page, stage: WorkflowStageKey): Promise<void> {
  const trigger = page
    .locator(`[data-catalog-import-workflow-stage="${stage}"]`)
    .or(page.getByRole("heading", { name: workflowStageNames[stage] }).getByRole("button"))
    .first();
  await expect(trigger).toBeVisible({ timeout: pageReadyTimeoutMs });
  const deadline = Date.now() + pageReadyTimeoutMs;
  while ((await trigger.getAttribute("aria-expanded").catch(() => null)) !== "true" && Date.now() < deadline) {
    await trigger.click();
    await page.waitForTimeout(250);
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: pageReadyTimeoutMs });
}

async function expectImportJobSettledForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  previousJobRows: readonly string[],
): Promise<void> {
  const previous = new Set(previousJobRows.map(normalizeWhitespace));
  const deadline = Date.now() + terminalSyncTimeoutMs;
  let observedRows: readonly string[] = [];

  while (Date.now() < deadline) {
    await expandWorkflowStage(page, "run-sync");
    observedRows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    const changedRows = observedRows.filter((row) => !previous.has(row));
    const unsuccessful = changedRows.find(importJobRowReachedUnsuccessfulTerminal);
    if (unsuccessful) {
      throw new Error(`Import job for ${unitKey} reached an unsuccessful terminal state: ${unsuccessful}`);
    }
    const completed = changedRows.find(importJobRowReachedCompletedTerminal);
    if (completed) {
      console.log(
        `[catalog-staging-provider-uat] ${unitKey} completed for ${selectedScope.displayLabel}: ${completed}`,
      );
      return;
    }

    await page.waitForTimeout(2_000);
  }

  throw new Error(
    `Import job for ${unitKey} did not reach a new completed terminal row for ${selectedScope.displayLabel}. Observed rows: ${
      observedRows.join(" | ") || "none"
    }`,
  );
}

async function expectLorcanaCatalogItemsDownstreamProjection(page: Page): Promise<void> {
  await openCatalogImporter(page);
  const selectedScope = await selectProviderScope(page, lorcanaDownstreamCatalogItemsJourney);
  const promoted =
    (await promoteFirstEligibleObservationFromReview(page, selectedScope)) ??
    (await promoteFromCompletedImportJobReview(page, selectedScope)) ??
    (await promoteSelectedScopeFromSharedImporter(page, selectedScope));
  const result = promoted ?? (await reapplyPromotedObservationFromSharedImporter(page, selectedScope));

  await openCatalogItemsHandoff(page, result.providerKey);
  await expectCatalogItemsProjectionForProvider(page, result);

  console.log(
    `[catalog-staging-provider-uat] Lorcana downstream Catalog Items projection verified: mode=${result.mode}, provider=${result.providerKey}, unit=${result.unitKey}, scope=${result.selectedScope}, selectedObservationIds=${
      result.selectedObservationIds.join(",") || "scope"
    }, promotionPreviewId=${result.promotionPreviewId ?? "none"}, jobId=${result.jobId ?? "none"}`,
  );
}

async function promoteFromCompletedImportJobReview(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<LorcanaDownstreamSmokeResult | null> {
  const opened = await openCompletedImportJobObservationReview(
    page,
    lorcanaDownstreamCatalogItemsJourney.unitKey,
    selectedScope,
  );
  if (!opened) {
    return null;
  }

  return promoteFirstEligibleObservationFromReview(page, selectedScope);
}

async function openCompletedImportJobObservationReview(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<boolean> {
  await expandWorkflowStage(page, "run-sync");
  const row = await completedImportJobRowLocatorForSelectedUnit(page, unitKey, selectedScope, sourceOptionTimeoutMs);
  if (!row) {
    return false;
  }

  const review = row.getByRole("link", { name: "Review observations" }).first();
  await expect(review).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await review.click();
  await page.waitForLoadState("domcontentloaded", { timeout: pageReadyTimeoutMs }).catch(() => undefined);
  await expect(page.getByRole("heading", { name: "Source Observation review" })).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  return true;
}

async function promoteFirstEligibleObservationFromReview(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<LorcanaDownstreamSmokeResult | null> {
  await expandWorkflowStage(page, "review-changes");
  await expect(page.getByRole("heading", { name: "Source Observation review" })).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });

  const previewForms = page.locator(
    'form[data-catalog-primary-workbench-command="preview-promotion"]:not([data-catalog-source-scope-unit])',
  );
  const preview = await clickFirstEnabledObservationCommand(previewForms, {
    requireSelectedObservationIds: true,
  });
  if (!preview) {
    return null;
  }

  const promotionPreviewId = await expectPromotionPreviewReady(page);
  await executePromotionFromFreshPreview(page);
  const jobId = currentSearchParam(page, "jobId");

  return {
    mode: "promote",
    providerKey: selectedScope.providerKey,
    unitKey: lorcanaDownstreamCatalogItemsJourney.unitKey,
    selectedScope: selectedScope.displayLabel,
    selectedObservationIds: preview.selectedObservationIds,
    promotionPreviewId,
    jobId,
  };
}

async function promoteSelectedScopeFromSharedImporter(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<LorcanaDownstreamSmokeResult | null> {
  const scopePreviewForms = sourceScopeCommandForms(
    page,
    lorcanaDownstreamCatalogItemsJourney.unitKey,
    "preview-promotion",
  ).filter({ has: page.getByRole("button", { name: /^Preview / }) });
  if (!(await clickFirstEnabledCommandForm(scopePreviewForms))) {
    return null;
  }

  const promotionPreviewId = await tryPromotionPreviewReady(page, 15_000);
  if (!promotionPreviewId) {
    console.log(
      `[catalog-staging-provider-uat] ${lorcanaDownstreamCatalogItemsJourney.unitKey} source-scope promotion preview did not produce a routable preview for ${selectedScope.displayLabel}; trying row-level or reapply fallback.`,
    );
    return null;
  }
  await executePromotionFromFreshPreview(page);
  const jobId = currentSearchParam(page, "jobId");

  return {
    mode: "promote",
    providerKey: selectedScope.providerKey,
    unitKey: lorcanaDownstreamCatalogItemsJourney.unitKey,
    selectedScope: selectedScope.displayLabel,
    selectedObservationIds: [],
    promotionPreviewId,
    jobId,
  };
}

async function reapplyPromotedObservationFromSharedImporter(
  page: Page,
  selectedScope: SelectedProviderScope,
): Promise<LorcanaDownstreamSmokeResult> {
  const sourceScopeReapplyForms = sourceScopeCommandForms(
    page,
    lorcanaDownstreamCatalogItemsJourney.unitKey,
    "start-reapply",
  ).filter({ has: page.getByRole("button", { name: /^Reapply / }) });
  if (await clickFirstEnabledCommandForm(sourceScopeReapplyForms)) {
    await expectCommandQueued(page);
    return {
      mode: "reapply",
      providerKey: selectedScope.providerKey,
      unitKey: lorcanaDownstreamCatalogItemsJourney.unitKey,
      selectedScope: selectedScope.displayLabel,
      selectedObservationIds: [],
      promotionPreviewId: null,
      jobId: currentSearchParam(page, "jobId"),
    };
  }

  await expandWorkflowStage(page, "review-changes");
  const rowReapplyForms = page.locator(
    'form[data-catalog-primary-workbench-command="start-reapply"]:not([data-catalog-source-scope-unit])',
  );
  const reapplied = await clickFirstEnabledObservationCommand(rowReapplyForms, {
    requireSelectedObservationIds: true,
  });
  if (!reapplied) {
    throw new Error(
      `Lorcana downstream smoke could not find an eligible Source Observation to promote or a promoted Source Observation to reapply for ${selectedScope.displayLabel}.`,
    );
  }

  await expectCommandQueued(page);
  return {
    mode: "reapply",
    providerKey: selectedScope.providerKey,
    unitKey: lorcanaDownstreamCatalogItemsJourney.unitKey,
    selectedScope: selectedScope.displayLabel,
    selectedObservationIds: reapplied.selectedObservationIds,
    promotionPreviewId: null,
    jobId: currentSearchParam(page, "jobId"),
  };
}

async function clickFirstEnabledObservationCommand(
  forms: Locator,
  input: Readonly<{ requireSelectedObservationIds: boolean }>,
): Promise<{ selectedObservationIds: readonly string[]; promotionPreviewId: string | null } | null> {
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    const count = await forms.count();
    for (let index = 0; index < count; index += 1) {
      const form = forms.nth(index);
      const selectedObservationIds = await selectedObservationIdsFromForm(form);
      if (input.requireSelectedObservationIds && selectedObservationIds.length === 0) {
        continue;
      }

      const promotionPreviewId = await hiddenInputValue(form, "promotionPreviewId")
        .then(emptyToNull)
        .catch(() => null);
      if (await clickCommandFormButtonIfEnabled(form)) {
        return {
          selectedObservationIds,
          promotionPreviewId,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return null;
}

async function clickFirstEnabledCommandForm(forms: Locator): Promise<boolean> {
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    const count = await forms.count();
    for (let index = 0; index < count; index += 1) {
      if (await clickCommandFormButtonIfEnabled(forms.nth(index))) {
        return true;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return false;
}

async function selectedObservationIdsFromForm(form: Locator): Promise<readonly string[]> {
  return hiddenInputValue(form, "selectedObservationIds")
    .then((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .catch(() => []);
}

async function clickCommandFormButtonIfEnabled(form: Locator): Promise<boolean> {
  const button = form.getByRole("button").first();
  if (!(await button.isVisible({ timeout: 1_000 }).catch(() => false))) {
    return false;
  }
  if (!(await button.isEnabled().catch(() => false))) {
    return false;
  }

  await button.click();
  return true;
}

async function expectPromotionPreviewReady(page: Page): Promise<string> {
  const promotionPreviewId = await tryPromotionPreviewReady(page, syncTimeoutMs);
  if (!promotionPreviewId) {
    throw new Error("Expected promotion preview to be ready with a routable promotionPreviewId before the timeout.");
  }

  return promotionPreviewId;
}

async function tryPromotionPreviewReady(page: Page, timeout: number): Promise<string | null> {
  if (
    !(await page
      .getByText("Promotion preview ready")
      .first()
      .isVisible({ timeout })
      .catch(() => false))
  ) {
    return null;
  }
  await expect(
    page
      .getByText("Promotion preview is ready for the current provider, scope, filters, and selection checkpoint.")
      .first(),
  ).toBeVisible({ timeout });

  return waitForSearchParamOrNull(page, "promotionPreviewId", timeout);
}

async function executePromotionFromFreshPreview(page: Page): Promise<void> {
  await expandWorkflowStage(page, "create-items");
  await expect(page.getByText("Previewed impact is current").first()).toBeVisible({ timeout: syncTimeoutMs });

  const confirmation = page.getByRole("checkbox", { name: /^I confirm this will promote/i }).first();
  await expect(confirmation).toBeEnabled({ timeout: syncTimeoutMs });
  if (!(await confirmation.isChecked().catch(() => false))) {
    await confirmation.check();
  }

  const executeForm = page
    .locator('form[data-catalog-primary-workbench-command="execute-promotion"]')
    .filter({ has: page.getByRole("button", { name: "Create or update Catalog Items" }) })
    .first();
  const executeButton = executeForm.getByRole("button", { name: "Create or update Catalog Items" });
  await expect(executeButton).toBeEnabled({ timeout: syncTimeoutMs });
  await executeButton.click();
  await expectCommandQueued(page);
}

async function openCatalogItemsHandoff(page: Page, providerKey: string): Promise<void> {
  await expandWorkflowStage(page, "create-items");
  const handoff = page.getByRole("link", { name: `Open Catalog Items for ${providerKey}` }).first();
  await expect(handoff).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await expect(handoff).toHaveAttribute("href", `/catalog/catalog-items?source=${providerKey}`, {
    timeout: sourceOptionTimeoutMs,
  });
  await handoff.click();
  await page.waitForLoadState("domcontentloaded", { timeout: pageReadyTimeoutMs }).catch(() => undefined);
}

async function expectCatalogItemsProjectionForProvider(
  page: Page,
  result: LorcanaDownstreamSmokeResult,
): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/catalog/catalog-items\\?source=${result.providerKey}`), {
    timeout: pageReadyTimeoutMs,
  });
  await expect(page.getByRole("heading", { name: "Catalog Items" })).toBeVisible({ timeout: pageReadyTimeoutMs });

  const deadline = Date.now() + downstreamProjectionTimeoutMs;
  let observedRows: readonly string[] = [];
  while (Date.now() < deadline) {
    await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
    observedRows = await catalogItemProviderRowTexts(page, result.providerKey);
    const projected = observedRows.find((row) => /\b(?:draft|active)\b/i.test(row));
    if (projected) {
      console.log(`[catalog-staging-provider-uat] Lorcana Catalog Items row observed: ${projected}`);
      return;
    }

    await page.waitForTimeout(5_000);
    await page.reload({ waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs }).catch(() => undefined);
  }

  throw new Error(
    `Catalog Items did not show a ${result.providerKey} draft or active downstream projection after ${
      result.mode
    } for ${result.selectedScope}. Observed provider rows: ${observedRows.join(" | ") || "none"}`,
  );
}

async function catalogItemProviderRowTexts(page: Page, providerKey: string): Promise<readonly string[]> {
  return page
    .getByRole("row")
    .filter({ hasText: providerKey })
    .allInnerTexts()
    .then((rows) => rows.map(normalizeWhitespace).filter(Boolean))
    .catch(() => []);
}

async function waitForSearchParam(page: Page, name: string, timeout: number): Promise<string> {
  const value = await waitForSearchParamOrNull(page, name, timeout);
  if (value) {
    return value;
  }

  throw new Error(`Expected the current operator route to include ${name} before the timeout.`);
}

async function waitForSearchParamOrNull(page: Page, name: string, timeout: number): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = currentSearchParam(page, name);
    if (value) {
      return value;
    }
    if (
      await page
        .getByText("No promotable observations")
        .first()
        .isVisible({ timeout: 250 })
        .catch(() => false)
    ) {
      return null;
    }
    await page.waitForTimeout(500);
  }

  return null;
}

function currentSearchParam(page: Page, name: string): string | null {
  return emptyToNull(new URL(page.url()).searchParams.get(name) ?? "");
}

function importJobRowReachedUnsuccessfulTerminal(row: string): boolean {
  return /\bimport job \S+ is (?:failed|cancelled|partial)\b/i.test(row);
}

function importJobRowReachedCompletedTerminal(row: string): boolean {
  return /\bimport job \S+ is completed\b/i.test(row);
}

function sourceScopeCommandForms(page: Page, unitKey: string, command: string): Locator {
  return page.locator(
    `form[data-catalog-primary-workbench-command="${command}"][data-catalog-source-scope-unit="${unitKey}"]`,
  );
}

function sourceScopeSyncForms(page: Page, unitKey: string): Locator {
  return sourceScopeCommandForms(page, unitKey, "start-provider-import").filter({
    has: page.getByRole("button", { name: /^Sync / }),
  });
}

async function expectCommandQueued(page: Page): Promise<void> {
  await expect(page.getByText("Command queued").first()).toBeVisible({ timeout: syncTimeoutMs });
  await expect(
    page.getByText("The durable job is queued with this provider, scope, profile, and review context.").first(),
  ).toBeVisible({ timeout: syncTimeoutMs });
}

async function expectCommandQueuedOrActiveImport(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<void> {
  const deadline = Date.now() + syncTimeoutMs;
  let nextExpandAt = Date.now();
  while (Date.now() < deadline) {
    if (
      await page
        .getByText("Command queued")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      await expectCommandQueued(page);
      return;
    }
    if (await hasActiveImportJobForSelectedUnit(page, unitKey, selectedScope, 500)) {
      return;
    }
    if (Date.now() >= nextExpandAt) {
      await expandWorkflowStage(page, "run-sync").catch(() => undefined);
      nextExpandAt = Date.now() + 5_000;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    `Expected a queued command banner or visible queued/running import job for ${unitKey} and ${selectedScope.displayLabel} before the timeout.`,
  );
}

async function hasActiveImportJobForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    if (rows.some((row) => /import job .*(?:queued|running)/i.test(row))) {
      return true;
    }
    await page.waitForTimeout(250);
  }

  return false;
}

async function expectActiveImportJobForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<void> {
  await expect(page.getByText("Import already running", { exact: true }).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    const rows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    const active = rows.find((row) => /import job .*(?:queued|running)/i.test(row));
    if (active) {
      return;
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Selected unit ${unitKey} should have a visible current or covering queued/running import job row for ${selectedScope.displayLabel}.`,
  );
}

async function completedImportJobRowLocatorForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
  timeout: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  const scopeLabels = selectedProviderScopeActiveJobScopeLabels(selectedScope).map(normalizeWhitespace);
  while (Date.now() < deadline) {
    const rows = importJobRowsForSelectedUnit(page, unitKey);
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const text = await row
        .innerText()
        .then(normalizeWhitespace)
        .catch(() => "");
      if (
        text &&
        importJobRowReachedCompletedTerminal(text) &&
        importJobRowTextMatchesSelectedScope(text, scopeLabels)
      ) {
        return row;
      }
    }
    await page.waitForTimeout(250);
  }

  return null;
}

function importJobRowsForSelectedUnit(page: Page, unitKey: string): Locator {
  return page
    .getByRole("row")
    .filter({ has: page.getByText(`Unit: ${unitKey}`, { exact: true }) })
    .filter({ has: page.getByText(/^(Current scope|Overlapping scope)$/) });
}

async function visibleImportJobRowTexts(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<readonly string[]> {
  const scopeLabels = selectedProviderScopeActiveJobScopeLabels(selectedScope).map(normalizeWhitespace);
  return importJobRowsForSelectedUnit(page, unitKey)
    .allInnerTexts()
    .then((rows) =>
      rows.map(normalizeWhitespace).filter((row) => row && importJobRowTextMatchesSelectedScope(row, scopeLabels)),
    )
    .catch(() => []);
}

function importJobRowTextMatchesSelectedScope(row: string, scopeLabels: readonly string[]): boolean {
  const rowScope = importJobRowScopeLabel(row);
  return Boolean(rowScope && scopeLabels.includes(rowScope));
}

function importJobRowScopeLabel(row: string): string | null {
  const match = row.match(/\bScope:\s+(?<scope>.+?)(?=\s+(?:Queued|Running|Completed|Failed|Cancelled)\b|$)/i);
  return match?.groups?.scope ? normalizeWhitespace(match.groups.scope) : null;
}

function selectedProviderScopeActiveJobScopeLabels(selectedScope: SelectedProviderScope): readonly string[] {
  const labels = selectedProviderScopeDisplayLabelCandidates(
    selectedScope.providerKey,
    selectedScope.importScope,
    selectedScope.fields,
  ).flatMap(scopeLabelPrefixes);
  return [...new Set(labels.filter(Boolean))];
}

function scopeLabelPrefixes(label: string): readonly string[] {
  const segments = label.split(" / ").filter(Boolean);
  return Array.from({ length: segments.length }, (_, index) => segments.slice(0, segments.length - index).join(" / "));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function selectedProviderScopeFromCommandForm(commandForm: Locator): Promise<SelectedProviderScope> {
  const providerKey = await hiddenInputValue(commandForm, "providerKey");
  const importScope = emptyToNull(await hiddenInputValue(commandForm, "importScope"));
  const fields = await selectedProviderScopeFieldsFromCommandForm(commandForm);
  expect(
    fields.length,
    "The shared importer command form should carry the selected source scope fields.",
  ).toBeGreaterThan(0);
  return {
    providerKey,
    importScope,
    fields,
    displayLabel: selectedProviderScopeDisplayLabel(providerKey, importScope, fields),
  };
}

async function hiddenInputValue(form: Locator, name: string): Promise<string> {
  return form.locator(`input[name="${name}"]`).first().inputValue();
}

async function selectedProviderScopeFieldsFromCommandForm(
  commandForm: Locator,
): Promise<readonly SelectedProviderScopeField[]> {
  const fieldNames = [
    "languageCode",
    "productLineId",
    "productLineName",
    "seriesId",
    "seriesName",
    "expansionId",
    "expansionName",
    "setId",
    "setCode",
    "setName",
  ];
  const fields = await Promise.all(
    fieldNames.map(async (name) => ({
      name,
      value: (await optionalHiddenInputValue(commandForm, name)).trim(),
    })),
  );
  return fields.filter((field) => field.value.length > 0);
}

async function optionalHiddenInputValue(form: Locator, name: string): Promise<string> {
  const input = form.locator(`input[name="${name}"]`).first();
  return (await input.count()) > 0 ? input.inputValue() : "";
}

function selectedProviderScopeDisplayLabel(
  providerKey: string,
  importScope: string | null,
  fields: readonly SelectedProviderScopeField[],
): string {
  return selectedProviderScopeDisplayLabelCandidates(providerKey, importScope, fields)[0] ?? providerKey;
}

function selectedProviderScopeDisplayLabelCandidates(
  providerKey: string,
  importScope: string | null,
  fields: readonly SelectedProviderScopeField[],
): readonly string[] {
  const value = (name: string) => fields.find((field) => field.name === name)?.value;
  const productLineSegments = uniqueTruthy([value("productLineName"), value("productLineId")]);
  const seriesSegments = uniqueTruthy([value("seriesName"), value("seriesId")]);
  const expansionSegments = uniqueTruthy([
    value("expansionName"),
    value("expansionId"),
    value("setName"),
    value("setCode"),
    value("setId"),
  ]);
  const structured = cartesianScopeLabels([
    [providerKey],
    uniqueTruthy([value("languageCode")]),
    productLineSegments,
    seriesSegments,
    expansionSegments,
  ]);
  const importScopeLabel = importScope ? scopeDisplayLabelFromImportScope(providerKey, importScope) : null;
  const candidates = [...structured, importScopeLabel]
    .filter((candidate): candidate is string => Boolean(candidate))
    .sort((left, right) => right.split(" / ").length - left.split(" / ").length);

  return [...new Set(candidates)];
}

function cartesianScopeLabels(segmentGroups: readonly (readonly string[])[]): readonly string[] {
  return segmentGroups.reduce<readonly string[]>(
    (labels, segments) => {
      const availableSegments = segments.length > 0 ? segments : [""];
      return labels.flatMap((label) =>
        availableSegments.map((segment) => [label, segment].filter(Boolean).join(" / ")),
      );
    },
    [""],
  );
}

function uniqueTruthy(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function scopeDisplayLabelFromImportScope(providerKey: string, importScope: string): string {
  return [providerKey, ...importScope.split(":").filter(Boolean)].filter(Boolean).join(" / ");
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function expectImporterVisible(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", {
      name: "Pull provider data, review Source Observations, promote Catalog facts",
    }),
  ).toBeVisible({ timeout: pageReadyTimeoutMs });
}

async function isImporterVisible(page: Page, timeout: number): Promise<boolean> {
  return page
    .getByRole("heading", {
      name: "Pull provider data, review Source Observations, promote Catalog facts",
    })
    .isVisible({ timeout })
    .catch(() => false);
}

async function selectOption(
  select: Locator,
  choice: SelectChoice,
  recoverMissingOptions?: MissingOptionRecovery,
): Promise<void> {
  await expectSelectVisible(select, recoverMissingOptions);

  const option = await waitForOption(select, choice, recoverMissingOptions);
  if (await select.isDisabled()) {
    const currentValue = await select.inputValue();
    if (currentValue === option.value) {
      return;
    }
    throw new Error(
      `Expected disabled select to already use ${option.label} (${option.value}), but current value is ${currentValue}.`,
    );
  }

  await expect(select).toBeEnabled({ timeout: sourceOptionTimeoutMs });
  await select.selectOption({ value: option.value });
}

async function waitForOption(
  select: Locator,
  choice: SelectChoice,
  recoverMissingOptions?: MissingOptionRecovery,
): Promise<{ label: string; value: string }> {
  const labels = choice.labels ?? [];
  const values = choice.values ?? [];
  const deadline = Date.now() + sourceOptionTimeoutMs;
  let nextRecoveryAttemptAt = Date.now() + 5_000;
  const fallbackOptionAllowedAt = Date.now() + 5_000;
  let recoveryAttempts = 0;
  let observedOptions: readonly { label: string; value: string }[] = [];

  while (Date.now() < deadline) {
    observedOptions = await select
      .locator("option")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: (node.textContent ?? "").trim(),
          value: (node as HTMLOptionElement).value,
        })),
      )
      .catch(() => []);
    const valueMatch = values.map((value) => observedOptions.find((option) => option.value === value)).find(Boolean);
    if (valueMatch) {
      return valueMatch;
    }
    const labelMatch = labels.map((label) => observedOptions.find((option) => option.label === label)).find(Boolean);
    if (labelMatch) {
      return labelMatch;
    }
    const fallback = choice.fallbackToFirstAvailableOption;
    const fallbackOption =
      fallback && Date.now() >= fallbackOptionAllowedAt && (!recoverMissingOptions || recoveryAttempts > 0)
        ? observedOptions.find((option) => isSelectableFallbackOption(option, fallback))
        : undefined;
    if (fallbackOption) {
      return fallbackOption;
    }

    if (recoverMissingOptions && recoveryAttempts < 3 && Date.now() >= nextRecoveryAttemptAt) {
      recoveryAttempts += 1;
      nextRecoveryAttemptAt = Date.now() + 15_000;
      if (await recoverMissingOptions()) {
        await expectSelectVisible(select, recoverMissingOptions);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Expected select to contain one of: ${[...values, ...labels].join(", ")}. Observed: ${observedOptions
      .map((option) => `${option.label} (${option.value})`)
      .join(", ")}`,
  );
}

async function expectSelectVisible(select: Locator, recoverMissingOptions?: MissingOptionRecovery): Promise<void> {
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    if (await select.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return;
    }

    if (recoverMissingOptions && (await recoverMissingOptions())) {
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await expect(select).toBeVisible({ timeout: 1_000 });
}

function isSelectableFallbackOption(
  option: { label: string; value: string },
  fallback: NonNullable<SelectChoice["fallbackToFirstAvailableOption"]>,
): boolean {
  return (
    option.value.length > 0 &&
    option.label.length > 0 &&
    (!fallback.valuePattern || fallback.valuePattern.test(option.value))
  );
}

async function refreshSourceOptionGroup(page: Page, label: string | RegExp): Promise<boolean> {
  const sourceOptionsPanel = page.locator("[data-catalog-source-options-status]").first();
  if (!(await sourceOptionsPanel.isVisible({ timeout: 1_000 }).catch(() => false))) {
    return false;
  }

  const optionGroup = sourceOptionsPanel
    .locator("[data-source-option-page]")
    .filter({ has: sourceOptionGroupLabel(page, label) })
    .first();
  const refreshTarget = (await optionGroup.isVisible({ timeout: 1_000 }).catch(() => false))
    ? optionGroup
    : sourceOptionsPanel;

  const forceRefresh = refreshTarget.getByRole("button", { name: "Force refresh" }).first();
  if (await forceRefresh.isEnabled().catch(() => false)) {
    await forceRefresh.click();
    await waitForSourceOptionsToSettle(page);
    return true;
  }

  const reload = refreshTarget.getByRole("button", { name: "Reload" }).first();
  if (await reload.isEnabled().catch(() => false)) {
    await reload.click();
    await waitForSourceOptionsToSettle(page);
    return true;
  }

  const refreshAll = sourceOptionsPanel.getByRole("button", { name: "Refresh all" }).first();
  if (await refreshAll.isEnabled().catch(() => false)) {
    await refreshAll.click();
    await waitForSourceOptionsToSettle(page);
    return true;
  }

  return false;
}

async function recoverSourceOptionSelection(page: Page, label: string | RegExp): Promise<boolean> {
  return (await recoverImporterFromAdminError(page)) || refreshSourceOptionGroup(page, label);
}

async function recoverImporterFromAdminError(page: Page): Promise<boolean> {
  const adminError = page.getByRole("heading", { name: "Admin Error" });
  if (!(await adminError.isVisible({ timeout: 1_000 }).catch(() => false))) {
    return false;
  }

  const retry = page.getByRole("link", { name: "Retry" }).first();
  if (await retry.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await retry.click();
  } else {
    await page.reload({ waitUntil: "domcontentloaded", timeout: pageReadyTimeoutMs }).catch(() => undefined);
  }

  await page.waitForLoadState("domcontentloaded", { timeout: pageReadyTimeoutMs }).catch(() => undefined);
  if (!(await isImporterVisible(page, 10_000))) {
    return false;
  }

  await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 30_000 });
  return true;
}

function sourceOptionGroupLabel(page: Page, label: string | RegExp): Locator {
  return typeof label === "string" ? page.getByText(label, { exact: true }) : page.getByText(label);
}

async function waitForSourceOptionsToSettle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: pageReadyTimeoutMs }).catch(() => undefined);
  await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", {
    timeout: pageReadyTimeoutMs,
  });
  await page
    .getByText("Loading source options", { exact: true })
    .waitFor({ state: "hidden", timeout: sourceOptionTimeoutMs })
    .catch(() => undefined);
}
