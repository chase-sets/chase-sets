import { expect, test, type APIRequestContext, type Frame, type Page } from "@playwright/test";
import { addSessionCookie } from "./support/auth";
import { assertStripeEmbedUatTarget } from "./support/stripe-embed-uat-gates";

const embedTimeout = 60_000;
const captureTimeout = 180_000;
const requestOptions = { maxRedirects: 0, timeout: 15_000 };

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Stripe embed UAT requires ${name}.`);
  return value;
}

// Browser and provider errors can include buyer or payment data. Keep the
// failing leg and what to inspect, not the original error or response body.
async function leg<T>(failure: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new Error(failure);
  }
}

async function readJson<T>(request: APIRequestContext, url: URL): Promise<T> {
  const response = await request.get(url.href, requestOptions);
  try {
    if (!response.ok()) throw new Error("Expected a successful marketplace read.");
    return (await response.json()) as T;
  } finally {
    await response.dispose();
  }
}

async function cardFrame(page: Page): Promise<Frame> {
  const frames = page.locator('[data-payment-entry] iframe[title="Secure payment input frame"]');
  let card: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const iframe of await frames.elementHandles()) {
          const frame = await iframe.contentFrame();
          if (!frame || new URL(frame.url()).hostname !== "js.stripe.com") continue;
          if (await frame.locator('input[name="number"]').isVisible()) {
            card = frame;
            return true;
          }
          const option = frame
            .locator('button, [role="button"], [role="radio"], [role="tab"]')
            .filter({ hasText: /^Card$/ })
            .first();
          if (await option.isVisible()) await option.click({ timeout: 2_000 }).catch(() => {});
        }
        return false;
      },
      { timeout: embedTimeout },
    )
    .toBe(true);
  if (!card) throw new Error("Stripe did not expose the card fields.");
  return card;
}

test.skip(process.env.STRIPE_EMBED_UAT !== "true", "Set STRIPE_EMBED_UAT=true for the manual staging run.");

test("confirms the embedded test card and waits for capture @stripe-embed-uat", async ({ browser }, testInfo) => {
  test.setTimeout(360_000);
  const publishableKey = requiredEnv("STRIPE_PUBLISHABLE_KEY").trim();
  const origin = assertStripeEmbedUatTarget(requiredEnv("MARKETPLACE_WEB_URL").trim(), publishableKey);
  const email = requiredEnv("MARKETPLACE_E2E_EMAIL").trim();
  const password = requiredEnv("MARKETPLACE_E2E_PASSWORD");
  const orderId = requiredEnv("STRIPE_EMBED_UAT_ORDER_ID").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(orderId)) throw new Error("STRIPE_EMBED_UAT_ORDER_ID must name one pending order.");
  if (testInfo.project.name !== "stripe-embed-uat") {
    throw new Error("Use playwright.stripe-embed-uat.config.ts for the manual Stripe embed UAT.");
  }
  const url = (path: string) => new URL(path, origin);
  // Own the context so it is closed before failure reporting, without a
  // retained browser trace, screenshot, video, or automatic retry.
  const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
  try {
    await leg(
      "Stripe embed UAT preflight failed: staging must report a Stripe payment processor in test mode.",
      async () => {
        const mode = await readJson<{ mode: string; deploymentEnvironment: string; paymentProcessorKind: string }>(
          context.request,
          url("/api/marketplace/payment-provider-mode"),
        );
        expect(
          mode.mode === "test" && mode.deploymentEnvironment === "staging" && mode.paymentProcessorKind === "stripe",
        ).toBe(true);
      },
    );

    const page = await context.newPage();
    await leg("Stripe embed UAT sign-in failed: check the staging buyer credentials and session.", async () => {
      const response = await page.request.post(url("/api/auth/password-sign-in").href, {
        ...requestOptions,
        data: { email, password },
      });
      try {
        expect(response.status()).toBe(200);
        const { sessionToken } = (await response.json()) as { sessionToken?: string };
        if (!sessionToken) throw new Error("No buyer session.");
        await addSessionCookie(page, origin, sessionToken);
      } finally {
        await response.dispose();
      }
    });

    const { paymentPath, paymentRead } = await leg(
      "Stripe embed UAT payment creation failed: use a fresh pending-payment single for this buyer and check Start payment.",
      async () => {
        const order = await readJson<{ status: string; lines: { quantity: number }[] }>(
          page.request,
          url(`/api/marketplace/account/purchases/${encodeURIComponent(orderId)}`),
        );
        expect(order.status === "pending-payment" && order.lines.length === 1 && order.lines[0]?.quantity === 1).toBe(
          true,
        );

        const start = url("/account/payments/new");
        start.searchParams.set("orderIds", orderId);
        const response = await page.goto(start.href, { waitUntil: "domcontentloaded" });
        expect(response?.ok() && new URL(page.url()).origin === origin).toBe(true);
        const main = page.getByRole("main");
        await main.getByLabel(/^Payment method\b/).selectOption("card");
        await main.getByLabel(/^Wallet balance\b/).selectOption("none");
        const [payment] = await Promise.all([
          page
            .waitForURL(
              (current) => current.origin === origin && /^\/account\/payments\/(?!new$)[^/]+$/.test(current.pathname),
              { timeout: 30_000 },
            )
            .then(() => new URL(page.url())),
          main.getByRole("button", { name: "Continue to payment", exact: true }).click(),
        ]);
        const paymentRead = url(`/api/marketplace${payment.pathname}`);
        await expect
          .poll(
            async () => {
              const response = await page.request.get(paymentRead.href, requestOptions);
              try {
                return response.status();
              } finally {
                await response.dispose();
              }
            },
            { timeout: 30_000 },
          )
          .toBe(200);
        return { paymentPath: payment.pathname, paymentRead };
      },
    );

    await leg("Stripe embed UAT mount failed: check the deployed test key and the secure card iframe.", async () => {
      const payment = await readJson<{ status: string; processor_publishable_key?: string }>(page.request, paymentRead);
      expect(payment.status === "pending-confirmation" && payment.processor_publishable_key === publishableKey).toBe(
        true,
      );
      const card = await cardFrame(page);
      await card.locator('input[name="number"]').fill("4242 4242 4242 4242");
      const expiry = new Date().getUTCFullYear() + 2;
      await card.locator('input[name="expiry"]').fill(`12${String(expiry).slice(-2)}`);
      await card.locator('input[name="cvc"]').fill("123");
      const postalCode = card.locator('input[name="postalCode"]');
      if (await postalCode.isVisible()) await postalCode.fill("10001");
      const linkOptIn = card.locator('input[name="linkOptIn"]');
      if ((await linkOptIn.count()) && (await linkOptIn.isChecked())) {
        await card.locator('label[for="payment-linkOptInInput"]').click();
        await expect(linkOptIn).not.toBeChecked();
      }
    });

    await leg(
      "Stripe embed UAT confirm failed: the pilot did not enter processing after confirming the test card.",
      async () => {
        const entry = page.locator("[data-payment-entry]");
        const confirm = entry.getByRole("button", { name: "Confirm payment", exact: true });
        await expect(confirm).toBeEnabled();
        await confirm.click();
        // Stripe success starts the pilot's processing UI. An immediate webhook
        // can already replace it with the captured view of this same payment.
        await expect(
          entry
            .getByText("The payment is being updated by the secure processor.", { exact: true })
            .or(page.locator('[data-payment][data-status="captured"]')),
        ).toBeVisible({ timeout: embedTimeout });
        expect(new URL(page.url()).pathname === paymentPath).toBe(true);
      },
    );

    await leg(
      "Stripe embed UAT capture failed: Payments did not report captured; check Stripe webhook delivery and ingestion.",
      async () => {
        await expect
          .poll(
            async () => {
              const current = await readJson<{ status: string }>(page.request, paymentRead).catch(() => null);
              return current?.status === "captured";
            },
            { intervals: [2_000, 5_000, 10_000], timeout: captureTimeout },
          )
          .toBe(true);
      },
    );
  } finally {
    await context.close();
  }
});
