import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type APIRequestContext, type FrameLocator, type Page, type TestInfo } from "@playwright/test";
import { signInWithPassword } from "./support/auth";

// Manual staging UAT (issue #3974): the confirmation-card defect cluster left
// one seam entirely untested -- nothing mounted the real Stripe embed,
// confirmed with a card, and asserted the webhook-driven capture landed.
// account-payment.spec.ts deliberately stops at the auth/404 composition
// seams and defers capture/fee-math domain logic to the vitest suites; this
// spec is the browser-level closure of that gap, proving the
// @stripe/stripe-js typed loader against Stripe's real test-mode embed.
//
// Precondition: a pending-payment order created through the normal
// controlled checkout path in Stripe test mode (same precondition contract
// as SMOKE_ORDER_IDS in scripts/stripe-money-smoke-test.mjs; see
// docs/runbooks/money-operations.md "Stripe Money Smoke Test"). This spec
// creates the payment itself from that order via the same API the product
// checkout flow uses, then drives confirmation entirely through the browser
// so the typed loader, the mount, and the Payment Element are exercised for
// real -- not stubbed.
//
// Gate: set STRIPE_EMBED_UAT=true to run. Wired into the money-smoke family,
// not PR CI -- see scripts/e2e-suites.mjs e2eNoSuiteExclusions and the
// "Stripe Embed Confirmation UAT" section of docs/runbooks/money-operations.md.

