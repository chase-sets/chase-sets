import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

// Charter scope (#7914): the seeded seller manages a repricing policy from the
// Seller Desk -- list, detail, pause/resume, halt engage/release and delete --
// through the real marketplace routes and pricing API. Policy creation belongs
// to the editor (#7915), so setup creates the policy through the API from a
// completed dry run, exactly as the editor will.
//
// Seed safety: the policy governs one seeded listing, caps every move at 10%
// and holds any move within a tolerance far above that cap, so it can never
// change a price other specs assert. Teardown deletes it and releases the halt
// in `finally`, and the spec asserts the seller ends with zero active policies.
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
}

// Removes policies this spec created on an earlier interrupted run and releases
// a halt it may have left engaged, so every run starts from the same state.
async function resetSpecState(request: APIRequestContext) {
  for (const policy of await listPolicies(request)) {
    if (policy.status !== "deleted" && policy.name?.startsWith(specPolicyPrefix)) {
      const response = await request.post(`${repricingApi}/${policy.policyId}/delete`);
      expect(response.status(), `delete stale spec policy ${policy.policyId}`).toBe(200);
    }
  }
  await setHalt(request, false);
}

async function createHoldOnlyPolicy(request: APIRequestContext, name: string): Promise<string> {
  const dryRunResponse = await request.post(`${repricingApi}/dry-runs`, { data: holdOnlyBody });
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

    try {
      policyId = await createHoldOnlyPolicy(request, policyName);

      // List: the policy row with status, scope kind and budget row.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/account/desk/repricing", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Repricing", exact: true })).toBeVisible();
      const policyLink = page.getByRole("link", { name: policyName }).filter({ visible: true });
      await expect(policyLink).toBeVisible();
      await expect(visibleText(page, "Active")).toBeVisible();
      await expect(visibleText(page, "Selected listings (1)")).toBeVisible();
      await expect(page.getByText(/account-wide changes today/).filter({ visible: true }).first()).toBeVisible();

      await captureResponsiveEvidence({ page, testInfo, claimId: "repricing-policy-cards-mobile" });
      await page.setViewportSize({ width: 1280, height: 900 });

      // Detail: read-only body, then pause and resume in place.
      await policyLink.click();
      await expect(page).toHaveURL(new RegExp(`/account/desk/repricing/${policyId}$`));
      await expect(page.getByRole("heading", { name: policyName })).toBeVisible();
      await expect(page.getByTestId("repricing-policy-rules")).toContainText("Rule 1");
      await expect(page.getByTestId("repricing-activity-counts")).toBeVisible();

      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      await expect(visibleText(page, "Paused")).toBeVisible();
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await expect(visibleText(page, "Active")).toBeVisible();

      // Halt: engage behind confirmation, see the banner and the policy paused
      // by the halt, then release behind confirmation.
      await page.getByRole("link", { name: "All repricing policies" }).click();
      await expect(page).toHaveURL(/\/account\/desk\/repricing$/);
      await page.getByRole("switch", { name: "Halt all repricing" }).click();
      await page.getByRole("button", { name: "Halt repricing", exact: true }).click();
      await expect(page.getByTestId("repricing-halt")).toContainText("Repricing is halted");
      await expect(visibleText(page, "Paused by halt")).toBeVisible();

      await page.getByRole("switch", { name: "Halt all repricing" }).click();
      await page.getByRole("button", { name: "Release halt", exact: true }).click();
      await expect(page.getByTestId("repricing-halt")).not.toContainText("Repricing is halted");
      await expect(visibleText(page, "Active")).toBeVisible();

      // Delete behind confirmation from the detail page; it returns to the list.
      await page.getByRole("link", { name: policyName }).filter({ visible: true }).click();
      await expect(page).toHaveURL(new RegExp(`/account/desk/repricing/${policyId}$`));
      await page.getByRole("button", { name: "Delete policy", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete policy", exact: true }).click();
      await expect(page).toHaveURL(/\/account\/desk\/repricing$/);
      await expect(page.getByRole("link", { name: policyName })).toHaveCount(0);
    } finally {
      if (policyId) {
        const current = (await listPolicies(request)).find((policy) => policy.policyId === policyId);
        if (current && current.status !== "deleted") {
          await request.post(`${repricingApi}/${policyId}/delete`);
        }
      }
      await setHalt(request, false);
    }

    const remaining = await listPolicies(request);
    expect(remaining.filter((policy) => policy.status === "active")).toEqual([]);
  });
});
