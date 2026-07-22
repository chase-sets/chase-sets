import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateBrowserE2eDisclosureGuard } from "./browser-e2e-disclosure-guard.mjs";

const historicalPath = "deployables/admin-web/e2e/catalog-integrations.spec.ts";
const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("browser E2E disclosure guard", () => {
  it("discovers and rejects the historical page-scoped Source options assertion", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const owner = page.locator("[data-catalog-import-context-bar='true']");
        const status = page
          .getByText(
            "Source options",
          )
          .first();
        await expect(status).toBeVisible();
        const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(owner.getByRole("combobox", { name: "Provider" })).toBeVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.discovery).toMatchObject({ scannedFiles: 1, candidateFiles: 1 });
    expect(result.violations).toEqual([expect.stringContaining(`${historicalPath}:`)]);
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ control: "source-options", classification: "unsafe-collapsed-owner" }),
        expect.objectContaining({ control: "provider", classification: "safe-open-owner" }),
      ]),
    );
  });

  it("discovers and rejects the historical scoped Provider assertion under a collapsed owner", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const disclosure = page.locator("[data-catalog-import-context-bar='true']");
        const provider = disclosure.getByRole(
          "combobox",
          { name: "Provider" },
        );
        await expect(provider).toBeVisible();
        const trigger = disclosure.getByRole("button", { name: /Step 0 · Choose import scope/ });
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(disclosure.getByText("Source options")).toBeVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.discovery.files).toEqual([historicalPath]);
    expect(result.violations).toEqual([expect.stringContaining("provider interaction")]);
  });

  it("enforces the same interaction shape at a filename with no Catalog vocabulary", async () => {
    const secondPath = "deployables/marketplace/e2e/account-settings.spec.ts";
    const root = await fixture({
      [secondPath]: playwrightSpec(`
        const owner = page.locator("[data-catalog-import-context-bar='true']");
        await expect(owner.getByRole("combobox", { name: "Provider" })).toBeVisible();
        const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(owner.getByText("Source options")).toBeVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.discovery.files).toEqual([secondPath]);
    expect(result.violations).toEqual([expect.stringContaining("provider interaction")]);
  });

  it("rejects a same-test function closure against the real discovery tree", async () => {
    const plantedPath = "deployables/marketplace/e2e/closure-flow.spec.ts";
    const root = await fixtureWithRealE2eTree({
      [plantedPath]: playwrightSpec(`
        const owner = page.locator("[data-catalog-import-context-bar='true']");
        async function expectProviderVisible() {
          await expect(owner.getByRole("combobox", { name: "Provider" })).toBeVisible();
        }
        await expectProviderVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: plantedPath,
          control: "provider",
          classification: "unsafe-collapsed-owner",
        }),
        expect.objectContaining({ control: "provider", classification: "safe-open-owner" }),
      ]),
    );
    expect(result.violations).toEqual([
      expect.stringMatching(new RegExp(`${plantedPath.replaceAll("/", "\\/")}:.*provider interaction`)),
    ]);
  });

  it("accepts an invoked arrow closure after imported executable open proof in the real tree", async () => {
    const plantedPath = "deployables/marketplace/e2e/closure-flow.spec.ts";
    const root = await fixtureWithRealE2eTree({
      "deployables/marketplace/e2e/support/closure-disclosure.ts": `
        import { expect, type Locator } from "@playwright/test";
        export async function reveal(scope: Locator) {
          const trigger = scope.getByRole("button", { name: /Step 0 · Choose import scope/ });
          await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
        }
      `,
      [plantedPath]: `
        import { expect, test } from "@playwright/test";
        import { reveal as openScope } from "./support/closure-disclosure";
        test("safe closure", async ({ page }) => {
          const owner = page.locator("[data-catalog-import-context-bar='true']");
          const ownerAlias = owner;
          const assertControls = async () => {
            await expect(owner.getByText("Source options")).toBeVisible();
            await expect(ownerAlias.getByRole("combobox", { name: "Provider" })).toBeVisible();
          };
          await openScope(ownerAlias);
          await assertControls();
        });
      `,
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
    expect(result.hits.filter((hit) => hit.file === plantedPath)).toEqual([
      expect.objectContaining({ control: "source-options", classification: "safe-open-owner" }),
      expect.objectContaining({ control: "provider", classification: "safe-open-owner" }),
    ]);
  });

  it("accepts a multiline alias through an imported open helper and owner scope", async () => {
    const root = await fixture({
      "deployables/admin-web/e2e/support/disclosure.ts": `
        import { expect, type Locator } from "@playwright/test";
        export const revealImportContext = async (scope: Locator) => {
          const region = scope;
          const trigger = region.getByRole("button", { name: /Step 0 · Choose import scope/ });
          await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
        };
      `,
      [historicalPath]: `
        import { expect, test } from "@playwright/test";
        import { revealImportContext as openScope } from "./support/disclosure";
        test("safe", async ({ page: originalPage }) => {
          const pageAlias = originalPage;
          const owner = pageAlias.locator("[data-catalog-import-context-bar='true']");
          const scopedOwner = owner;
          await openScope(scopedOwner);
          await expect(scopedOwner.getByText("Source options").first()).toBeVisible();
          await expect(scopedOwner.getByRole("combobox", { name: "Provider" })).toBeVisible();
        });
      `,
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
    expect(result.discovery.tracedHelperFiles).toBe(1);
    expect(result.hits.map((hit) => hit.classification)).toEqual(["safe-open-owner", "safe-open-owner"]);
  });

  it("accepts controls after an explicit already-open proof and a deliberate closed-state assertion", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const owner = page.locator("[data-catalog-import-context-bar='true']");
        const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        const provider = owner.getByRole("combobox", { name: "Provider" });
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(provider).toBeHidden();
        await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(provider).toBeVisible();
        await expect(owner.getByText("Source options")).toBeVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
    expect(result.hits.map((hit) => hit.classification)).toEqual([
      "explicit-closed-negative-control",
      "safe-open-owner",
      "safe-open-owner",
    ]);
  });

  it("follows a state-setting helper and rejects a visible assertion after that helper closes the owner", async () => {
    const root = await fixture({
      [historicalPath]: `
        import { expect, test } from "@playwright/test";
        async function setExpanded(disclosureTrigger, expanded) {
          const triggerAlias = disclosureTrigger;
          const expected = String(expanded);
          if ((await triggerAlias.getAttribute("aria-expanded")) !== expected) {
            await triggerAlias.click();
          }
        }
        test("unsafe close", async ({ page }) => {
          const owner = page.locator("[data-catalog-import-context-bar=\"true\"]");
          const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
          const provider = owner.getByRole("combobox", { name: "Provider" });
          await setExpanded(trigger, false);
          await expect(provider).toBeVisible();
          await setExpanded(trigger, true);
          await expect(owner.getByText("Source options")).toBeVisible();
        });
      `,
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([expect.stringContaining("provider interaction")]);
  });

  it("invalidates an earlier open proof when the disclosure trigger is clicked directly", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const owner = page.locator("[data-catalog-import-context-bar='true']");
        const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await trigger.click();
        await expect(owner.getByRole("combobox", { name: "Provider" })).toBeVisible();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(owner.getByText("Source options")).toBeVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([expect.stringContaining("provider interaction")]);
  });

  it("propagates direct-click invalidation from a function-expression closure back to its caller", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const owner = page.locator("[data-catalog-import-context-bar='true']");
        const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        const provider = owner.getByRole("combobox", { name: "Provider" });
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        const invalidateOwner = async function () {
          await trigger.click();
        };
        const invokeInvalidation = invalidateOwner;
        await invokeInvalidation();
        await expect(provider).toBeVisible();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(owner.getByText("Source options")).toBeVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([expect.stringContaining("provider interaction")]);
  });

  it("keeps closure state isolated between multiple disclosure owners", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const firstOwner = page.locator("[data-catalog-import-context-bar='true']");
        const secondOwner = page.locator("[data-catalog-import-context-bar='true']");
        const firstTrigger = firstOwner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        const secondTrigger = secondOwner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        await expect(firstTrigger).toHaveAttribute("aria-expanded", "true");
        async function assertSecondOwnerControls() {
          await expect(secondOwner.getByText("Source options")).toBeVisible();
          await expect(secondOwner.getByRole("combobox", { name: "Provider" })).toBeVisible();
        }
        await assertSecondOwnerControls();
        await expect(secondTrigger).toHaveAttribute("aria-expanded", "true");
        await expect(firstOwner.getByRole("combobox", { name: "Provider" })).toBeVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([
      expect.stringContaining("source-options interaction"),
      expect.stringContaining("provider interaction"),
    ]);
  });

  it("does not assign a closure's unrelated Provider interaction to a captured owner", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const owner = page.locator("[data-catalog-import-context-bar='true']");
        const inspectSettings = async () => {
          const settings = page.locator("[data-provider-settings='true']");
          await expect(settings.getByRole("combobox", { name: "Provider" })).toBeVisible();
        };
        await inspectSettings();
        const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(owner.getByText("Source options")).toBeVisible();
        await expect(owner.getByRole("combobox", { name: "Provider" })).toBeVisible();
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ control: "provider", classification: "outside-disclosure-ownership" }),
      ]),
    );
  });

  it("does not confuse an unrelated Provider control or an outside assertion with disclosure ownership", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const settings = page.locator("[data-provider-settings='true']");
        await expect(settings.getByRole("combobox", { name: "Provider" })).toBeVisible();
        await expect(page.getByText("Catalog control plane")).toBeVisible();
        await test.step("registered source-options coverage", async () => {
          const owner = page.locator("[data-catalog-import-context-bar='true']");
          const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
          await expect(owner.getByText("Source options")).toBeVisible();
          await expect(owner.getByRole("combobox", { name: "Provider" })).toBeVisible();
        });
      `),
    });

    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([]);
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ control: "provider", classification: "outside-disclosure-ownership" }),
        expect.objectContaining({ control: "source-options", classification: "safe-open-owner" }),
        expect.objectContaining({ control: "provider", classification: "safe-open-owner" }),
      ]),
    );
  });

  it("fails when registered disclosure-control contracts go stale", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec("await expect(page.getByText('Elsewhere')).toBeVisible();"),
    });
    const result = await validateBrowserE2eDisclosureGuard({ repoRoot: root });
    expect(result.violations).toEqual([
      expect.stringContaining("catalog-import-context/source-options"),
      expect.stringContaining("catalog-import-context/provider"),
    ]);
  });

  it("rejects exemptions instead of permitting unbounded or stale coverage holes", async () => {
    const root = await fixture({
      [historicalPath]: playwrightSpec(`
        const owner = page.locator("[data-catalog-import-context-bar='true']");
        const trigger = owner.getByRole("button", { name: /Step 0 · Choose import scope/ });
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(owner.getByText("Source options")).toBeVisible();
        await expect(owner.getByRole("combobox", { name: "Provider" })).toBeVisible();
      `),
    });
    const result = await validateBrowserE2eDisclosureGuard({
      repoRoot: root,
      exemptions: [{ file: "**/*.spec.ts", reason: "temporary" }],
    });
    expect(result.violations).toEqual([expect.stringContaining("does not accept exemptions")]);
  });
});

function playwrightSpec(body) {
  return `
    import { expect, test } from "@playwright/test";
    test.describe.serial("catalog", () => {
      test("control", async ({ page }) => {
        ${body}
      });
    });
  `;
}

async function fixture(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-e2e-disclosure-guard-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(entries)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

async function fixtureWithRealE2eTree(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-e2e-disclosure-real-tree-"));
  roots.push(root);
  await copyBrowserE2eSources(path.join(process.cwd(), "deployables"), root);
  for (const [relativePath, contents] of Object.entries(entries)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

async function copyBrowserE2eSources(directory, targetRoot, insideE2e = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name);
    const inE2e = insideE2e || entry.name === "e2e";
    if (entry.isDirectory()) {
      await copyBrowserE2eSources(source, targetRoot, inE2e);
      continue;
    }
    if (!inE2e || !/\.(?:ts|tsx)$/.test(entry.name)) continue;
    const target = path.join(targetRoot, path.relative(process.cwd(), source));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}