const runStripeEmbedUat = process.env.STRIPE_EMBED_UAT === "true";
const orderIds = (process.env.STRIPE_EMBED_UAT_ORDER_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const buyerEmail = process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "";
const buyerPassword = process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "";
const paymentMethodCategory = process.env.STRIPE_EMBED_UAT_PAYMENT_METHOD_CATEGORY?.trim() || "card";
const balanceCreditAmount = process.env.STRIPE_EMBED_UAT_BALANCE_CREDIT_AMOUNT?.trim() || "0.00";
const embedReadyTimeoutMs = 60_000;
const captureTimeoutMs = 180_000;

// Stripe's official Payment Element testing guidance: the combined card
// sub-fields render inside one iframe titled "Secure payment input frame"
// with `name`-addressable inputs. https://docs.stripe.com/testing plus
// Stripe's Playwright/Cypress Elements testing docs.
const stripeTestCard = {
  number: "4242424242424242",
  expiry: "12/34",
  cvc: "123",
  postalCode: "94103",
};

// ---------------------------------------------------------------------------
// Stripe Elements appearance acceptance probe.
//
// The shipped factories resolve every appearance input from the live document
// at mount and update time, so whatever the probed document resolves is what
// Stripe receives. That is what makes a candidate palette provable before any
// token value ships: an unlayered stylesheet registered as a document-start
// init script redefines the custom properties in the probe browser session
// only, and the first createStripeElementsAppearance resolution inside the
// mount effect already reads candidate values. Nothing in the product diff
// changes.
//
// The probe consumes its own disjoint order set. Payment creation is unique
// per exact order set, and the confirmation test's webhook capture zeroes its
// set's payable balance, so one set cannot honestly host both tests.
// ---------------------------------------------------------------------------

const probeOrderIds = (process.env.STRIPE_EMBED_UAT_PROBE_ORDER_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
// Not a gate: this never causes a skip, only a deliberately failing assertion
// mode that proves the controls discriminate.
const probeControlMode = process.env.STRIPE_APPEARANCE_PROBE_CONTROL?.trim() ?? "";
const probeSourceContext = "stripe-appearance-probe";
const probeEnvironmentVariableNames = [
  "STRIPE_EMBED_UAT",
  "STRIPE_EMBED_UAT_ORDER_IDS",
  "STRIPE_EMBED_UAT_PROBE_ORDER_IDS",
  "MARKETPLACE_E2E_EMAIL",
  "MARKETPLACE_E2E_PASSWORD",
];
const evidenceCommand = "pnpm exec playwright test --grep @stripe-embed-uat --workers=1";

// Stripe reports a rejected or unparsable appearance value as console traffic,
// not as a failed promise, so an unstyled Element otherwise reads as a green
// run.
const stripeAppearanceRejectionPattern =
  /IntegrationError|Invalid value for|Unrecognized (?:appearance )?(?:variable|rule|property)|appearance\.(?:variables|rules)|Unsupported (?:CSS )?(?:value|property)/i;

function repositoryRoot() {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    candidate = parent;
  }
  return candidate;
}

const candidateFixtureRelativePath = "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json";
const candidateFixtureBytes = readFileSync(join(repositoryRoot(), candidateFixtureRelativePath));
const candidateFixture = JSON.parse(candidateFixtureBytes.toString("utf8")) as {
  light: Record<string, { shipped: string; candidate: string }>;
  dark: Record<string, { shipped: string; candidate: string }>;
};
const candidateFixtureSha256 = createHash("sha256").update(candidateFixtureBytes).digest("hex");
const acceptanceReceiptPath = join(
  repositoryRoot(),
  "packages/design-system/src/theme/__fixtures__/stripe-elements-acceptance-receipt.json",
);

// The consumed-input inventory is derived from the factory source, never
// hand-maintained, over both consumption seams.
const appearanceFactorySource = readFileSync(
  join(repositoryRoot(), "packages/design-system/src/theme/stripe-appearance.ts"),
  "utf8",
);
const consumedTokenNames = (() => {
  const names = new Set<string>();
  for (const match of appearanceFactorySource.matchAll(/(?:pxToken|token)\(\s*"(--[\w-]+)"/g)) names.add(match[1]!);
  const snapshot = appearanceFactorySource.match(/const appearanceSnapshotTokens = \[([\s\S]*?)\] as const;/);
  if (!snapshot) throw new Error("appearanceSnapshotTokens array not found -- the derivation seam moved");
  for (const match of snapshot[1]!.matchAll(/"(--[\w-]+)"/g)) names.add(match[1]!);
  return [...names].sort();
})();

// The two observables the probe treats as mandatory: each must discriminate
// candidate from shipped, or the injection-off control has proven nothing.
const mandatoryObservables = [
  { observable: "payment-input-background", sourceToken: "--surface-2", cssProperty: "background-color" },
  { observable: "payment-input-text-colour", sourceToken: "--foreground", cssProperty: "color" },
] as const;

type ColorMode = "light" | "dark";
type ProbeObservation = {
  observable: string;
  sourceToken: string;
  cssProperty: string;
  expected: string;
  computed: string;
  matched: boolean;
  mandatory: boolean;
};
type ProbeMoment = {
  moment: "elements-mount-complete" | "elements-update-complete";
  colorMode: ColorMode;
  resolvedTokens: Record<string, string>;
  observations: ProbeObservation[];
  consoleMessages: { type: string; text: string }[];
  screenshotSha256: string;
};

const probeState: {
  moments: ProbeMoment[];
  host: string;
  workers: number;
  collected: { title: string; status: string | undefined; expectedStatus: string; errors: number }[];
} = { moments: [], host: "", workers: 0, collected: [] };

// Every declaration is unlayered, so it outranks styles.css's `@layer base`
// custom properties regardless of specificity or source order. The dark
// literals and the dark alias group are emitted too: without them the
// unlayered light `:root` rule would also win in dark mode and the update
// moment would never move.
function candidateStylesheet(invalidProperty: string | null) {
  const names = Object.keys(candidateFixture.light);
  const valueFor = (name: string, mode: ColorMode) =>
    name === invalidProperty ? "chase-sets-not-a-colour" : candidateFixture[mode][name]!.candidate;
  const darkDiffering = names.filter(
    (name) => candidateFixture.light[name]!.candidate !== candidateFixture.dark[name]!.candidate,
  );

  const lightSelectors = [
    ":root",
    '[data-theme="light"]',
    'body:has([data-theme-choice="light"]:checked)',
    '[data-chase-theme][data-color-mode="light"]',
    '[data-chase-theme-scope][data-color-mode="light"]',
  ].join(",\n");
  const darkSelectors = [
    '[data-theme="dark"]',
    'body:has([data-theme-choice="dark"]:checked)',
    '[data-chase-theme][data-color-mode="dark"]',
    '[data-chase-theme-scope][data-color-mode="dark"]',
  ].join(",\n");
  const darkAliases = darkDiffering.map((name) => `  ${name}: var(--dark-${name.slice(2)});`).join("\n");

  return [
    `${lightSelectors} {\n${names.map((name) => `  ${name}: ${valueFor(name, "light")};`).join("\n")}\n}`,
    `:root {\n${darkDiffering.map((name) => `  --dark-${name.slice(2)}: ${valueFor(name, "dark")};`).join("\n")}\n}`,
    `${darkSelectors} {\n${darkAliases}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${darkAliases}\n  }\n}`,
  ].join("\n\n");
}

// Registered before any navigation, so the sheet is in the document before any
// document script runs. A post-load addStyleTag is the refuted mechanism: the
// appearance resolves during page load inside the mount effect's loadStripe
// chain, and observeStripeAppearance watches only theme-root attributes, so an
// appended tag fires no observer callback and re-resolves nothing.
async function registerCandidateStylesheet(page: Page, invalidProperty: string | null) {
  await page.addInitScript((css: string) => {
    const install = () => {
      if (document.querySelector("style[data-chase-ink-foil-probe]")) return;
      const style = document.createElement("style");
      style.setAttribute("data-chase-ink-foil-probe", "");
      style.textContent = css;
      (document.head ?? document.documentElement).append(style);
    };
    install();
    document.addEventListener("DOMContentLoaded", install, { once: true });
  }, candidateStylesheet(invalidProperty));
}

function watchConsole(page: Page) {
  const messages: { type: string; text: string }[] = [];
  page.on("console", (message) => messages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => messages.push({ type: "pageerror", text: error.message }));
  return messages;
}

// The shipped account-menu preference control, driven the way a buyer drives
// it. It applies the mode as optimistic client state, persists through the
// identity API in the background, and performs no navigation -- so the mounted
// Element is restyled in place through observeStripeAppearance rather than
// remounted.
async function driveColorMode(page: Page, mode: ColorMode) {
  const themeRoot = page.locator("[data-chase-theme]").first();
  await expect(themeRoot).toBeVisible({ timeout: embedReadyTimeoutMs });
  if ((await themeRoot.getAttribute("data-color-mode")) === mode) return;

  const choice = page.locator(`input[data-theme-choice="${mode}"]`);
  if ((await choice.count()) === 0) {
    await page.locator("button[aria-haspopup]").first().click();
    await expect(choice).toHaveCount(1, { timeout: embedReadyTimeoutMs });
  }

  const persisted = page.waitForResponse(
    (response) => response.url().includes("/api/identity/preferences") && response.request().method() === "PUT",
    { timeout: embedReadyTimeoutMs },
  );
  await page.locator(`label:has(input[data-theme-choice="${mode}"])`).first().click();
  await expect(themeRoot).toHaveAttribute("data-color-mode", mode, { timeout: embedReadyTimeoutMs });
  await persisted;
  await page.keyboard.press("Escape");
}

// Observations come from inside the provider's own iframe; expectations come
// from the committed fixture. The two are never read from the same document.
async function readFrameObservables(frame: FrameLocator, mode: ColorMode) {
  const expectations = mandatoryObservables.map((observable) => ({
    ...observable,
    expected: candidateFixture[mode][observable.sourceToken]!.candidate,
  }));

  return frame.locator('input[name="number"]').evaluate((input: Element, payload: typeof expectations) => {
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.append(probe);

    const normalise = (value: string) => {
      probe.style.color = "";
      probe.style.color = value;
      return probe.style.color === "" ? value : getComputedStyle(probe).color;
    };
    const describeNode = (node: Element) => {
      const classes = typeof node.className === "string" ? node.className.trim() : "";
      return `${node.tagName.toLowerCase()}${classes ? `.${classes.split(/\s+/).join(".")}` : ""}`;
    };

    // The .Input appearance rule paints the field box, not the bare <input>,
    // so the background is read from the nearest painted ancestor and the
    // element measured is reported for diagnosis.
    let painted: Element | null = input;
    let background = "";
    let measuredFrom = "";
    while (painted) {
      const value = getComputedStyle(painted).backgroundColor;
      if (value && value !== "transparent" && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(value)) {
        background = value;
        measuredFrom = describeNode(painted);
        break;
      }
      painted = painted.parentElement;
    }
    if (!background) {
      background = getComputedStyle(document.body).backgroundColor;
      measuredFrom = "body (no painted ancestor found)";
    }

    const computedFor = (cssProperty: string) =>
      cssProperty === "background-color" ? background : getComputedStyle(input).color;

    // Normalise while the probe span is still attached: getComputedStyle on a
    // detached element does not resolve a colour.
    const observations = payload.map((expectation) => ({
      observable: expectation.observable,
      sourceToken: expectation.sourceToken,
      cssProperty: expectation.cssProperty,
      expected: normalise(expectation.expected),
      computed: computedFor(expectation.cssProperty),
      mandatory: true,
    }));
    probe.remove();

    return { measuredFrom, observations };
  }, expectations);
}

// Bounded synchronisation on the provider's own rendering within the existing
// budget: no new constant, no widened budget. The acceptance path matches
// almost immediately; a control that can never match spends the same budget
// and then records its mismatch rather than aborting.
async function awaitFrameObservables(frame: FrameLocator, mode: ColorMode) {
  const deadline = Date.now() + embedReadyTimeoutMs;
  let latest = await readFrameObservables(frame, mode);
  while (
    Date.now() < deadline &&
    latest.observations.some((observation) => observation.expected !== observation.computed)
  ) {
    // The sampling cadence is a fraction of the existing budget rather than a
    // new constant, and the loop is capped by that same budget.
    await new Promise((resolve) => setTimeout(resolve, embedReadyTimeoutMs / 120));
    latest = await readFrameObservables(frame, mode);
  }
  return latest;
}

async function resolveTokensFromProbedDocument(page: Page) {
  return page.evaluate((names: string[]) => {
    const root = document.querySelector("[data-chase-theme]") ?? document.documentElement;
    const computed = getComputedStyle(root);
    return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name).trim()]));
  }, consumedTokenNames);
}

