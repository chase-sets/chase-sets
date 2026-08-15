import { readFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { signInWithPassword } from "./support/auth";

const seller = {
  email: process.env.MARKETPLACE_E2E_SELLER_EMAIL?.trim() || "demo@chasesets.test",
  password: process.env.MARKETPLACE_E2E_SELLER_PASSWORD?.trim() || "demo1234",
};

type Issue6020Theme = "light" | "dark";
type GithubPullRequestEvent = Readonly<{
  pull_request?: Readonly<{ number?: unknown; head?: Readonly<{ sha?: unknown }> }>;
}>;

function issue6020Authority() {
  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  const event = eventPath ? (JSON.parse(readFileSync(eventPath, "utf8")) as GithubPullRequestEvent) : null;
  const rawPrNumber = event?.pull_request?.number;
  const rawHeadSha = event?.pull_request?.head?.sha;
  const prNumber = typeof rawPrNumber === "number" && Number.isInteger(rawPrNumber) ? rawPrNumber : null;
  const headSha = typeof rawHeadSha === "string" ? rawHeadSha : null;
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (prNumber === null || prNumber <= 0 || headSha === null || !/^[0-9a-f]{40}$/.test(headSha))
  ) {
    throw new Error("issue #6020 hosted visual evidence requires an exact pull-request number and 40-character head");
  }
  return { prNumber: prNumber ?? 0, headSha: headSha ?? "local-unbound" };
}

async function setIssue6020Theme(page: Page, mode: Issue6020Theme) {
  const response = await page.request.put(`${new URL(page.url()).origin}/api/identity/preferences`, {
    data: { colorMode: mode },
  });
  expect(response.status(), `persist ${mode} theme`).toBe(200);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-chase-theme]").first()).toHaveAttribute("data-color-mode", mode);
}

async function attachIssue6020State(input: {
  page: Page;
  testInfo: TestInfo;
  state: "listing-detail" | "seller-desk";
  route: string;
  suite: "marketplace_seller";
  assertions: readonly string[];
  assertState: () => Promise<void>;
}) {
  await input.page.setViewportSize({ width: 1280, height: 900 });
  const authority = issue6020Authority();
  const observations: Array<Record<string, unknown>> = [];
  for (const theme of ["light", "dark"] as const) {
    await setIssue6020Theme(input.page, theme);
    await input.assertState();
    const name = `issue-6020-${input.state}-${theme}.png`;
    await input.testInfo.attach(name, {
      body: await input.page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    observations.push({ theme, name, route: input.route, assertions: input.assertions });
  }
  await input.testInfo.attach(`issue-6020-${input.state}-observation.json`, {
    body: Buffer.from(
      JSON.stringify(
        {
          schemaVersion: "issue-6020-state-observation/v1",
          issue: 6020,
          ...authority,
          suite: input.suite,
          state: input.state,
          viewport: { width: 1280, height: 900 },
          observations,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
}

async function expectPopulatedListingDetail(page: Page) {
  await expect(page).toHaveURL(/\/account\/listings\/lst_seed_charizard_base_set_psa_8(?:\?|$)/);
  await expect(page.getByText("$749.00", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Evidence ready")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Listing readiness" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Seed listing evidence image/i }).first()).toBeVisible();
}

async function expectPopulatedSellerDesk(page: Page) {
  await expect(page).toHaveURL(/\/account\/desk(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Seller Desk" })).toBeVisible();
  const rows = page.locator("[data-seller-desk-item]");
  expect(await rows.count(), "Seller Desk evidence requires a nonempty attention queue").toBeGreaterThan(0);
  const queueCount = page.getByText(/^\d+ to handle$/).first();
  await expect(queueCount).toBeVisible();
  expect(Number.parseInt((await queueCount.textContent()) ?? "0", 10)).toBeGreaterThan(0);
  for (const label of ["Active listings", "Open orders to ship", "Next payout", "Wallet balance"]) {
    const stat = page.getByText(label, { exact: true }).locator("..").locator("..");
    await expect(stat).toBeVisible();
    await expect(stat.locator(".font-heading")).not.toHaveText("");
  }
}

test.describe("seller Listing Evidence readiness", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await signInWithPassword(page, new URL(page.url()).origin, seller);
  });

  test("shows active compliance from server-owned slots @marketplace-seller @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.goto("/account/listings/lst_seed_charizard_base_set_psa_8", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Listing readiness" })).toBeVisible();
    await expect(page.getByText("Evidence ready")).toBeVisible();
    await expect(page.getByText("Required view: front")).toBeVisible();
    await expect(page.getByText("Required view: back")).toBeVisible();
    await expect(page.getByText("Required view: slab")).toBeVisible();
    await expect(page.getByText("Seller-supplied evidence", { exact: true })).toBeVisible();

    await attachIssue6020State({
      page,
      testInfo,
      state: "listing-detail",
      route: "/account/listings/lst_seed_charizard_base_set_psa_8",
      suite: "marketplace_seller",
      assertions: ["listing image visible", "$749.00 price visible", "evidence ready", "listing readiness visible"],
      assertState: () => expectPopulatedListingDetail(page),
    });

    await page.goto("/account/desk", { waitUntil: "domcontentloaded" });
    await attachIssue6020State({
      page,
      testInfo,
      state: "seller-desk",
      route: "/account/desk",
      suite: "marketplace_seller",
      assertions: [
        "Seller Desk heading visible",
        "attention queue nonempty",
        "queue count positive",
        "four KPI values visible",
      ],
      assertState: () => expectPopulatedSellerDesk(page),
    });
  });

  test("keeps the draft path available with mobile camera capture @marketplace-seller @browser-e2e-seed", async ({
    page,
  }) => {
    await page.goto("/account/listings/lst_seed_lugia_neo_genesis_draft", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Listing readiness" })).toBeVisible();
    await expect(page.getByLabel("Add seller-supplied evidence")).toHaveAttribute("capture", "environment");
    await expect(page.getByRole("button", { name: "Upload evidence" })).toBeVisible();
  });
});
