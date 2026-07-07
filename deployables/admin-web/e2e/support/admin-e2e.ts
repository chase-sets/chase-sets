import { expect, type APIResponse, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  decodeCommitReceipt,
  encodeFreshWriteReceipt,
  readFreshWriteToken,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";

const configuredAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const configuredAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const adminAccount = {
  email: configuredAdminEmail || "demo@chasesets.test",
  password: configuredAdminPassword || "demo1234",
};
const authApiTimeoutMs = 90_000;
const pageReadyTimeoutMs = 90_000;

export const skipDeployedAdminE2e =
  process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true" &&
  (configuredAdminEmail.length === 0 || configuredAdminPassword.length === 0);

export type ReadAfterWriteHeaderFactory = () => Record<string, string>;

export function createReadAfterWriteHeaderFactoryFromResponse(
  response: APIResponse | PlaywrightResponse,
  options: Readonly<{ targetContextName: string; label: string }>,
): ReadAfterWriteHeaderFactory {
  const sources = decodeCommitReceipt(responseHeader(response, CHASE_SETS_COMMIT_RECEIPT_HEADER));
  expect(sources.length, `${options.label} should include a commit receipt`).toBeGreaterThan(0);
  return createReadAfterWriteHeaderFactory(sources, options.targetContextName);
}

export function createReadAfterWriteHeaderFactoryFromUrl(
  url: string | URL,
  options: Readonly<{ targetContextName: string; label: string }>,
): ReadAfterWriteHeaderFactory {
  const receipt = readFreshWriteToken(url);
  expect(receipt, `${options.label} should include a fresh write token`).toBeTruthy();
  return createReadAfterWriteHeaderFactory(receipt!.sources, options.targetContextName);
}

export async function isProjectionFreshnessTimeoutResponse(response: APIResponse): Promise<boolean> {
  if (response.status() !== 503) {
    return false;
  }

  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  return body?.error?.code === "projection_freshness_timeout";
}

function createReadAfterWriteHeaderFactory(
  sources: readonly SourceCommitPosition[],
  targetContextName: string,
): ReadAfterWriteHeaderFactory {
  const stableSources = sources.map((source) => ({
    sourceContextName: source.sourceContextName,
    maxGlobalPosition: source.maxGlobalPosition,
    eventIds: [...source.eventIds],
  }));

  return () => ({
    [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: stableSources,
    }),
    [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: targetContextName,
  });
}

function responseHeader(response: APIResponse | PlaywrightResponse, headerName: string): string | null {
  const target = headerName.toLowerCase();
  for (const [name, value] of Object.entries(response.headers())) {
    if (name.toLowerCase() === target) {
      return value;
    }
  }

  return null;
}

export async function expectPageOk(page: Page, path: string) {
  const deadline = Date.now() + pageReadyTimeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (response && response.status() < 400) {
        return;
      }
      lastError = new Error(response ? `${path} returned HTTP ${response.status()}` : `${path} returned no response`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await page.waitForTimeout(1_000);
  }

  throw lastError ?? new Error(`${path} did not become ready`);
}

export async function authenticateAdmin(page: Page, returnToPath: string, signInPath = "/access/sign-in") {
  await expectPageOk(page, `${signInPath}?returnTo=${encodeURIComponent(returnToPath)}`);
  const origin = new URL(page.url()).origin;
  const deadline = Date.now() + authApiTimeoutMs;
  let response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: {
      email: adminAccount.email,
      password: adminAccount.password,
    },
  });

  while ([502, 503, 504].includes(response.status()) && Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
      data: {
        email: adminAccount.email,
        password: adminAccount.password,
      },
    });
  }

  expect(response.status(), "admin password sign-in should start a session").toBe(200);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "admin sign-in should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken!);
}

export async function expectVisibleText(page: Page, text: string) {
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible();
}

export async function expectAdminWebHydrated(page: Page) {
  const deadline = Date.now() + pageReadyTimeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    await recoverAdminError(page, { timeoutMs: 5_000 });
    try {
      await expect(page.locator("html")).toHaveAttribute("data-admin-web-hydrated", "true", { timeout: 10_000 });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  }

  throw lastError ?? new Error("Admin web did not hydrate.");
}

export async function recoverAdminError(page: Page, options: { timeoutMs?: number } = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? pageReadyTimeoutMs);
  let recovered = false;

  while (Date.now() < deadline) {
    const retryableAdminErrorVisible =
      (await page
        .getByRole("heading", { name: "Admin Error" })
        .isVisible({ timeout: 1_000 })
        .catch(() => false)) ||
      (await page
        .getByRole("heading", { name: "Admin page not found" })
        .isVisible({ timeout: 1_000 })
        .catch(() => false));
    if (!retryableAdminErrorVisible) {
      return recovered;
    }

    recovered = true;
    const retry = page.getByRole("link", { name: "Retry" }).first();
    if (await retry.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await retry.click();
    } else {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }

  return recovered;
}

export async function expectAdminPageReady(
  page: Page,
  expected: { heading: string | RegExp; headingLevel?: 1 | 2 | 3 | 4 | 5 | 6 },
  options: { timeoutMs?: number } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? pageReadyTimeoutMs);
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    await recoverAdminError(page, { timeoutMs: 5_000 });

    try {
      await expectAdminWebHydrated(page);
      const heading =
        typeof expected.heading === "string"
          ? page.getByRole("heading", { name: expected.heading, exact: true, level: expected.headingLevel })
          : page.getByRole("heading", { name: expected.heading, level: expected.headingLevel });
      await expect(heading).toBeVisible({
        timeout: 5_000,
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await page.waitForTimeout(1_000);
    }
  }

  throw lastError ?? new Error("Admin page did not become ready.");
}

async function addSessionCookie(page: Page, origin: string, sessionToken: string) {
  await page.context().addCookies([
    {
      name: "chase_sets_session",
      value: sessionToken,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
  ]);

  const sessionCookie = (await page.context().cookies(origin)).find((cookie) => cookie.name === "chase_sets_session");
  expect(sessionCookie, "browser context should store the auth session cookie").toBeTruthy();
}
