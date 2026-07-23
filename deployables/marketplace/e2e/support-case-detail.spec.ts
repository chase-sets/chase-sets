import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { formatMoney } from "@chase-sets/localization";
import { signInWithPassword } from "./support/auth";
import {
  marketplaceBrowserE2eBuyerCredentials,
  marketplaceBrowserE2eSeedContract,
  marketplaceBrowserE2eSellerCredentials,
} from "./support/seed-contract";

const damagedItemAgreement = marketplaceBrowserE2eSeedContract.support.damagedItemAgreement;
const supportRequestId = damagedItemAgreement.supportRequestId;
const supportRequestPath = `/account/support/${supportRequestId}`;
const partialRefundDisplay = formatMoney(damagedItemAgreement.partialRefundAmount, damagedItemAgreement.currencyCode);
const projectionCatchUpTimeout = 60_000;
const journeyTestTimeout = 180_000;
const projectionRetryIntervals = [1_000, 2_000, 5_000];
const safeRequestMethods = new Set(["GET", "HEAD", "OPTIONS"]);

type JourneyActor = "buyer" | "seller";

type RouteActionTraceEntry = Readonly<{
  actor: JourneyActor;
  kind: "action" | "route";
  method: string;
  origin: string;
  path: string;
}>;

const routeActionTrace: RouteActionTraceEntry[] = [];

let marketplaceOrigin = "";
let sellerContext: BrowserContext | null = null;
let sellerPage: Page | null = null;
let buyerContext: BrowserContext | null = null;
let buyerPage: Page | null = null;
let sellerOfferSubmitted = false;
let buyerOfferAccepted = false;

function requirePage(page: Page | null, actor: JourneyActor) {
  if (!page) {
    throw new Error(`${actor} support-case page was not initialized.`);
  }
  return page;
}

function observeRouteActions(context: BrowserContext, actor: JourneyActor) {
  context.on("request", (request) => {
    const method = request.method();
    if (!request.isNavigationRequest() && safeRequestMethods.has(method)) {
      return;
    }

    const url = new URL(request.url());
    routeActionTrace.push({
      actor,
      kind: request.isNavigationRequest() ? "route" : "action",
      method,
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
    });
  });
}

async function waitForProjectedStatus(page: Page, status: string) {
  await expect(async () => {
    await page.goto(supportRequestPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(`Current status: ${status}`)).toBeVisible();
  }).toPass({ intervals: projectionRetryIntervals, timeout: projectionCatchUpTimeout });
}

async function waitForCaseNotification(page: Page, expectedText: string | RegExp) {
  await page.goto(supportRequestPath, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: supportRequestId })).toBeVisible();

  const notificationsButton = page.getByRole("button", { name: "Notifications", exact: true });
  await expect(async () => {
    await notificationsButton.click();
    await expect(page).toHaveURL(
      (url) =>
        url.origin === marketplaceOrigin &&
        url.pathname === supportRequestPath &&
        url.searchParams.get("notifications") === "feed",
      { timeout: 1_000 },
    );
  }).toPass({ timeout: 20_000 });

  const notificationCenter = page.getByRole("dialog", { name: "Notifications" });
  const caseNotification = notificationCenter
    .locator(`a[href="${supportRequestPath}"]`)
    .locator("xpath=ancestor::div[contains(@class, 'rounded-tokenMd')][1]")
    .filter({ hasText: expectedText });

  await expect(async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(notificationCenter).toBeVisible({ timeout: 5_000 });
    await expect(caseNotification.first()).toBeVisible({ timeout: 5_000 });
    await expect(caseNotification.first().getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      supportRequestPath,
    );
  }).toPass({ intervals: projectionRetryIntervals, timeout: projectionCatchUpTimeout });
}

async function selectSellerResponseAndWaitForSettlement(
  page: Page,
  responseType: "offer-replacement" | "offer-partial-refund",
) {
  const responseSelect = page.getByLabel("Response", { exact: true });
  const expectedOptions = [
    "accept-return",
    "offer-partial-refund",
    "offer-replacement",
    "issue-refund",
    "challenge-with-evidence",
  ];

  await expect(responseSelect.locator("option")).toHaveCount(expectedOptions.length);
  expect(
    await responseSelect
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.getAttribute("value"))),
  ).toEqual(expectedOptions);
  await responseSelect.selectOption(responseType);
  await expect(responseSelect).toHaveValue(responseType);
  await expect(page).toHaveURL((url) => url.origin === marketplaceOrigin && url.pathname === supportRequestPath);

  const partialRefundAmount = page.getByLabel("Partial refund amount");
  if (responseType === "offer-partial-refund") {
    await expect(partialRefundAmount).toBeVisible();
  } else {
    await expect(partialRefundAmount).toHaveCount(0);
  }

  await expect(responseSelect.locator(`option[value="${responseType}"]`)).toHaveCount(1);
}

