import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import {
  channelConnectionBrowserState,
  mountChannelConnectionBrowserState,
  type ConnectionEvidenceState,
  type ConnectionEvidenceSurface,
} from "@chase-sets/channels/seed-support/channel-connection-browser";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

// Reuses the existing Channels route-state matrix in the hydrated production app.
// Synthetic state evidence is separate from the untouched real AC1/AC5 journey.
test.beforeEach(async ({ page, baseURL }) => {
  await signInWithPassword(page, baseURL!, marketplaceBrowserE2eSellerCredentials());
  await page.goto("/account/channels");
  await page.getByRole("link", { name: "View connection", exact: true }).first().click();
  await page.waitForFunction(() => {
    const router = (
      window as unknown as {
        __reactRouterDataRouter?: { state: { initialized: boolean; loaderData: Record<string, { kind?: string }> } };
      }
    ).__reactRouterDataRouter;
    return (
      router?.state.initialized && router.state.loaderData["channels/account-channels-connection"]?.kind === "ready"
    );
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { channelConnectionEvidence?: { dispose: () => void } }).channelConnectionEvidence?.dispose();
  });
});

async function showState(page: Page, surface: ConnectionEvidenceSurface, state: ConnectionEvidenceState) {
  await page.evaluate(mountChannelConnectionBrowserState, channelConnectionBrowserState(surface, state));
  if (surface === "list") {
    const marker =
      state === "loading"
        ? "Loading channel connections…"
        : state === "empty"
          ? "No channel connections"
          : state === "error"
            ? "Channels API error 503"
            : "fixture-provider";
    await expect(page.getByText(marker, { exact: true })).toBeVisible();
    return;
  }
  if (surface === "connect") {
    const connect = page.locator('form:has(select[name="providerKey"]) button[type="submit"]');
    if (state === "empty") {
      await expect(page.getByText("No channel connections", { exact: true })).toBeVisible();
      await expect(connect).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "Sales Channel", exact: true })).toHaveCount(0);
      return;
    }
    await connect.click();
    if (state === "loading") {
      await expect(connect).toBeDisabled();
      await expect(connect).toHaveAttribute("aria-busy", "true");
    } else if (state === "error") {
      await expect(page.getByText("provider-setup-not-registered", { exact: true })).toBeVisible();
      await expect(connect).toBeEnabled();
    } else {
      await expect(page).toHaveURL(/\/account\/channels\/connection-pending-setup$/);
      await expect(page.getByText("Pending setup", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Connection setup", exact: true })).toBeVisible();
    }
    return;
  }
  const activate = page.locator('form:has(input[name="intent"][value="activate"]) button[type="submit"]');
  if (state === "empty") {
    await expect(page.getByRole("link", { name: "Storage locations", exact: true })).toBeVisible();
    await expect(activate).toHaveCount(0);
    return;
  }
  const checkbox = page.getByRole("checkbox", { name: "Shelf one", exact: true });
  await expect(activate).toBeDisabled();
  await page.getByText("Shelf one", { exact: true }).click();
  await expect(activate).toBeEnabled();
  await activate.click();
  if (state === "loading") {
    await expect(activate).toBeDisabled();
    await expect(activate).toHaveAttribute("aria-busy", "true");
    await expect(checkbox).toBeDisabled();
  } else if (state === "error") {
    await expect(page.getByText("binding-not-current", { exact: true })).toBeVisible();
    await expect(checkbox).toBeChecked();
    await expect(activate).toBeEnabled();
  } else {
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
    await expect(activate).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Connection setup", exact: true })).toHaveCount(0);
  }
}

test("channels-connect-design-system-list-loading @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "list", "loading");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-list-loading-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-list-loading-desktop" });
});

test("channels-connect-design-system-list-empty @marketplace-account @browser-e2e-seed", async ({ page }, testInfo) => {
  await showState(page, "list", "empty");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-list-empty-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-list-empty-desktop" });
});

test("channels-connect-design-system-list-error @marketplace-account @browser-e2e-seed", async ({ page }, testInfo) => {
  await showState(page, "list", "error");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-list-error-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-list-error-desktop" });
});

test("channels-connect-design-system-list-success @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "list", "success");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-list-success-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-list-success-desktop" });
});

test("channels-connect-design-system-connect-loading @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "connect", "loading");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-connect-loading-390" });
  await captureResponsiveEvidence({
    page,
    testInfo,
    claimId: "channels-connect-design-system-connect-loading-desktop",
  });
});

test("channels-connect-design-system-connect-empty @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "connect", "empty");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-connect-empty-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-connect-empty-desktop" });
});

test("channels-connect-design-system-connect-error @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "connect", "error");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-connect-error-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-connect-error-desktop" });
});

test("channels-connect-design-system-connect-success @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "connect", "success");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-connect-success-390" });
  await captureResponsiveEvidence({
    page,
    testInfo,
    claimId: "channels-connect-design-system-connect-success-desktop",
  });
});

test("channels-connect-design-system-setup-loading @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "setup", "loading");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-setup-loading-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-setup-loading-desktop" });
});

test("channels-connect-design-system-setup-empty @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "setup", "empty");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-setup-empty-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-setup-empty-desktop" });
});

test("channels-connect-design-system-setup-error @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "setup", "error");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-setup-error-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-setup-error-desktop" });
});

test("channels-connect-design-system-setup-success @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "setup", "success");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-setup-success-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-setup-success-desktop" });
});

test("channels-connect-design-system-activate-loading @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "activate", "loading");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-activate-loading-390" });
  await captureResponsiveEvidence({
    page,
    testInfo,
    claimId: "channels-connect-design-system-activate-loading-desktop",
  });
});

test("channels-connect-design-system-activate-empty @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "activate", "empty");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-activate-empty-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-activate-empty-desktop" });
});

test("channels-connect-design-system-activate-error @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "activate", "error");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-activate-error-390" });
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-activate-error-desktop" });
});

test("channels-connect-design-system-activate-success @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await showState(page, "activate", "success");
  await captureResponsiveEvidence({ page, testInfo, claimId: "channels-connect-design-system-activate-success-390" });
  await captureResponsiveEvidence({
    page,
    testInfo,
    claimId: "channels-connect-design-system-activate-success-desktop",
  });
});