async function recordMoment(
  page: Page,
  testInfo: TestInfo,
  moment: ProbeMoment["moment"],
  mode: ColorMode,
  frame: FrameLocator,
  consoleMessages: { type: string; text: string }[],
) {
  const { measuredFrom, observations } = await awaitFrameObservables(frame, mode);
  const screenshot = await page.screenshot({ fullPage: false });
  await testInfo.attach(`${moment}.png`, { body: screenshot, contentType: "image/png" });

  const recorded: ProbeObservation[] = observations.map((observation) => ({
    ...observation,
    matched: observation.expected === observation.computed,
  }));

  // A named per-observable result line at every moment, emitted whether or not
  // an earlier observable mismatched. Aggregate-only evidence satisfies no
  // control in this slice.
  for (const observation of recorded) {
    const line =
      `${moment} [${mode}] ${observation.observable}: ${observation.cssProperty} from ${observation.sourceToken} ` +
      `expected ${observation.expected}, computed ${observation.computed} (measured on ${measuredFrom})`;
    console.log(line);
    expect.soft(observation.computed, line).toBe(observation.expected);
  }

  probeState.moments.push({
    moment,
    colorMode: mode,
    resolvedTokens: await resolveTokensFromProbedDocument(page),
    observations: recorded,
    consoleMessages: [...consoleMessages],
    screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
  });
}

