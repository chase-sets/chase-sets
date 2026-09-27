import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

// The seller authors, previews, activates and revises from the real Desk editor,
// then exercises the existing lifecycle and halt controls. A hold-only baseline
// policy makes precedence visible; no browser whale seed is needed.
//
// Seed safety: the policy governs one seeded listing, caps every move at 10%
// and holds any move within a tolerance far above that cap, so it can never
// change a price other specs assert. Teardown deletes it and releases the halt
// in `finally`, and the spec asserts the seller ends with zero active policies.
//
// Freshness: API-only setup and teardown wait for the policy projection to
// converge, because list membership is projected. UI actions never do: their
// redirects carry the command receipt, so the page itself shows the outcome.
//
// CI lane: tagged @marketplace-seller so pricing changes select this suite.

const repricingApi = "/api/marketplace/account/repricing-policies";
const specPolicyPrefix = "E2E repricing desk";
const governedListingId = "lst_seed_charizard_base_set_psa_8";

type PolicySummary = { policyId: string; name: string | null; status: "active" | "paused" | "deleted" };

const holdOnlyBody = {
  scope: { kind: "listing-set", listingIds: [governedListingId] },
  excludedListingIds: [],
  maxChangesPerDay: 25,
  rules: [
    {
      conditions: [],
      directive: {
        currencyCode: "USD",
        anchorChain: [{ source: "market-estimate" }],
        offset: { mode: "absolute", amount: "0" },
        floor: { mode: "absolute", amount: "1.00" },
        ceiling: null,
        tolerance: { mode: "absolute", amount: "100000.00" },
        rounding: { mode: "none" },
        maxMovePercent: 10,
        terminal: { kind: "hold" },
      },
    },
  ],
};

async function listPolicies(request: APIRequestContext): Promise<PolicySummary[]> {
  const response = await request.get(repricingApi);
  expect(response.status(), "repricing policy list").toBe(200);
  return (await response.json()) as PolicySummary[];
}

async function setHalt(request: APIRequestContext, engaged: boolean) {
  const response = await request.post(`${repricingApi}/halt`, { data: { engaged } });
  expect(response.status(), `set repricing halt engaged=${engaged}`).toBe(200);
  expect(((await response.json()) as { engaged: boolean }).engaged, `repricing halt engaged=${engaged}`).toBe(engaged);
}

// Deleting an already-deleted policy is a no-op, so cleanup by known ID is safe
// to repeat.
async function deletePolicy(request: APIRequestContext, policyId: string) {
  const response = await request.post(`${repricingApi}/${policyId}/delete`);
  expect(response.status(), `delete spec policy ${policyId}`).toBe(200);
}

// Waits until the projected default list agrees about these policy IDs. A
// deleted policy can still be listed with its folded `deleted` state until the
// projection drops it, so only absence proves membership converged.
async function expectListedPolicyIds(request: APIRequestContext, policyIds: readonly string[], listed: boolean) {
  await expect
    .poll(
      async () => {
        const present = new Set((await listPolicies(request)).map((policy) => policy.policyId));
        return policyIds.filter((policyId) => present.has(policyId) !== listed);
      },
      { message: `policies ${listed ? "listed" : "absent"}: ${policyIds.join(", ")}`, timeout: 30_000 },
    )
    .toEqual([]);
}

// Removes policies this spec created on an earlier interrupted run and releases
// a halt it may have left engaged, so every run starts from the same state.
async function resetSpecState(request: APIRequestContext) {
  const stalePolicyIds = (await listPolicies(request))
    .filter((policy) => policy.name?.startsWith(specPolicyPrefix))
    .map((policy) => policy.policyId);
  for (const policyId of stalePolicyIds) {
    await deletePolicy(request, policyId);
  }
  await expectListedPolicyIds(request, stalePolicyIds, false);
  await setHalt(request, false);
}

