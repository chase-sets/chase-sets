import { expect, test, type Locator, type Page } from "@playwright/test";

const runStagingProviderUat = process.env.CATALOG_STAGING_PROVIDER_UAT === "true";
const catalogAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const catalogAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const pageReadyTimeoutMs = 90_000;
const sourceOptionTimeoutMs = 90_000;
const syncTimeoutMs = 120_000;

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
    name: "Pokemon set regression through TCGdex",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    scope: [
      { label: "Language", choice: { labels: ["Japanese"], values: ["ja"] } },
      { label: "Series", choice: { labels: ["Scarlet & Violet"], values: ["SV"] } },
      { label: "Expansion", choice: { labels: ["Super Electric Breaker"], values: ["SV8"] } },
    ],
  },
  {
    name: "MTG set regression through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:mtg:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["Magic"], values: ["1"] } },
      { label: "Set Name", choice: { labels: ["Time Spiral", "Classic Sixth Edition"] } },
    ],
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
  test("operator syncs Pokemon, MTG, and Yu-Gi-Oh provider scopes from the shared importer UI @catalog-staging-provider-uat", async ({
    page,
  }) => {
    test.setTimeout(900_000);
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
        await syncSelectedProviderUnit(page, journey.unitKey, selectedScope);
      });
    }
  });
});

async function signInThroughVisibleForm(page: Page): Promise<void> {
  await page.goto("/catalog/sign-in?returnTo=%2Fcatalog%2Fintegrations", {
    waitUntil: "domcontentloaded",
    timeout: pageReadyTimeoutMs,
  });

  if (await isImporterVisible(page, 5_000)) {
    return;
  }

  const emailInput = page.getByRole("textbox", { name: /email|phone/i });
  await expect(emailInput).toBeVisible({ timeout: pageReadyTimeoutMs });
  await emailInput.fill(catalogAdminEmail);
  await page.getByRole("button", { name: /^continue$/i }).click();

  const passwordChoice = page.getByText(/^Password$/).first();
  if (await passwordChoice.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await passwordChoice.click();
  }

  if (await isImporterVisible(page, 5_000)) {
    return;
  }

  const passwordInput = page.locator('input[type="password"]').first();
  await expect(
    passwordInput,
    "Password input should appear after continuing with the staging admin email.",
  ).toBeVisible({ timeout: 45_000 });
  await passwordInput.fill(catalogAdminPassword);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expectImporterVisible(page);
}

async function openCatalogImporter(page: Page): Promise<void> {
  if (!(await isImporterVisible(page, 2_000))) {
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
  await selectOption(provider, { values: [journey.providerKey] });
  await expect(provider).toHaveValue(journey.providerKey, { timeout: pageReadyTimeoutMs });

  const unit = contextBar.getByRole("combobox", { name: "Unit" });
  await selectOption(unit, { values: [journey.unitKey] });
  await expect(unit).toHaveValue(journey.unitKey, { timeout: pageReadyTimeoutMs });

  for (const selection of journey.scope) {
    const sourceScope = page.getByRole("group", { name: "Source scope" });
    await expect(sourceScope).toBeVisible({ timeout: sourceOptionTimeoutMs });
    const scopeSelect = sourceScope.getByRole("combobox", { name: selection.label });
    await selectOption(scopeSelect, selection.choice, () => refreshSourceOptionGroup(page, selection.label));
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
): Promise<void> {
  const commandForm = sourceScopeSyncForms(page, unitKey).first();
  await expect(commandForm).toBeVisible({ timeout: sourceOptionTimeoutMs });

  const syncButton = commandForm.getByRole("button", { name: /^Sync / });
  const deadline = Date.now() + sourceOptionTimeoutMs;
  while (Date.now() < deadline) {
    if (await syncButton.isEnabled().catch(() => false)) {
      await syncButton.click();
      await expectCommandQueued(page);
      return;
    }

    if (await hasActiveImportJobForSelectedUnit(page, unitKey, selectedScope, 1_000)) {
      await expectActiveImportJobForSelectedUnit(page, unitKey, selectedScope);
      return;
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Sync action for ${unitKey} was neither enabled nor represented by a queued/running import job row in the shared UI.`,
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
  return activeImportJobRowsForSelectedUnit(page, unitKey, selectedScope)
    .first()
    .isVisible({ timeout })
    .catch(() => false);
}

async function expectActiveImportJobForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Promise<void> {
  const activeJobRow = activeImportJobRowsForSelectedUnit(page, unitKey, selectedScope).first();
  await expect(page.getByText("Import already running", { exact: true }).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  await expect(
    activeJobRow,
    `Selected unit ${unitKey} should have a visible current-scope queued/running import job row.`,
  ).toBeVisible({ timeout: sourceOptionTimeoutMs });
  await expect(activeJobRow.getByText(`Unit: ${unitKey}`).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  await expect(activeJobRow.getByText("Current scope", { exact: true }).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  await expect(activeJobRow.getByText(`Scope: ${selectedScope.displayLabel}`, { exact: true }).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
  await expect(activeJobRow.getByText(/import job .*(?:queued|running)/i).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
}

function activeImportJobRowsForSelectedUnit(
  page: Page,
  unitKey: string,
  selectedScope: SelectedProviderScope,
): Locator {
  return page
    .getByRole("row")
    .filter({ has: page.getByText(`Unit: ${unitKey}`, { exact: true }) })
    .filter({ has: page.getByText("Current scope", { exact: true }) })
    .filter({ has: page.getByText(`Scope: ${selectedScope.displayLabel}`, { exact: true }) })
    .filter({ has: page.getByText(/import job .*(?:queued|running)/i) });
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
  if (importScope) {
    return scopeDisplayLabelFromImportScope(providerKey, importScope);
  }

  const value = (name: string) => fields.find((field) => field.name === name)?.value;
  const segments = [
    providerKey,
    value("languageCode"),
    value("productLineName") ?? value("productLineId"),
    value("seriesName") ?? value("seriesId"),
    value("expansionName") ?? value("expansionId"),
  ].filter((segment): segment is string => Boolean(segment));

  return segments.join(" / ");
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
  await expect(select).toBeVisible({ timeout: sourceOptionTimeoutMs });

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
        await expect(select).toBeVisible({ timeout: sourceOptionTimeoutMs });
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