async function createProbePayment(request: APIRequestContext): Promise<string> {
  const statusQuery = probeOrderIds.map((orderId) => `orderId=${encodeURIComponent(orderId)}`).join("&");
  const status = await getJson(request, `/api/marketplace/account/checkout/status?${statusQuery}`);
  expect(
    status.can_start_payment,
    "checkout status must allow starting a payment for STRIPE_EMBED_UAT_PROBE_ORDER_IDS -- the probe set is exhausted, captured, or already claimed; provision a fresh disjoint set",
  ).toBe(true);

  // The shipped source-idempotency seam returns the existing payment for a
  // repeated (sourceContext, sourceReferenceId) pair before any uniqueness or
  // balance check, so the two control invocations re-mount this same pending
  // payment instead of tripping active_payment_exists_for_order_set.
  const created = await request.post("/api/marketplace/account/payments", {
    data: {
      orderIds: probeOrderIds,
      currencyCode: "usd",
      requestedBalanceCreditAmount: balanceCreditAmount,
      paymentMethodCategory,
      marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      sourceContext: probeSourceContext,
      sourceReferenceId: [...probeOrderIds].sort().join(","),
    },
  });
  expect(created.ok(), `probe payment creation failed with ${created.status()}: ${await created.text()}`).toBe(true);
  const payment = await created.json();
  const paymentId = payment.payment_id as string | undefined;
  expect(paymentId, "probe payment creation did not return a payment_id").toBeTruthy();

  return paymentId!;
}