async function createHoldOnlyPolicy(request: APIRequestContext, name: string): Promise<string> {
  const dryRunResponse = await request.post(`${repricingApi}/dry-runs`, {
    data: { ...holdOnlyBody, scope: { kind: "all-listings" } },
  });
  expect(dryRunResponse.status(), "enqueue dry run").toBe(202);
  const { dryRunId } = (await dryRunResponse.json()) as { dryRunId: string };

  await expect
    .poll(
      async () => {
        const run = await request.get(`${repricingApi}/dry-runs/${dryRunId}`);
        return ((await run.json()) as { status: string }).status;
      },
      { message: `dry run ${dryRunId} completes`, timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe("completed");

  const createResponse = await request.post(repricingApi, { data: { dryRunId, name } });
  expect(createResponse.status(), "create policy from completed dry run").toBe(201);
  return ((await createResponse.json()) as { policyId: string }).policyId;
}

function visibleText(page: Page, text: string) {
  return page.getByText(text, { exact: true }).filter({ visible: true }).first();
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function previewEditor(page: Page) {
  await page.getByRole("button", { name: "Preview policy", exact: true }).click();
  await expect(page.getByTestId("repricing-dry-run-result")).toContainText(/Previewed .* over 1 listings/, {
    timeout: 60_000,
  });
}

// Policy redirects append a compact post-write receipt, so match the intended
// pathname and allow any query string.
async function expectPathname(page: Page, pathname: string) {
  await expect(page).toHaveURL((url) => url.pathname === pathname);
}

test.describe("Seller Desk repricing policies", () => {
  test("manages a policy from the list and detail pages and leaves no active policy @marketplace-seller @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fdesk%2Frepricing", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
    await expect(page).toHaveURL(/\/account\/desk\/repricing(?:\?|$)/);

    const request = page.request;
    await resetSpecState(request);
    const policyName = `${specPolicyPrefix} ${Date.now()}`;
    let policyId: string | null = null;
    let baselineId: string | null = null;

    try {
      const baselineName = `${specPolicyPrefix} precedence`;
      baselineId = await createHoldOnlyPolicy(request, baselineName);
      await expectListedPolicyIds(request, [baselineId], true);
      await page.getByRole("button", { name: "Create repricing policy" }).click();
      await page.getByLabel("Policy name", { exact: true }).fill(policyName);
      await choose(page, "Policy scope", "Selected listings");
      await page.getByLabel("Listing IDs (comma-separated)").fill(governedListingId);
      await choose(page, "Price floor", "Absolute floor");
      await page.getByLabel("Minimum price", { exact: true }).fill("1.00");
      await page.getByRole("button", { name: "Open up this preset" }).click();
      await expect(page.getByText("Structured editor", { exact: true })).toBeVisible();
      await choose(page, "Skip changes within", "Amount");
      await page.getByLabel("Tolerance amount").fill("100000.00");
      await page.getByLabel("Maximum move (%) - leave blank for no limit").fill("10");
      await expect(page.getByTestId("repricing-scope-preview")).toContainText(baselineName);
      await expect(page.getByTestId("repricing-scope-preview")).toContainText(/Matching listings\s*1/);
      await expect(page.getByTestId("repricing-scope-preview")).toContainText(/Governed listings\s*1/);
      await expect(page.getByTestId("repricing-scope-preview")).toContainText("Taken from existing policies");
      await captureResponsiveEvidence({ page, testInfo, claimId: "repricing-policy-editor-mobile" });
      await page.setViewportSize({ width: 1280, height: 900 });
      await previewEditor(page);
      await expect(page.getByRole("button", { name: "Activate policy", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Activate policy", exact: true }).click();
      await expect(page.getByTestId("repricing-policy-editor")).toHaveCount(0);
      policyId = (await listPolicies(request)).find((policy) => policy.name === policyName)!.policyId;
      await deletePolicy(request, baselineId);
      await expectListedPolicyIds(request, [baselineId], false);

      // List: the policy row with status, scope kind and budget row.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/account/desk/repricing", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Repricing", exact: true })).toBeVisible();
      const policyLink = page.getByRole("link", { name: policyName }).filter({ visible: true });
      await expect(policyLink).toBeVisible();
      await expect(visibleText(page, "Active")).toBeVisible();
      await expect(visibleText(page, "Selected listings (1)")).toBeVisible();
      await expect(
        page
          .getByText(/account-wide changes today/)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      await captureResponsiveEvidence({ page, testInfo, claimId: "repricing-policy-cards-mobile" });
      await page.setViewportSize({ width: 1280, height: 900 });

      // Detail: read-only body, then pause and resume in place.
      await policyLink.click();
      await expectPathname(page, `/account/desk/repricing/${policyId}`);
      await expect(page.getByRole("heading", { name: policyName })).toBeVisible();
      await expect(page.getByTestId("repricing-policy-rules")).toContainText("Rule 1");
      await expect(page.getByTestId("repricing-activity-counts")).toBeVisible();

      // Revise directly through the structured tier; preview is optional.
      await page.getByRole("button", { name: "Edit repricing policy" }).click();
      await page.getByLabel("Maximum changes per day").fill("249");
      await page.getByRole("button", { name: "Save policy", exact: true }).click();
      await expect(page.getByTestId("repricing-policy-editor")).toHaveCount(0);
      await expect(page.getByTestId("repricing-policy-settings")).toContainText("249");
      // The advanced tier adds a conditional rule without discarding the default.
      await page.getByRole("button", { name: "Edit repricing policy" }).click();
      await page.getByRole("button", { name: "Open advanced editor" }).click();
      await page.getByRole("button", { name: "Add rule before default" }).click();
      await choose(page, "Condition", "Listing age at least (days)");
      await page.getByLabel("Listing age at least (days)", { exact: true }).fill("45");
      await previewEditor(page);
      await page.getByRole("button", { name: "Save policy", exact: true }).click();
      await expect(page.getByTestId("repricing-policy-editor")).toHaveCount(0);
      await expect(page.getByTestId("repricing-policy-rules")).toContainText("Rule 2");
      const revisedResponse = await request.get(`${repricingApi}/${policyId}`);
      expect((await revisedResponse.json()).rules).toHaveLength(2);

      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      await expect(visibleText(page, "Paused")).toBeVisible();
      await expectPathname(page, `/account/desk/repricing/${policyId}`);
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await expect(visibleText(page, "Active")).toBeVisible();
      await expectPathname(page, `/account/desk/repricing/${policyId}`);

      // Halt: engage behind confirmation, see the banner and the policy paused
      // by the halt, then release behind confirmation.
      await page.getByRole("link", { name: "All repricing policies" }).click();
      await expectPathname(page, "/account/desk/repricing");
      await page.getByRole("switch", { name: "Halt all repricing" }).click();
      await page.getByRole("button", { name: "Halt repricing", exact: true }).click();
      await expect(page.getByTestId("repricing-halt")).toContainText("Repricing is halted");
      await expect(visibleText(page, "Paused by halt")).toBeVisible();

      // Attention: the engaged halt reaches the Seller Desk queue through the
      // pricing-repricing source and deep-links back to the policy list.
      await page.goto("/account/desk", { waitUntil: "domcontentloaded" });
      const haltItem = page
        .locator("[data-seller-desk-item]")
        .filter({ hasText: "Repricing is halted: no policy changes prices until you release the halt" });
      await expect(haltItem).toBeVisible();
      await haltItem.getByRole("link", { name: "Review repricing" }).click();
      await expectPathname(page, "/account/desk/repricing");

      await page.getByRole("switch", { name: "Halt all repricing" }).click();
      await page.getByRole("button", { name: "Release halt", exact: true }).click();
      await expect(page.getByTestId("repricing-halt")).not.toContainText("Repricing is halted");
      await expect(visibleText(page, "Active")).toBeVisible();

      // Delete behind confirmation from the detail page; it returns to the list.
      await page.getByRole("link", { name: policyName }).filter({ visible: true }).click();
      await expectPathname(page, `/account/desk/repricing/${policyId}`);
      await page.getByRole("button", { name: "Delete policy", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete policy", exact: true }).click();
      await expectPathname(page, "/account/desk/repricing");
      await expect(page.getByRole("heading", { name: "Repricing", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: policyName })).toHaveCount(0);
    } finally {
      if (policyId) {
        await deletePolicy(request, policyId);
      }
      if (baselineId) await deletePolicy(request, baselineId);
      await setHalt(request, false);
      if (policyId) {
        await expectListedPolicyIds(request, [policyId], false);
      }
      if (baselineId) await expectListedPolicyIds(request, [baselineId], false);
    }

    const remaining = await listPolicies(request);
    expect(remaining.filter((policy) => policy.status === "active")).toEqual([]);
  });
});