test.describe("marketplace support case detail @marketplace-account @browser-e2e-seed", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    routeActionTrace.length = 0;
    sellerOfferSubmitted = false;
    buyerOfferAccepted = false;

    sellerContext = await browser.newContext();
    sellerPage = await sellerContext.newPage();
    await sellerPage.goto("/", { waitUntil: "domcontentloaded" });
    marketplaceOrigin = new URL(sellerPage.url()).origin;
    observeRouteActions(sellerContext, "seller");
    await signInWithPassword(sellerPage, marketplaceOrigin, marketplaceBrowserE2eSellerCredentials());

    buyerContext = await browser.newContext();
    buyerPage = await buyerContext.newPage();
    await buyerPage.goto(marketplaceOrigin, { waitUntil: "domcontentloaded" });
    observeRouteActions(buyerContext, "buyer");
    await signInWithPassword(buyerPage, marketplaceOrigin, marketplaceBrowserE2eBuyerCredentials());
  });

  test.afterAll(async () => {
    await buyerContext?.close();
    await sellerContext?.close();
  });

  test("notifies the seller and records a settled partial-refund offer", async () => {
    test.setTimeout(journeyTestTimeout);
    const page = requirePage(sellerPage, "seller");

    await waitForCaseNotification(page, /A buyer opened a support case\. Respond by .+ to keep it out of review\./);
    await waitForCaseNotification(
      page,
      "Your payout for this order is held while a support case is reviewed. Respond to the case to help resolve it sooner.",
    );

    await page.goto(supportRequestPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: supportRequestId })).toBeVisible();
    await expect(page.getByText("Product arrived damaged")).toBeVisible();
    const sellerStatus = await page.getByText(/^Current status:/).textContent();

    if (sellerStatus === "Current status: Waiting on seller") {
      await expect(page.getByText("You need to act")).toBeVisible();
      await selectSellerResponseAndWaitForSettlement(page, "offer-replacement");
      await selectSellerResponseAndWaitForSettlement(page, "offer-partial-refund");
      await page.getByLabel("Partial refund amount").fill(damagedItemAgreement.partialRefundAmount);
      await page.getByLabel("Response summary").fill("Keep the item and receive a partial refund.");
      await page.getByRole("button", { name: "Send response" }).click();
      await expect(page).toHaveURL(/action=response&afterWrite=|actionError=/);
      sellerOfferSubmitted = true;
    } else {
      expect(sellerStatus).toMatch(/^Current status: (Waiting on buyer|Resolved)$/);
    }

    if (sellerStatus !== "Current status: Resolved") {
      await waitForProjectedStatus(page, "Waiting on buyer");
    }
  });

  test("notifies the buyer and accepts the seller's partial-refund offer", async () => {
    test.setTimeout(journeyTestTimeout);
    const page = requirePage(buyerPage, "buyer");

    await waitForCaseNotification(page, "The seller offered you a partial refund. Review it and accept or decline.");

    const reviewOfferHeading = page.getByRole("heading", { name: "Review the offer" });
    await expect(async () => {
      await page.goto(supportRequestPath, { waitUntil: "domcontentloaded" });
      const canReviewOffer = await reviewOfferHeading.isVisible();
      const isResolved = await page.getByText("Current status: Resolved").isVisible();
      expect(canReviewOffer || isResolved).toBe(true);
    }).toPass({ intervals: projectionRetryIntervals, timeout: projectionCatchUpTimeout });

    if (await reviewOfferHeading.isVisible()) {
      await expect(page.getByText(partialRefundDisplay)).toBeVisible();
      await page.getByRole("button", { name: "Accept offer" }).click();
      await expect(page).toHaveURL(/action=offerAccepted&afterWrite=|actionError=/);
      buyerOfferAccepted = true;
    }

    await waitForProjectedStatus(page, "Resolved");
    await expect(page.getByText("Resolution", { exact: true })).toBeVisible();
    await expect(page.getByText("partial-refund", { exact: true })).toBeVisible();
    await expect(page.getByText(partialRefundDisplay, { exact: true })).toBeVisible();
    await expect(
      page.getByText("Decision made; refund processing details will appear here when available.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Offer accepted", { exact: true })).toBeVisible();
  });

  test("shows the buyer's terminal agreement notice", async () => {
    test.setTimeout(journeyTestTimeout);
    const page = requirePage(buyerPage, "buyer");

    await waitForCaseNotification(page, "Both parties agreed on partial refund. Nothing more is needed from you.");
  });

  test("shows the seller's terminal agreement and consumed-hold notices without admin-web action", async ({}, testInfo) => {
    test.setTimeout(journeyTestTimeout);
    const page = requirePage(sellerPage, "seller");

    await waitForCaseNotification(page, "Both parties agreed on partial refund. Nothing more is needed from you.");
    await waitForCaseNotification(
      page,
      "The case resolved with a partial refund, so the held funds were applied to the buyer's refund rather than paid out to you.",
    );
    await waitForProjectedStatus(page, "Resolved");
    await expect(page.getByRole("button", { name: "Send response" })).toHaveCount(0);

    const adminWebInteractions = routeActionTrace.filter(
      (entry) =>
        entry.origin !== marketplaceOrigin ||
        entry.path === "/support/requests" ||
        entry.path.startsWith("/support/requests/"),
    );
    expect(adminWebInteractions, "the self-service agreement journey must not open or mutate admin-web").toEqual([]);

    const supportRouteActions = routeActionTrace.filter(
      (entry) => entry.method === "POST" && entry.path.startsWith(supportRequestPath),
    );
    expect(supportRouteActions).toHaveLength(Number(sellerOfferSubmitted) + Number(buyerOfferAccepted));

    const traceEvidence = {
      adminWebInteractionCount: adminWebInteractions.length,
      supportRouteActionCount: supportRouteActions.length,
      supportRouteActions,
      routeActionTrace,
    };
    await testInfo.attach("support-case-route-action-trace", {
      body: JSON.stringify(traceEvidence, null, 2),
      contentType: "application/json",
    });
    console.log(
      `[support-case-route-action-trace] admin-web interactions=0; marketplace support actions=${supportRouteActions.length}; offer-submitted=${sellerOfferSubmitted}; buyer-acceptance=${buyerOfferAccepted}`,
    );
  });
});
