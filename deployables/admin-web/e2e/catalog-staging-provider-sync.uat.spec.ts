import { expect, test, type Locator, type Page } from "@playwright/test";

const runStagingProviderUat = process.env.CATALOG_STAGING_PROVIDER_UAT === "true";
const catalogAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const catalogAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const pageReadyTimeoutMs = 90_000;
const sourceOptionTimeoutMs = 90_000;
const syncTimeoutMs = 120_000;
const terminalSyncTimeoutMs = 300_000;

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

const providerSyncJourneys: readonly ProviderSyncJourney[] = [
  {
    name: "One Piece set through Scrydex bulk-first shared importer",
    providerKey: "scrydex",
    unitKey: "scrydex:one-piece:single-card:source-observation-import",
    scope: [
      {
        label: "Set",
        choice: {
          labels: ["Romance Dawn"],
          values: ["op-01", "OP01", "OP-01"],
          fallbackToFirstAvailableOption: { valuePattern: /^(?:OP|ST|EB|PRB)-?\d+$/i },
        },
      },
    ],
    preflight: {
      requestStrategy: "bulk-first",
      allowedUsageStates: ["checked", "not-configured", "unknown"],
      visibleText: [
        "Import preflight",
        "250",
        "id, name, number, printed_number, rarity, rarity_code, type, language, language_code, expansion",
        "Bulk-first",
        "Fetch Scrydex One Piece expansion cards with max page size",
        /scrydex:one-piece:expansion:[a-z0-9-]+:cards/i,
      ],
    },
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
    name: "MTG set regression through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:mtg:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["Magic"], values: ["1"] } },
      { label: "Set Name", choice: { labels: ["Time Spiral", "Classic Sixth Edition"] } },
    ],
    requiresTerminalSync: true,
  },
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

test.describe("catalog staging provider sync UAT", () => {
  test("operator syncs One Piece, Pokemon, MTG, and existing provider scopes from the shared importer UI @catalog-staging-provider-uat", async ({
    page,
  }) => {
    test.setTimeout(1_800_000);
    test.skip(!runStagingProviderUat, "Set CATALOG_STAGING_PROVIDER_UAT=true to run the staging provider sync UAT.");
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
          await expectImportPreflight(page, journey.preflight);
        }
        const previousJobRows = await syncSelectedProviderUnit(page, journey.unitKey, selectedScope);
        if (journey.requiresTerminalSync) {
          await expectImportJobSettledForSelectedUnit(page, journey.unitKey, selectedScope, previousJobRows);
        }
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
  await expect(page.getByRole("heading", { name: /Magic.*sync|Yu-Gi-Oh.*sync|Pokemon.*sync/i })).toHaveCount(0);
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
): Promise<readonly string[]> {
  const commandForm = sourceScopeSyncForms(page, unitKey).first();
  await expect(commandForm).toBeVisible({ timeout: sourceOptionTimeoutMs });
  const previousJobRows = await visibleImportJobRowTexts(page, unitKey, selectedScope);

  const syncButton = commandForm.getByRole("button", { name: /^Sync / });
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    if (await syncButton.isEnabled().catch(() => false)) {
      await syncButton.click();
      await expectCommandQueued(page);
      return previousJobRows;
    }

    if (await hasActiveImportJobForSelectedUnit(page, unitKey, selectedScope, 1_000)) {
      await expectActiveImportJobForSelectedUnit(page, unitKey, selectedScope);
      return previousJobRows;
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Sync action for ${unitKey} was neither enabled nor represented by a queued/running import job row for the selected or covering scope in the shared UI.`,
  );
}

async function expectImportPreflight(page: Page, expectation: ImportPreflightExpectation): Promise<void> {
  await expandWorkflowStage(page, /^Run sync\b/i);
  const panel = page.locator('[data-catalog-import-preview="ready"]').first();
  await expect(panel).toBeVisible({ timeout: sourceOptionTimeoutMs });
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
    await expect(panel.getByText(text).first()).toBeVisible({ timeout: sourceOptionTimeoutMs });
  }
}

async function expandWorkflowStage(page: Page, name: RegExp): Promise<void> {
  const trigger = page.getByRole("button", { name }).first();
  await expect(trigger).toBeVisible({ timeout: pageReadyTimeoutMs });
  if ((await trigger.getAttribute("aria-expanded").catch(() => null)) !== "true") {
    await trigger.click();
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
    observedRows = await visibleImportJobRowTexts(page, unitKey, selectedScope);
    const changedRows = observedRows.filter((row) => !previous.has(row));
    const unsuccessful = changedRows.find((row) => /\b(failed|cancelled)\b/i.test(row));
    if (unsuccessful) {
      throw new Error(`Import job for ${unitKey} reached an unsuccessful terminal state: ${unsuccessful}`);
    }
    const completed = changedRows.find((row) => /\bcompleted\b/i.test(row));
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

function sourceScopeSyncForms(page: Page, unitKey: string): Locator {
  return page
    .locator(
      `form[data-catalog-primary-workbench-command="start-provider-import"][data-catalog-source-scope-unit="${unitKey}"]`,
    )
    .filter({ has: page.getByRole("button", { name: /^Sync / }) });
}

async function expectCommandQueued(page: Page): Promise<void> {
  await expect(page.getByText("Command queued").first()).toBeVisible({ timeout: syncTimeoutMs });
  await expect(
    page.getByText("The durable job is queued with this provider, scope, profile, and review context.").first(),
  ).toBeVisible({ timeout: syncTimeoutMs });
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
  return scopeLabels.some((label) => row.includes(`Scope: ${label}`));
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
  ];
  const fields = await Promise.all(
    fieldNames.map(async (name) => ({
      name,
      value: (await hiddenInputValue(commandForm, name)).trim(),
    })),
  );
  return fields.filter((field) => field.value.length > 0);
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
  const structured = [
    providerKey,
    value("languageCode"),
    value("productLineName") ?? value("productLineId"),
    value("seriesName") ?? value("seriesId"),
    value("expansionName") ?? value("expansionId"),
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join(" / ");
  const importScopeLabel = importScope ? scopeDisplayLabelFromImportScope(providerKey, importScope) : null;
  const candidates = [structured, importScopeLabel]
    .filter((candidate): candidate is string => Boolean(candidate))
    .sort((left, right) => right.split(" / ").length - left.split(" / ").length);

  return [...new Set(candidates)];
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