test.describe("stripe embed confirmation UAT", () => {
  test("mounts the real Payment Element, confirms with a Stripe test card, and captures via webhook @stripe-embed-uat", async ({
    page,
  }) => {
    test.setTimeout(captureTimeoutMs + 120_000);
    test.skip(!runStripeEmbedUat, "Set STRIPE_EMBED_UAT=true to run the Stripe embed confirmation UAT.");
    test.skip(
      orderIds.length === 0,
      "Set STRIPE_EMBED_UAT_ORDER_IDS to one or more pending-payment order ids created through the normal checkout path in Stripe test mode.",
    );
    test.skip(
      !buyerEmail || !buyerPassword,
      "MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD are required for the Stripe embed confirmation UAT.",
    );

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpurchases");
    await signInWithPassword(page, new URL(page.url()).origin, { email: buyerEmail, password: buyerPassword });

    const paymentId = await createPendingPayment(page.request);

    await page.goto(`/account/payments/${paymentId}`, { waitUntil: "domcontentloaded" });

    const embedContainer = page.getByTestId("payment-element-container");
    await expect(embedContainer).toBeVisible({ timeout: embedReadyTimeoutMs });
    await expect(page.getByTestId("payment-element-skeleton")).toHaveCount(0, { timeout: embedReadyTimeoutMs });

    const stripeFrame = page.frameLocator('iframe[title="Secure payment input frame"]');
    await stripeFrame.locator('input[name="number"]').fill(stripeTestCard.number);
    await stripeFrame.locator('input[name="expiry"]').fill(stripeTestCard.expiry);
    await stripeFrame.locator('input[name="cvc"]').fill(stripeTestCard.cvc);
    const postalCode = stripeFrame.locator('input[name="postalCode"]');
    if (await postalCode.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await postalCode.fill(stripeTestCard.postalCode);
    }

    await page
      .getByRole("button", { name: /^Confirm payment$/i })
      .first()
      .click();

    // The confirmation card itself only flips out of "processing" once the
    // route revalidates against webhook-delivered truth (see
    // StripeConfirmationCard's poll effect). Poll the payment resource
    // directly so this assertion fails on the webhook leg specifically, not
    // on client-side UI state.
    await expect
      .poll(
        async () => {
          const current = await getJson(page.request, `/api/marketplace/account/payments/${paymentId}`);
          return current.status;
        },
        {
          message: "payment did not reach captured status -- webhook-driven capture did not land",
          intervals: [2_000, 5_000, 10_000],
          timeout: captureTimeoutMs,
        },
      )
      .toBe("captured");
  });

  test("mounts the real Payment Element with the candidate Ink & Foil appearance injected at document start and proves Stripe accepts it at the completed mount and the completed update @stripe-embed-uat @stripe-appearance-probe", async ({
    page,
  }, testInfo) => {
    test.setTimeout(captureTimeoutMs + embedReadyTimeoutMs);
    test.skip(!runStripeEmbedUat, "Set STRIPE_EMBED_UAT=true to run the Stripe embed confirmation UAT.");
    test.skip(
      orderIds.length === 0,
      "Set STRIPE_EMBED_UAT_ORDER_IDS to one or more pending-payment order ids created through the normal checkout path in Stripe test mode.",
    );
    test.skip(
      !buyerEmail || !buyerPassword,
      "MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD are required for the Stripe embed confirmation UAT.",
    );
    test.skip(
      probeOrderIds.length === 0,
      "Set STRIPE_EMBED_UAT_PROBE_ORDER_IDS to one or more pending-payment order ids, disjoint from STRIPE_EMBED_UAT_ORDER_IDS, created through the same checkout path in Stripe test mode.",
    );

    // One order set cannot honestly host both tests: concurrent creation trips
    // exact-order-set uniqueness, and the confirmation test's capture zeroes
    // the set's payable balance.
    const overlap = probeOrderIds.filter((orderId) => orderIds.includes(orderId));
    expect(
      overlap,
      `STRIPE_EMBED_UAT_PROBE_ORDER_IDS must share no order id with STRIPE_EMBED_UAT_ORDER_IDS; overlapping ids: ${overlap.join(", ")}`,
    ).toEqual([]);

    const consoleMessages = watchConsole(page);
    if (probeControlMode !== "injection-off") {
      await registerCandidateStylesheet(page, probeControlMode === "invalid-value" ? "--primary" : null);
    }

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpurchases");
    await signInWithPassword(page, new URL(page.url()).origin, { email: buyerEmail, password: buyerPassword });
    probeState.host = new URL(page.url()).origin;

    const paymentId = await createProbePayment(page.request);
    testInfo.annotations.push({ type: "probe-payment-id", description: paymentId });

    // The mount mode is deterministic whatever the buyer's stored preference
    // (the shipped default is `system`), and driving it before navigating is
    // what makes the control re-runs deterministic rather than order-dependent.
    await driveColorMode(page, "light");

    await page.goto(`/account/payments/${paymentId}`, { waitUntil: "domcontentloaded" });
    const embedContainer = page.getByTestId("payment-element-container");
    await expect(embedContainer).toBeVisible({ timeout: embedReadyTimeoutMs });
    await expect(page.getByTestId("payment-element-skeleton")).toHaveCount(0, { timeout: embedReadyTimeoutMs });

    const stripeFrame = page.frameLocator('iframe[title="Secure payment input frame"]');
    await expect(stripeFrame.locator('input[name="number"]')).toBeVisible({ timeout: embedReadyTimeoutMs });

    await recordMoment(page, testInfo, "elements-mount-complete", "light", stripeFrame, consoleMessages);

    // The dark values reach Stripe only on the mode transition: the shipped
    // control mutates data-color-mode, observeStripeAppearance fires, and the
    // caller runs elements.update. A mount-only capture proves nothing here.
    await driveColorMode(page, "dark");
    await expect(embedContainer).toBeVisible({ timeout: embedReadyTimeoutMs });
    await recordMoment(page, testInfo, "elements-update-complete", "dark", stripeFrame, consoleMessages);

    if (probeControlMode === "injection-off") {
      for (const mandatory of mandatoryObservables) {
        const results = probeState.moments.flatMap((moment) =>
          moment.observations.filter((observation) => observation.observable === mandatory.observable),
        );
        expect
          .soft(
            results.some((observation) => !observation.matched),
            `injection-off control: ${mandatory.observable} produced no named failure at either lifecycle moment. ` +
              `The candidate value for ${mandatory.sourceToken} is byte-identical to the shipped value in both modes, so this ` +
              "observable is non-discriminating and an aggregate failure elsewhere cannot stand in for it.",
          )
          .toBe(true);
      }
    }

    const rejections = consoleMessages.filter((message) => stripeAppearanceRejectionPattern.test(message.text));
    if (probeControlMode === "invalid-value") {
      expect(
        rejections.length,
        "invalid-value control: Stripe emitted no message naming the deliberately invalid --primary value, so console " +
          `capture does not bite. Captured console traffic: ${JSON.stringify(consoleMessages)}`,
      ).toBeGreaterThan(0);
    }
    expect(
      rejections.map((message) => message.text),
      "Stripe rejected or could not parse an appearance value",
    ).toEqual([]);
  });

  // The receipt is emitted from the run itself, never asserted from the issue.
  // At @playwright/test 1.60 the worker-side `tags` merges title-embedded
  // @-tokens with declared tags, so the unmodified confirmation test and the
  // probe both enter the accumulation, while a --grep @stripe-appearance-probe
  // control invocation collects only the probe and therefore refuses.
  test.afterEach(async ({}, testInfo) => {
    if (!testInfo.tags.includes("@stripe-embed-uat")) return;
    probeState.workers = testInfo.config.workers;
    probeState.collected.push({
      title: testInfo.title,
      status: testInfo.status,
      expectedStatus: testInfo.expectedStatus,
      errors: testInfo.errors.length,
    });
  });

  test.afterAll(async () => {
    const refusals: string[] = [];
    if (probeControlMode) refusals.push(`control mode ${probeControlMode} never mints evidence`);
    if (probeState.collected.length < 2) {
      refusals.push(`collected ${probeState.collected.length} tagged tests, need at least 2`);
    }
    if (probeState.collected.some((entry) => entry.status === "skipped")) refusals.push("a collected test skipped");
    if (probeState.collected.some((entry) => entry.status !== "passed" || entry.errors > 0)) {
      refusals.push("a collected test did not pass cleanly");
    }
    const recorded = probeState.moments.map((moment) => moment.moment);
    for (const required of ["elements-mount-complete", "elements-update-complete"] as const) {
      if (!recorded.includes(required)) refusals.push(`lifecycle moment ${required} was not recorded`);
    }

    if (refusals.length > 0) {
      console.log(`stripe appearance acceptance receipt refused: ${refusals.join("; ")}`);
      return;
    }

    const receipt = {
      schemaVersion: "stripe-appearance-acceptance-receipt/v1",
      surface: "elements",
      stripeMode: "test",
      implementationHead: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot(),
        encoding: "utf8",
      }).trim(),
      fixturePath: candidateFixtureRelativePath,
      fixtureSha256: candidateFixtureSha256,
      capturedAt: new Date().toISOString(),
      host: probeState.host,
      environmentVariableNames: probeEnvironmentVariableNames,
      runSummary: {
        command: evidenceCommand,
        workers: probeState.workers,
        collected: probeState.collected.length,
        passed: probeState.collected.filter((entry) => entry.status === "passed").length,
        failed: 0,
        skipped: 0,
        testTitles: probeState.collected.map((entry) => entry.title),
      },
      moments: probeState.moments,
      substitutionsApplied: [],
    };

    writeFileSync(acceptanceReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`stripe appearance acceptance receipt written to ${acceptanceReceiptPath}`);
  });
});

async function getJson(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.ok(), `${path} failed with ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function createPendingPayment(request: APIRequestContext): Promise<string> {
  const statusQuery = orderIds.map((orderId) => `orderId=${encodeURIComponent(orderId)}`).join("&");
  const status = await getJson(request, `/api/marketplace/account/checkout/status?${statusQuery}`);
  expect(
    status.can_start_payment,
    "checkout status must allow starting a payment for STRIPE_EMBED_UAT_ORDER_IDS -- confirm those order ids are pending-payment and unclaimed",
  ).toBe(true);

  const created = await request.post("/api/marketplace/account/payments", {
    data: {
      orderIds,
      currencyCode: "usd",
      requestedBalanceCreditAmount: balanceCreditAmount,
      paymentMethodCategory,
      marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
    },
  });
  expect(created.ok(), `payment creation failed with ${created.status()}: ${await created.text()}`).toBe(true);
  const payment = await created.json();
  const paymentId = payment.payment_id as string | undefined;
  expect(paymentId, "payment creation did not return a payment_id").toBeTruthy();

  return paymentId!;
}
