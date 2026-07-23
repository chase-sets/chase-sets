import {
  expect,
  type APIResponse,
  type Locator,
  type Page,
  type Response as PlaywrightResponse,
} from "@playwright/test";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  decodeCommitReceipt,
  encodeFreshWriteReceipt,
  readFreshWriteToken,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";

export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
export const TABLET_VIEWPORT = { width: 820, height: 1180 } as const;
export const DESKTOP_VIEWPORT = { width: 1280, height: 900 } as const;
// The design system's "md" breakpoint (packages/design-system/src/theme/tokens.ts)
// is the table<->card collapse boundary DataTable uses (`hidden md:block` /
// `md:hidden`), so the mobile/tablet fixtures above straddle it deliberately:
// mobile is well below 768px (cards), tablet is comfortably above it (table).
const MIN_TOUCH_TARGET_PX = 44;

export async function expectMinimumTouchTarget(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} should have a measurable layout box`).not.toBeNull();
  expect(box!.width, `${label} width should be >= ${MIN_TOUCH_TARGET_PX}px`).toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET_PX,
  );
  expect(box!.height, `${label} height should be >= ${MIN_TOUCH_TARGET_PX}px`).toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET_PX,
  );
}

// DataTable (packages/design-system/src/components/data-display/data-table.tsx)
// renders its `<table>` and its `role="list"` mobile-card collapse as siblings
// under one wrapping div that always carries `aria-busy` (set unconditionally,
// even when false). Below the "md" breakpoint the table branch is CSS-hidden
// (`hidden md:block`), which removes it (and its `sr-only` `<caption>`, see
// table-shell.tsx) from the accessibility tree entirely — so a
// `getByRole("table", { name })` locator matches nothing at mobile width, and
// any `.filter({ has: <that locator> })` built from it silently comes up
// empty even though the mobile card list is right there in the DOM. Locate
// the table by plain CSS (`table` + a `<caption>` text match), which reads
// the DOM structure directly and is unaffected by `display: none`, so this
// resolves the same wrapper whether the table branch is visible or hidden.
// This scopes the card locator to THIS table's own cards — never a
// generic/unscoped `listitem` query that could match an unrelated list
// elsewhere on the page.
export function dataTableRoot(page: Page, name?: string): Locator {
  const table = name
    ? page.locator("table", { has: page.locator("caption", { hasText: name }) })
    : page.locator("table");
  return page.locator("div[aria-busy]").filter({ has: table });
}

const configuredAdminEmail = process.env.CATALOG_ADMIN_E2E_EMAIL?.trim() ?? "";
const configuredAdminPassword = process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim() ?? "";
const adminAccount = {
  email: configuredAdminEmail || "demo@chasesets.test",
  password: configuredAdminPassword || "demo1234",
};
const platformAdminAccount = {
  email: configuredAdminEmail || "browser-e2e-platform-admin@chasesets.test",
  password: configuredAdminPassword || "browser-e2e-platform-admin-password",
};
const authApiTimeoutMs = 90_000;
const pageReadyTimeoutMs = 90_000;

export const skipDeployedAdminE2e =
  process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true" &&
  (configuredAdminEmail.length === 0 || configuredAdminPassword.length === 0);

type ProjectionPositionOptions = Readonly<{
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  label: string;
  timeoutMs?: number;
  allowLegacyCommitPositionFallback?: boolean;
}>;

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

export async function waitForProjectionPositionFromResponse(
  page: Page,
  response: APIResponse | PlaywrightResponse,
  options: ProjectionPositionOptions,
) {
  await waitForProjectionPositionFromSources(
    page,
    decodeCommitReceipt(responseHeader(response, CHASE_SETS_COMMIT_RECEIPT_HEADER)),
    options,
  );
}

export async function waitForProjectionPositionFromUrl(
  page: Page,
  url: string | URL,
  options: ProjectionPositionOptions,
) {
  const receipt = readFreshWriteToken(url);
  expect(receipt, `${options.label} should include a fresh write token`).toBeTruthy();
  const hasExpectedSource = receipt!.sources.some((source) => source.sourceContextName === options.sourceContextName);
  const sources =
    hasExpectedSource || !options.allowLegacyCommitPositionFallback || !receipt!.commitPosition
      ? receipt!.sources
      : [
          ...receipt!.sources,
          {
            sourceContextName: options.sourceContextName,
            maxGlobalPosition: receipt!.commitPosition,
            eventIds: [],
          },
        ];
  await waitForProjectionPositionFromSources(page, sources, options);
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

async function waitForProjectionPositionFromSources(
  page: Page,
  sources: readonly SourceCommitPosition[],
  options: ProjectionPositionOptions,
) {
  const source = sources.find((candidate) => candidate.sourceContextName === options.sourceContextName);
  expect(source, `${options.label} should include a ${options.sourceContextName} commit receipt`).toBeTruthy();

  await expect
    .poll(
      async () => {
        const observation = await refreshProjectionPosition(page, options);
        if (!observation.ok) {
          return observation.state;
        }

        return BigInt(observation.position) >= BigInt(source!.maxGlobalPosition)
          ? "caught-up"
          : `behind:${observation.position}/${source!.maxGlobalPosition}`;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: options.timeoutMs ?? 90_000 },
    )
    .toBe("caught-up");
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

type ProjectionStatusResponse = Readonly<{
  projectionGroups?: readonly ProjectionGroupStatus[];
}>;

type ProjectionGroupStatus = Readonly<{
  targetContextName?: string;
  projectionName?: string;
  subscriptions?: readonly ProjectionSubscriptionStatus[];
}>;

type ProjectionSubscriptionStatus = Readonly<{
  sourceContextName?: string;
  lastGlobalPosition?: string;
}>;

type ProjectionPositionObservation = Readonly<{ ok: true; position: string }> | Readonly<{ ok: false; state: string }>;

async function refreshProjectionPosition(page: Page, options: ProjectionPositionOptions) {
  const origin = requestOrigin(page);
  const refreshResponse = await page.request.post(`${origin}/api/platform/projections/refresh`);
  if (refreshResponse.status() === 200) {
    return projectionPositionFromResponse(refreshResponse, options);
  }

  const statusResponse = await page.request.get(`${origin}/api/platform/projections`);
  if (statusResponse.status() === 200) {
    return projectionPositionFromResponse(statusResponse, options);
  }

  return {
    ok: false,
    state: `refresh-failed:${refreshResponse.status()};status-failed:${statusResponse.status()}`,
  } satisfies ProjectionPositionObservation;
}

async function projectionPositionFromResponse(
  response: APIResponse,
  options: ProjectionPositionOptions,
): Promise<ProjectionPositionObservation> {
  const body = (await response.json()) as ProjectionStatusResponse;
  const group = body.projectionGroups?.find(
    (candidate) =>
      candidate.targetContextName === options.targetContextName && candidate.projectionName === options.projectionName,
  );

  return {
    ok: true,
    position: maxObservedProjectionPosition(group, options.sourceContextName),
  };
}

function maxObservedProjectionPosition(group: ProjectionGroupStatus | undefined, sourceContextName: string) {
  const positions =
    group?.subscriptions
      ?.filter((subscription) => subscription.sourceContextName === sourceContextName)
      .map((subscription) => subscription.lastGlobalPosition)
      .filter((position): position is string => typeof position === "string" && /^(0|[1-9]\d*)$/.test(position)) ?? [];

  return positions.reduce((max, position) => (BigInt(position) > BigInt(max) ? position : max), "0");
}

function requestOrigin(page: Page) {
  return new URL(page.url()).origin;
}

export async function expectPageOk(page: Page, path: string) {
  let lastError: Error | null = null;

  try {
    await expect
      .poll(
        async () => {
          let response: PlaywrightResponse | null = null;
          try {
            response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 15_000 });
            if (response && response.status() < 400) {
              return "ready";
            }
            lastError = new Error(
              response ? `${path} returned HTTP ${response.status()}` : `${path} returned no response`,
            );
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
          return "not-ready";
        },
        { intervals: [1_000, 2_000, 5_000], timeout: pageReadyTimeoutMs },
      )
      .toBe("ready");
  } catch (error) {
    throw lastError ?? error;
  }
}

export async function authenticateAdmin(page: Page, returnToPath: string, signInPath = "/access/sign-in") {
  await authenticateAdminAccount(page, returnToPath, signInPath, adminAccount);
}

export async function authenticatePlatformAdmin(page: Page, returnToPath: string, signInPath = "/access/sign-in") {
  await authenticateAdminAccount(page, returnToPath, signInPath, platformAdminAccount);
}

async function authenticateAdminAccount(
  page: Page,
  returnToPath: string,
  signInPath: string,
  account: Readonly<{ email: string; password: string }>,
) {
  await expectPageOk(page, `${signInPath}?returnTo=${encodeURIComponent(returnToPath)}`);
  const origin = new URL(page.url()).origin;
  let response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: {
      email: account.email,
      password: account.password,
    },
  });

  if ([502, 503, 504].includes(response.status())) {
    await expect
      .poll(
        async () => {
          response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
            data: {
              email: account.email,
              password: account.password,
            },
          });
          return [502, 503, 504].includes(response.status()) ? "retry" : response.status();
        },
        { intervals: [1_000, 2_000, 5_000], timeout: authApiTimeoutMs },
      )
      .toBe(200);
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

  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
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
    await expect
      .poll(
        async () =>
          !(await page
            .getByRole("heading", { name: /Admin Error|Admin page not found/ })
            .isVisible({ timeout: 500 })
            .catch(() => false)),
        { intervals: [100, 250, 500], timeout: Math.max(500, Math.min(5_000, deadline - Date.now())) },
      )
      .toBe(true)
      .catch(() => undefined);
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
      await expect(heading).toBeVisible({ timeout: 5_000 });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
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
