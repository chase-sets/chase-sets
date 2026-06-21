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
    scope: [{ label: "Set", choice: { labels: ["Starter Deck: Yugi", "Legend of Blue Eyes White Dragon"] } }],
  },
  {
    name: "Yu-Gi-Oh set through YGOJSON / YAML Yugi upstream data",
    providerKey: "ygojson",
    unitKey: "ygojson:yugioh:set:reference-data",
    scope: [{ label: "Set", choice: { labels: ["Starter Deck: Yugi", "Legend of Blue Eyes White Dragon"] } }],
  },
  {
    name: "Yu-Gi-Oh set through the shared TCGplayer provider",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:yugioh:single-card:source-observation-import",
    scope: [
      { label: "Product Line", choice: { labels: ["Yu-Gi-Oh!", "Yu-Gi-Oh", "YuGiOh"], values: ["2"] } },
      { label: "Set Name", choice: { labels: ["Starter Deck: Yugi", "Legend of Blue Eyes White Dragon"] } },
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
        await selectProviderScope(page, journey);
        await syncSelectedProviderUnit(page, journey.unitKey);
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

async function selectProviderScope(page: Page, journey: ProviderSyncJourney): Promise<void> {
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
    await selectOption(scopeSelect, selection.choice);
    await expect(scopeSelect).not.toHaveValue("", { timeout: sourceOptionTimeoutMs });
  }

  await contextBar.getByRole("button", { name: "Select source scope" }).click();
  await expect(sourceScopeSyncForms(page, journey.unitKey).first()).toBeVisible({ timeout: sourceOptionTimeoutMs });
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

async function syncSelectedProviderUnit(page: Page, unitKey: string): Promise<void> {
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

    if (await hasActiveImportJobForSelectedUnit(page, unitKey, 1_000)) {
      await expectActiveImportJobForSelectedUnit(page, unitKey);
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

async function hasActiveImportJobForSelectedUnit(page: Page, unitKey: string, timeout: number): Promise<boolean> {
  return activeImportJobRowsForSelectedUnit(page, unitKey)
    .first()
    .isVisible({ timeout })
    .catch(() => false);
}

async function expectActiveImportJobForSelectedUnit(page: Page, unitKey: string): Promise<void> {
  const activeJobRow = activeImportJobRowsForSelectedUnit(page, unitKey).first();
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
  await expect(activeJobRow.getByText(/import job .*(?:queued|running)/i).first()).toBeVisible({
    timeout: sourceOptionTimeoutMs,
  });
}

function activeImportJobRowsForSelectedUnit(page: Page, unitKey: string): Locator {
  return page
    .getByRole("row")
    .filter({ has: page.getByText(`Unit: ${unitKey}`, { exact: true }) })
    .filter({ has: page.getByText("Current scope", { exact: true }) })
    .filter({ has: page.getByText(/import job .*(?:queued|running)/i) });
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

async function selectOption(select: Locator, choice: SelectChoice): Promise<void> {
  await expect(select).toBeVisible({ timeout: sourceOptionTimeoutMs });

  const option = await waitForOption(select, choice);
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

async function waitForOption(select: Locator, choice: SelectChoice): Promise<{ label: string; value: string }> {
  const labels = choice.labels ?? [];
  const values = choice.values ?? [];
  const deadline = Date.now() + sourceOptionTimeoutMs;
  let observedOptions: readonly { label: string; value: string }[] = [];

  while (Date.now() < deadline) {
    observedOptions = await select.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: (node.textContent ?? "").trim(),
        value: (node as HTMLOptionElement).value,
      })),
    );
    const valueMatch = observedOptions.find((option) => values.includes(option.value));
    if (valueMatch) {
      return valueMatch;
    }
    const labelMatch = observedOptions.find((option) => labels.includes(option.label));
    if (labelMatch) {
      return labelMatch;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Expected select to contain one of: ${[...values, ...labels].join(", ")}. Observed: ${observedOptions
      .map((option) => `${option.label} (${option.value})`)
      .join(", ")}`,
  );
}
