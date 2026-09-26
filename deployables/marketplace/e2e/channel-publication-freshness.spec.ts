import { expect, test } from "@playwright/test";
import { createChannelPublicationBrowserSupport } from "@chase-sets/channels/seed-support/channel-publication-browser";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

test("mapping decision retains the typed target through a held projection @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  const channelsDatabaseUrl = (testInfo.config.metadata as { channelsDatabaseUrl?: string }).channelsDatabaseUrl;
  const support = await createChannelPublicationBrowserSupport({ channelsDatabaseUrl });
  const routePath = `/account/channels/publication/${support.connectionId}`;
  const submittedTarget = `${support.candidate.targetKey}-submitted`;
  const posts: string[] = [];
  const isDecisionPost = (url: string, method: string) =>
    method === "POST" && new URL(url).pathname.replace(/\.data$/u, "") === routePath;
  page.on("request", (request) => {
    if (isDecisionPost(request.url(), request.method())) posts.push(request.postData() ?? "");
  });
  try {
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(routePath)}`, { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
    await expect(page).toHaveURL(new RegExp(`${routePath.replaceAll("/", "\\/")}(?:\\?|$)`));
    const candidate = page.getByText(support.candidate.sourceKey, { exact: true });
    await expect(candidate).toBeVisible();
    const card = candidate.locator("xpath=ancestor::*[@data-elevation-role='entity'][1]");
    const target = card.getByRole("textbox", { name: "Channel target key" });
    await target.fill(submittedTarget);
    const reject = card.getByRole("button", { name: "Reject" });
    const [response] = await Promise.all([
      page.waitForResponse((response) => isDecisionPost(response.url(), response.request().method())),
      reject.click(),
    ]);
    expect(response.status()).toBe(200);
    expect(posts).toHaveLength(1);
    expect(new URLSearchParams(posts[0]).get("targetKey")).toBe(submittedTarget);
    await expect(page.getByText("Loading channel publication settings")).toBeVisible();
    await expect(target).toHaveValue(submittedTarget);
    await expect(card.getByText(/category · proposed · high/u)).toBeVisible();
    await expect(reject).toBeDisabled();
    await reject.evaluate((button: HTMLButtonElement) => button.click());
    expect(posts).toHaveLength(1);
    await support.release();
    await expect(page.getByText("Loading channel publication settings")).toHaveCount(0);
    await expect(card.getByText(/category · rejected · high/u)).toBeVisible();
    await expect(target).toHaveValue("");
    await expect(reject).toBeEnabled();
    await page.reload();
    await expect(target).toHaveValue("");
  } finally {
    await support.cleanup();
  }
});
