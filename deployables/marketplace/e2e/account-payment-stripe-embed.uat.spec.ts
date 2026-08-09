import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const evidenceCommand =
  "pnpm exec playwright test --config playwright.stripe-appearance-evidence.config.ts --grep @stripe-embed-uat --workers=1";

// Stripe reports a rejected or unparsable appearance value as console traffic,
// not as a failed promise, so an unstyled Element otherwise reads as a green
// run.
const stripeAppearanceRejectionPattern =
  /IntegrationError|Invalid value for|Unrecognized (?:appearance )?(?:variable|rule|property)|appearance\.(?:variables|rules)|Unsupported (?:CSS )?(?:value|property)/i;

// ---------------------------------------------------------------------------
// Retention-governance surface (settled r2 F4).
//
// Every invocation of this spec -- evidence, controls, refusal, and the
// provider-free battery -- carries --config with the dedicated evidence
// config, which governs report, screenshot, video, trace, attachment, and
// .last-run.json output by construction: list reporter only, artifacts off,
// retries 0, governed outputDir. The guard below turns a configured or
// control-mode invocation under an ungoverned resolved config into a named
// refusal before sign-in, navigation, or any content capture. A forgotten
// --config cannot be made byte-free -- the runner itself writes its report
// and .last-run.json before any test code runs -- so the guarantee is a
// content-free early refusal, never "no framework bytes".
// ---------------------------------------------------------------------------

const governedEvidenceRoot = "artifacts/stripe-appearance-evidence/test-results";

type ResolvedRetentionSettings = {
  reporterNames: string[];
  outputDir: string;
  retries: number;
  trace: unknown;
  screenshot: unknown;
  video: unknown;
};

// Pure over the resolved settings, so the predicate is provable provider-free
// against any shape -- including the exact shape a forgotten --config
// resolves -- without a configured session.
export function ungovernedSettings(resolved: ResolvedRetentionSettings): string[] {
  const problems: string[] = [];
  if (resolved.reporterNames.join(",") !== "list") {
    problems.push(`reporter: must be exactly the list reporter, resolved [${resolved.reporterNames.join(", ")}]`);
  }
  if (!resolved.outputDir.replace(/\\/g, "/").endsWith(governedEvidenceRoot)) {
    problems.push(
      `outputDir: must resolve to the governed root ${governedEvidenceRoot}, resolved ${resolved.outputDir}`,
    );
  }
  if (resolved.retries !== 0) {
    problems.push(`retries: must be 0, resolved ${resolved.retries}`);
  }
  const artifactModes: [string, unknown][] = [
    ["trace", resolved.trace],
    ["screenshot", resolved.screenshot],
    ["video", resolved.video],
  ];
  for (const [name, mode] of artifactModes) {
    if (mode !== "off") {
      problems.push(`use.${name}: must be "off", resolved ${JSON.stringify(mode)}`);
    }
  }
  return problems;
}

// Playwright resolves top-level use/retries/outputDir into FullProject, so the
// project view is the only route to the settings that actually govern this
// worker; FullConfig exposes no `use`.
function resolvedRetentionSettings(testInfo: TestInfo): ResolvedRetentionSettings {
  const use = testInfo.project.use as { trace?: unknown; screenshot?: unknown; video?: unknown };
  const reporter: unknown = testInfo.config.reporter;
  return {
    reporterNames: Array.isArray(reporter)
      ? reporter.map((entry: unknown) => String(Array.isArray(entry) ? entry[0] : entry))
      : [String(reporter)],
    outputDir: testInfo.project.outputDir,
    retries: testInfo.project.retries,
    trace: use.trace,
    screenshot: use.screenshot,
    video: use.video,
  };
}

// Tag-filtered and fail-closed: whenever this spec's tagged tests run
// configured (STRIPE_EMBED_UAT=true) or in a control mode, an ungoverned
// resolved config is a hard failure naming each ungoverned setting -- never a
// skip. Unconfigured runs return here untouched and skip exactly as before.
test.beforeEach(async ({}, testInfo) => {
  if (!testInfo.tags.includes("@stripe-embed-uat")) return;
  if (!runStripeEmbedUat && !probeControlMode) return;
  const problems = ungovernedSettings(resolvedRetentionSettings(testInfo));
  expect(
    problems,
    `configured or control-mode invocation under an ungoverned resolved config; every invocation of this spec must carry ` +
      `--config ${evidenceConfigRelativePath}. Ungoverned settings: ${problems.join("; ")}`,
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// Retained-artifact retention guard.
//
// Shape patterns alone cannot see a leak: the session's real password, buyer
// email, order ids, payment id, and session cookies are ordinary strings. The
// guard therefore compares every retained byte against the *actual configured
// values* this run was given, and reports only the category it matched --
// never the value, never a prefix, never a length. It is fail-closed: any hit
// refuses the artifact rather than redacting and hoping.
// ---------------------------------------------------------------------------

type RetentionCategory = "credential" | "buyer-identity" | "order-reference" | "payment-reference" | "session-marker";

type RetentionValue = { value: string; category: RetentionCategory };

type RetentionGuard = {
  scanText: (text: string) => RetentionCategory[];
  redactText: (text: string) => { text: string; categories: RetentionCategory[] };
  scanBuffer: (buffer: Buffer) => RetentionCategory[];
};

// Shapes that are a leak whatever this run was configured with. The card-number
// alternatives are the issuer prefixes Stripe's own test PANs use, so a bare
// digit run inside a digest can never false-positive.
const retentionShapePatterns: { category: RetentionCategory; pattern: RegExp }[] = [
  // `cs` covers Checkout Session client secrets (cs_test_/cs_live_ runs), the
  // shape the browser-delivered processor_client_secret takes on that surface.
  { category: "credential", pattern: /\b(?:sk|pk|rk|cs)_(?:test|live)_[A-Za-z0-9]{4,}/g },
  { category: "credential", pattern: /\bwhsec_[A-Za-z0-9]{4,}/g },
  { category: "credential", pattern: /\b(?:password|passwd|secret|api[-_]?key|apikey|bearer)\b\s*[=:]\s*\S+/gi },
  { category: "buyer-identity", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { category: "payment-reference", pattern: /\b(?:pi|seti|pm|cus|acct|ch|py|src|sub|in)_[A-Za-z0-9]{6,}/g },
  // (r4 F4) Provider events, provider requests, and payment-method tokens are
  // governed at their real granularity: no test/live mode infix exists for
  // these classes, and Stripe's own test tokens (`tok_visa`, `tok_visa_debit`)
  // carry four-character-plus suffixes, so the bounds here are theirs -- not
  // the longer payment-reference granularity above.
  { category: "payment-reference", pattern: /\b(?:evt|req)_[A-Za-z0-9]{4,}/g },
  { category: "payment-reference", pattern: /\btok_[A-Za-z0-9][A-Za-z0-9_]{3,}/g },
  { category: "order-reference", pattern: /\b(?:order|buyer)[-_](?:account[-_])?id\b\s*[=:]\s*\S+/gi },
  { category: "session-marker", pattern: /\b(?:session|sid|sess|csrf|xsrf)[-_]?(?:id|token)?\b\s*[=:]\s*\S+/gi },
  {
    category: "credential",
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  },
];

// Configured values shorter than this cannot be compared as substrings without
// matching innocent text, so the guard refuses to treat them as secrets at all;
// the shape patterns still cover the credential-shaped ones.
const minimumComparableSecretLength = 6;

function createRetentionGuard(configured: RetentionValue[]): RetentionGuard {
  const comparable = configured.filter((entry) => entry.value.length >= minimumComparableSecretLength);

  const scanString = (text: string) => {
    const categories = new Set<RetentionCategory>();
    for (const { category, pattern } of retentionShapePatterns) {
      if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text)) categories.add(category);
    }
    for (const entry of comparable) {
      if (text.includes(entry.value)) categories.add(entry.category);
    }
    return [...categories];
  };

  return {
    scanText: scanString,
    redactText: (text: string) => {
      const categories = new Set<RetentionCategory>();
      let redacted = text;
      for (const entry of comparable) {
        if (!redacted.includes(entry.value)) continue;
        categories.add(entry.category);
        redacted = redacted.split(entry.value).join(`[redacted:${entry.category}]`);
      }
      for (const { category, pattern } of retentionShapePatterns) {
        const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
        if (!matcher.test(redacted)) continue;
        categories.add(category);
        redacted = redacted.replace(
          new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
          `[redacted:${category}]`,
        );
      }
      return { text: redacted, categories: [...categories] };
    },
    // PNG text chunks and any incidentally rasterised byte run are plain bytes.
    // Both single-byte and UTF-16 decodings are scanned so a marker cannot hide
    // behind an encoding the image pipeline chose.
    scanBuffer: (buffer: Buffer) => {
      const categories = new Set<RetentionCategory>();
      for (const encoding of ["latin1", "utf8", "utf16le"] as const) {
        for (const category of scanString(buffer.toString(encoding))) categories.add(category);
      }
      return [...categories];
    },
  };
}

// Assembled from the process environment, so the comparison is against what the
// run actually used rather than against a hand-listed guess. Values never leave
// this array.
function configuredRetentionValues(): RetentionValue[] {
  const values: RetentionValue[] = [];
  const push = (value: string | undefined, category: RetentionCategory) => {
    const trimmed = value?.trim();
    if (trimmed) values.push({ value: trimmed, category });
  };

  push(buyerEmail, "buyer-identity");
  push(buyerPassword, "credential");
  for (const orderId of [...orderIds, ...probeOrderIds]) push(orderId, "order-reference");
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    // Secret-by-name, plus any credential-shaped Stripe value whatever its
    // name. Probe configuration under STRIPE_* -- the gate flag, the order id
    // lists, the control selector -- is deliberately not treated as a secret:
    // redacting it would strip the receipt's own qualifying host and refuse
    // every honest run, and the shape patterns still catch a real key wherever
    // it appears.
    if (/(?:SECRET|PASSWORD|PASSPHRASE|TOKEN|CREDENTIAL|PRIVATE_KEY|_KEY|APIKEY)$/.test(name)) {
      push(value, "credential");
    } else if (/^(?:sk|pk|rk|cs)_(?:test|live)_|^whsec_/.test(value)) {
      push(value, "credential");
    }
    // A connection string's userinfo is a credential even when its variable is
    // named for the endpoint rather than the secret.
    const userinfo = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@/i);
    if (userinfo) push(userinfo[1], "credential");
  }

  return values;
}

const runtimeRetentionValues: RetentionValue[] = [];
let retentionGuard = createRetentionGuard(configuredRetentionValues());
const retentionScan = { textualArtifacts: 0, imageArtifacts: 0, redactionsApplied: 0, forbiddenMarkerHits: 0 };

// Values only the running session knows -- the created payment id, the session
// cookies -- join the comparison set before anything is retained.
function registerRuntimeRetentionValue(value: string | undefined | null, category: RetentionCategory) {
  const trimmed = value?.trim();
  if (!trimmed) return;
  if (runtimeRetentionValues.some((entry) => entry.value === trimmed && entry.category === category)) return;
  runtimeRetentionValues.push({ value: trimmed, category });
  retentionGuard = createRetentionGuard([...configuredRetentionValues(), ...runtimeRetentionValues]);
}

async function registerSessionRetentionValues(page: Page) {
  for (const cookie of await page.context().cookies()) {
    registerRuntimeRetentionValue(cookie.value, "session-marker");
  }
}

// (r4 F4) Runtime registration is bound at the granularity production actually
// reads: the payment page renders processor_payment_reference and each
// provider_events[].provider_event_id in its support-details section, and the
// saved-payment setup session hands the browser its internal setup_reference_id
// plus the provider's processor_setup_reference, processor_client_secret, and
// processor_publishable_key. Every one of those fields joins the retention
// comparison set the moment the browser is handed it, recursively over the
// whole payload, and none is ever logged, echoed, or asserted on. The internal
// setup_reference_id is registered fail-closed for run artifacts even though it
// is the one reference AC-11 permits the pull-request body to record in the
// clear; provider `seti_` references are forbidden everywhere.
const governedIdentifierFieldCategories: { matches: (field: string) => boolean; category: RetentionCategory }[] = [
  { matches: (field) => field.includes("client_secret"), category: "credential" },
  { matches: (field) => field === "processor_publishable_key", category: "credential" },
  { matches: (field) => field === "processor_payment_reference", category: "payment-reference" },
  { matches: (field) => field === "processor_setup_reference", category: "payment-reference" },
  { matches: (field) => field === "provider_event_id", category: "payment-reference" },
  { matches: (field) => field === "setup_reference_id", category: "session-marker" },
];

function registerGovernedIdentifierFields(payload: unknown) {
  if (typeof payload !== "object" || payload === null) return;
  const entries = Array.isArray(payload)
    ? payload.map((value, index) => [String(index), value] as const)
    : Object.entries(payload as Record<string, unknown>);
  for (const [field, value] of entries) {
    if (typeof value === "string") {
      const governed = governedIdentifierFieldCategories.find((entry) => entry.matches(field));
      if (governed) registerRuntimeRetentionValue(value, governed.category);
    } else {
      registerGovernedIdentifierFields(value);
    }
  }
}

// React Router delivers the payment-methods route's action data as an encoded
// stream rather than plain JSON, so name-keyed registration cannot see inside
// it. Every provider-identifier-shaped string in a watched body is therefore
// also registered by exact value -- the shape rules decide the category --
// which keeps the comparison set ahead of any serialisation format the
// delivery takes.
function registerShapedIdentifiersFromText(body: string) {
  for (const { category, pattern } of retentionShapePatterns) {
    const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of body.matchAll(matcher)) {
      registerRuntimeRetentionValue(match[0], category);
    }
  }
}

// The browser fetches the payment resource itself while the page mounts, and
// the payment-methods route action hands it the setup session, so both
// governed endpoint families -- the payments family and the payment-methods /
// setup-session family -- are watched and registered from the response stream
// as delivered, before any capture moment can retain a byte, rather than
// guessed from configuration.
function watchProviderIdentifierDeliveries(page: Page) {
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/api/marketplace/account/payments") && !url.includes("/account/payment-methods")) return;
    let body: string;
    try {
      body = await response.text();
    } catch {
      // A body that can no longer be read delivered nothing the page retains.
      return;
    }
    try {
      registerGovernedIdentifierFields(JSON.parse(body));
    } catch {
      // Not plain JSON (the route action's encoded stream): the shape-based
      // registration below still binds every provider-shaped value it carried.
    }
    registerShapedIdentifiersFromText(body);
  });
}

function redactedDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

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
const appearanceFactoryRelativePath = "packages/design-system/src/theme/stripe-appearance.ts";
const probeSpecRelativePath = "deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts";
const evidenceConfigRelativePath = "playwright.stripe-appearance-evidence.config.ts";
const appearanceFactorySource = readFileSync(join(repositoryRoot(), appearanceFactoryRelativePath), "utf8");

// The receipt cannot bind to the commit that contains it -- committing the
// receipt moves the head it would have to name. It binds instead to the exact
// bytes of everything that could change what the provider was sent or how the
// run's artifacts were governed: the appearance factory, the candidate
// fixture, this probe spec, and the dedicated evidence config. A later edit
// to any of them stales every receipt that pinned the old bytes, with no
// self-reference and nothing for a hand edit to satisfy.
const receiptSourceDigestPaths = [
  appearanceFactoryRelativePath,
  candidateFixtureRelativePath,
  probeSpecRelativePath,
  evidenceConfigRelativePath,
] as const;

function receiptSourceDigests() {
  return Object.fromEntries(
    receiptSourceDigestPaths.map((relativePath) => [
      relativePath,
      createHash("sha256")
        .update(readFileSync(join(repositoryRoot(), relativePath)))
        .digest("hex"),
    ]),
  );
}
const consumedTokenNames = (() => {
  const names = new Set<string>();
  for (const match of appearanceFactorySource.matchAll(/(?:pxToken|token)\(\s*"(--[\w-]+)"/g)) names.add(match[1]!);
  const snapshot = appearanceFactorySource.match(/const appearanceSnapshotTokens = \[([\s\S]*?)\] as const;/);
  if (!snapshot) throw new Error("appearanceSnapshotTokens array not found -- the derivation seam moved");
  for (const match of snapshot[1]!.matchAll(/"(--[\w-]+)"/g)) names.add(match[1]!);
  return [...names].sort();
})();

// The painted surface the `.Input` and `.Block` rules fill, taken from the
// factory itself (`backgroundColor: surface` on both rules). A translucent
// border is only meaningful composited over it, so the expectation names it.
const paintedSurfaceSourceToken = "--surface-2";

// (r4 F5) Each real surface is probed with the payload production actually
// sends there, and every mandatory observable must discriminate candidate from
// shipped or the injection-off control has proven nothing. The Checkout
// (`cs_`) caller builds its appearance with includeRules: false at mount and
// update -- settled product mechanism -- so only variables reach that surface:
// its mandatory observables are the variables-backed `.Input` text colour
// (colorText <- --foreground) and `.Input` background (colorBackground <-
// --card). No border, --surface-2, or other rules-only expectation may appear
// on the Checkout surface, because production sends none of them there.
const checkoutMandatoryObservables = [
  { observable: "checkout-input-text-colour", sourceToken: "--foreground", cssProperty: "color" },
  { observable: "checkout-input-background", sourceToken: "--card", cssProperty: "background-color" },
] as const;

// The full-rules payload ships on the stripe.elements() surfaces; the
// SetupIntent-backed setup card is the shipped consumer this probe drives, and
// the saved-instrument PaymentIntent branch consumes the identical object by
// construction. The settled border observation contract (r1 F3, preserved)
// lives here: `--border` is mandatory because the ratified dark anchor is the
// alpha value `rgba(242, 239, 250, 0.08)` -- the single highest-risk value in
// the set and the provider fact this whole probe exists to settle. The outer
// document's resolved tokens prove injection state; only a frame-internal
// border read proves Stripe accepted and rendered it.
const setupMandatoryObservables = [
  { observable: "payment-input-background", sourceToken: "--surface-2", cssProperty: "background-color" },
  { observable: "payment-input-text-colour", sourceToken: "--foreground", cssProperty: "color" },
  { observable: "payment-input-border-colour", sourceToken: "--border", cssProperty: "border-color" },
] as const;

// Stripe renders `.Block` only in the multi-method layouts. When it is present
// the same `--border` value must govern it, and the receipt binds it under
// exactly the mandatory rules; when it is absent nothing is fabricated. Rules
// reach only the setup surface, so the conditional observable belongs to it.
const conditionalObservables = [
  { observable: "payment-block-border-colour", sourceToken: "--border", cssProperty: "border-color" },
] as const;

type ColorMode = "light" | "dark";
type ProbeSurface = "checkout" | "setup";
type ProbeObservation = {
  observable: string;
  sourceToken: string;
  cssProperty: string;
  expected: string;
  computed: string;
  matched: boolean;
  mandatory: boolean;
  paintedOver?: { sourceToken: string; expected: string; compositedExpected: string };
};
type ProbeMoment = {
  moment: "elements-mount-complete" | "elements-update-complete" | "setup-mount-complete" | "setup-update-complete";
  colorMode: ColorMode;
  resolvedTokens: Record<string, string>;
  observations: ProbeObservation[];
  consoleMessages: { type: string; text: string }[];
  screenshotSha256: string;
  screenshotClip: "stripe-frame";
  screenshotMaskedRegions: number;
};

// sRGB source-over composite, so a translucent border's rendered colour is
// derived by computation from two fixture values rather than transcribed.
export function compositeOverOpaque(foreground: string, backdrop: string) {
  const parseRgba = (value: string) => {
    const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const int = Number.parseInt(hex[1]!, 16);
      return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
    }
    const fn = value.trim().match(/^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+))?\s*\)$/i);
    if (!fn) return null;
    return {
      r: Number.parseFloat(fn[1]!),
      g: Number.parseFloat(fn[2]!),
      b: Number.parseFloat(fn[3]!),
      a: fn[4] === undefined ? 1 : Number.parseFloat(fn[4]),
    };
  };

  const top = parseRgba(foreground);
  const bottom = parseRgba(backdrop);
  if (!top || !bottom) return null;
  const channel = (over: number, under: number) => Math.round(over * top.a + under * (1 - top.a));
  const toHex = (component: number) => component.toString(16).padStart(2, "0");
  return `#${toHex(channel(top.r, bottom.r))}${toHex(channel(top.g, bottom.g))}${toHex(channel(top.b, bottom.b))}`;
}

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
function candidateStylesheet({
  invalidProperty = null,
  omitDarkAliases = false,
}: { invalidProperty?: string | null; omitDarkAliases?: boolean } = {}) {
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
    // Without the dark alias groups the unlayered light `:root` rule outranks
    // the shipped dark aliases too and the update moment never moves. Omitting
    // them is a control, never a configuration.
    ...(omitDarkAliases
      ? []
      : [
          `${darkSelectors} {\n${darkAliases}\n}`,
          `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${darkAliases}\n  }\n}`,
        ]),
  ].join("\n\n");
}

const probeStyleMarkerAttribute = "data-chase-ink-foil-probe";
const probeInitErrorsGlobal = "__chaseInkFoilProbeInitErrors";
const probeInstallStagesGlobal = "__chaseInkFoilProbeInstallStages";

// Registered before any navigation, so the candidate values are resolvable
// before any document script runs. A post-load addStyleTag is the refuted
// mechanism: the appearance resolves during page load inside the mount
// effect's loadStripe chain, and observeStripeAppearance watches only
// theme-root attributes, so an appended tag fires no observer callback and
// re-resolves nothing.
//
// At document start the parser has not yet created `documentElement`, so
// `(document.head ?? document.documentElement).append(...)` dereferences null
// and the init script dies before it can register anything -- the whole
// mechanism silently reverting to shipped values. Two stages replace it, both
// installing without ever dereferencing a missing insertion point:
//
//   1. an adopted constructible stylesheet, which needs no insertion point at
//      all and is therefore in force before the first byte of markup is
//      parsed. Adopted sheets sort after `document.styleSheets` within the
//      author origin and carry no `@layer`, so unlayered precedence over
//      styles.css's `@layer base` is preserved exactly;
//   2. the prescribed `<style>` installation, attempted immediately and then
//      re-attempted from a MutationObserver on `document` -- observing only
//      until `head` or `documentElement` exists -- with a DOMContentLoaded
//      backstop.
//
// Installation is confined to the top-level document. Init scripts otherwise
// run in every frame including the provider's, and the probe's whole claim is
// that expectations and observations never come from the same document.
async function registerCandidateStylesheet(
  page: Page,
  options: { invalidProperty?: string | null; omitDarkAliases?: boolean } = {},
) {
  await page.addInitScript(
    (payload: { css: string; markerAttribute: string; errorsGlobal: string; stagesGlobal: string }) => {
      const scope = window as unknown as Record<string, unknown>;
      const errors = (scope[payload.errorsGlobal] as string[] | undefined) ?? [];
      const stages = (scope[payload.stagesGlobal] as string[] | undefined) ?? [];
      scope[payload.errorsGlobal] = errors;
      scope[payload.stagesGlobal] = stages;

      if (window.top !== window.self) {
        stages.push("skipped-subframe");
        return;
      }

      const adopt = () => {
        try {
          if (typeof CSSStyleSheet !== "function" || !("adoptedStyleSheets" in document)) return false;
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(payload.css);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          stages.push("adopted-stylesheet");
          return true;
        } catch (error) {
          errors.push(`adopt: ${(error as Error).message}`);
          return false;
        }
      };

      const install = () => {
        try {
          const parent = document.head ?? document.documentElement;
          if (!parent) return false;
          if (parent.querySelector(`style[${payload.markerAttribute}]`)) return true;
          const style = document.createElement("style");
          style.setAttribute(payload.markerAttribute, "");
          style.textContent = payload.css;
          parent.append(style);
          stages.push(parent === document.head ? "head-element" : "document-element");
          return true;
        } catch (error) {
          errors.push(`install: ${(error as Error).message}`);
          return false;
        }
      };

      adopt();
      if (install()) return;

      try {
        const observer = new MutationObserver(() => {
          if (install()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            install();
            observer.disconnect();
          },
          { once: true },
        );
      } catch (error) {
        errors.push(`observe: ${(error as Error).message}`);
      }
    },
    {
      css: candidateStylesheet(options),
      markerAttribute: probeStyleMarkerAttribute,
      errorsGlobal: probeInitErrorsGlobal,
      stagesGlobal: probeInstallStagesGlobal,
    },
  );
}

async function readInstallDiagnostics(page: Page) {
  return page.evaluate(
    (globals: { errorsGlobal: string; stagesGlobal: string }) => {
      const scope = window as unknown as Record<string, unknown>;
      return {
        initErrors: (scope[globals.errorsGlobal] as string[] | undefined) ?? [],
        installStages: (scope[globals.stagesGlobal] as string[] | undefined) ?? [],
      };
    },
    { errorsGlobal: probeInitErrorsGlobal, stagesGlobal: probeInstallStagesGlobal },
  );
}

// Console traffic is redacted at capture time, so no unredacted byte is ever
// held in a structure that could later be serialised into an artifact. The
// diagnostic `type` and the Stripe warning text itself survive redaction --
// only matched secrets and markers are replaced.
function watchConsole(page: Page) {
  const messages: { type: string; text: string }[] = [];
  const record = (type: string, text: string) => {
    const { text: redacted, categories } = retentionGuard.redactText(text);
    retentionScan.textualArtifacts += 1;
    retentionScan.redactionsApplied += categories.length;
    messages.push({ type, text: redacted });
  };
  page.on("console", (message) => record(message.type(), message.text()));
  page.on("pageerror", (error) => record("pageerror", error.message));
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
    // The shipped shell renders other popup triggers before the account menu
    // (the Sell dialog trigger precedes it in DOM order), so the trigger is
    // addressed by its accessible name, not by popup position.
    await page.getByRole("button", { name: "Account menu", exact: true }).first().click();
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

type FrameExpectation = {
  observable: string;
  sourceToken: string;
  cssProperty: string;
  mandatory: boolean;
  target: "input" | "block";
  declared: string;
  paintedOver: { sourceToken: string; declared: string; compositedDeclared: string } | null;
};

// Expectations are derived from the committed fixture, never from the probed
// document, and a translucent border carries its composite over the surface
// the same factory paints beneath it -- computed here, not transcribed. The
// expectation set is per surface (r4 F5): the Checkout surface binds only the
// variables-backed observables, the setup surface binds the full-rules
// contract including the conditional `.Block` border.
function frameExpectations(mode: ColorMode, surface: ProbeSurface): FrameExpectation[] {
  const paintedDeclared = candidateFixture[mode][paintedSurfaceSourceToken]!.candidate;

  const build = (
    entry: { observable: string; sourceToken: string; cssProperty: string },
    mandatory: boolean,
    target: "input" | "block",
  ): FrameExpectation => {
    const declared = candidateFixture[mode][entry.sourceToken]!.candidate;
    const composited = entry.cssProperty === "border-color" ? compositeOverOpaque(declared, paintedDeclared) : null;
    return {
      observable: entry.observable,
      sourceToken: entry.sourceToken,
      cssProperty: entry.cssProperty,
      mandatory,
      target,
      declared,
      paintedOver: composited
        ? { sourceToken: paintedSurfaceSourceToken, declared: paintedDeclared, compositedDeclared: composited }
        : null,
    };
  };

  if (surface === "checkout") {
    return checkoutMandatoryObservables.map((entry) => build(entry, true, "input"));
  }
  return [
    ...setupMandatoryObservables.map((entry) => build(entry, true, "input")),
    ...conditionalObservables.map((entry) => build(entry, true, "block")),
  ];
}

// Observations come from inside the provider's own iframe; expectations come
// from the committed fixture. The two are never read from the same document.
async function readFrameObservables(frame: FrameLocator, mode: ColorMode, surface: ProbeSurface) {
  return frame.locator('input[name="number"]').evaluate(
    (input: Element, payload: FrameExpectation[]) => {
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
      const transparent = (value: string) => !value || value === "transparent" || /,\s*0\s*\)$/.test(value);

      // The .Input appearance rule paints the field box and draws its border on
      // the same element, not on the bare <input>, so both are read from the
      // nearest ancestor that actually carries them.
      const nearest = (from: Element | null, matches: (style: CSSStyleDeclaration) => boolean) => {
        let node: Element | null = from;
        while (node) {
          if (matches(getComputedStyle(node))) return node;
          node = node.parentElement;
        }
        return null;
      };

      // A single `border: 1px solid X` shorthand paints all four edges, so the
      // four must agree; if they do not, the joined value is reported and the
      // observation mismatches rather than silently reading one edge.
      const borderColorOf = (node: Element) => {
        const style = getComputedStyle(node);
        const edges = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
        return edges.every((edge) => edge === edges[0]) ? (edges[0] ?? "") : edges.join(" | ");
      };

      const paintedInput = nearest(input, (style) => !transparent(style.backgroundColor));
      const borderedInput = nearest(
        input,
        (style) => style.borderTopStyle !== "none" && Number.parseFloat(style.borderTopWidth) > 0,
      );
      const block = document.querySelector(".Block");
      const borderedBlock = block
        ? nearest(block, (style) => style.borderTopStyle !== "none" && Number.parseFloat(style.borderTopWidth) > 0)
        : null;

      const measuredFrom = [
        `background=${paintedInput ? describeNode(paintedInput) : "none"}`,
        `border=${borderedInput ? describeNode(borderedInput) : "none"}`,
        `block=${borderedBlock ? describeNode(borderedBlock) : "not-rendered"}`,
      ].join(" ");

      const computedFor = (expectation: FrameExpectation) => {
        if (expectation.target === "block") {
          return borderedBlock ? borderColorOf(borderedBlock) : null;
        }
        if (expectation.cssProperty === "background-color") {
          return paintedInput
            ? getComputedStyle(paintedInput).backgroundColor
            : getComputedStyle(document.body).backgroundColor;
        }
        if (expectation.cssProperty === "border-color") {
          return borderedInput ? borderColorOf(borderedInput) : "";
        }
        return getComputedStyle(input).color;
      };

      // Normalise while the probe span is still attached: getComputedStyle on a
      // detached element does not resolve a colour.
      const observations = payload
        .map((expectation) => {
          const computed = computedFor(expectation);
          // A `.Block` the provider did not render produces no observation at
          // all; fabricating one would be evidence of something that never
          // happened.
          if (computed === null) return null;
          return {
            observable: expectation.observable,
            sourceToken: expectation.sourceToken,
            cssProperty: expectation.cssProperty,
            expected: normalise(expectation.declared),
            computed,
            mandatory: expectation.mandatory,
            paintedOver: expectation.paintedOver
              ? {
                  sourceToken: expectation.paintedOver.sourceToken,
                  expected: normalise(expectation.paintedOver.declared),
                  compositedExpected: normalise(expectation.paintedOver.compositedDeclared),
                }
              : undefined,
          };
        })
        .filter((observation): observation is NonNullable<typeof observation> => observation !== null);
      probe.remove();

      return { measuredFrom, observations };
    },
    frameExpectations(mode, surface),
  );
}

// Bounded synchronisation on the provider's own rendering within the existing
// budget: no new constant, no widened budget. The acceptance path matches
// almost immediately; a control that can never match spends the same budget
// and then records its mismatch rather than aborting.
async function awaitFrameObservables(frame: FrameLocator, mode: ColorMode, surface: ProbeSurface) {
  const deadline = Date.now() + embedReadyTimeoutMs;
  let latest = await readFrameObservables(frame, mode, surface);
  while (
    Date.now() < deadline &&
    latest.observations.some((observation) => observation.expected !== observation.computed)
  ) {
    // The sampling cadence is a fraction of the existing budget rather than a
    // new constant, and the loop is capped by that same budget.
    await new Promise((resolve) => setTimeout(resolve, embedReadyTimeoutMs / 120));
    latest = await readFrameObservables(frame, mode, surface);
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

// The selector the capture path crops to and enumerates around. The synthetic
// provider-free negative control serves a frame under this exact title so the
// production capture path is driven unmodified.
const captureFrameSelector = 'iframe[title="Secure payment input frame"]';

// Stripe's current Elements release can render more than one iframe under
// that title (the setup surface mounts an accessory frame beside the card
// form), so the title alone is ambiguous under strict mode. The probed and
// captured surface is the title match that actually hosts the card number
// input; the resolved index also aims the capture clip. Invocations that
// never resolve a frame (the provider-free battery's single synthetic frame)
// keep the first-match default.
let captureFrameIndex = 0;

async function resolveSecureCardInputFrame(page: Page): Promise<FrameLocator> {
  let matched = -1;
  await expect
    .poll(
      async () => {
        const handles = await page.locator(captureFrameSelector).elementHandles();
        for (let index = 0; index < handles.length; index += 1) {
          const frame = await handles[index]!.contentFrame();
          if (frame && (await frame.locator('input[name="number"]').count()) > 0) {
            matched = index;
            return true;
          }
        }
        return false;
      },
      {
        message: "no Secure payment input frame hosting the card number input appeared",
        timeout: embedReadyTimeoutMs,
      },
    )
    .toBe(true);
  captureFrameIndex = matched;
  return page.frameLocator(`${captureFrameSelector} >> nth=${matched}`);
}

// Runs inside a document. When a clip is given, only text whose rendered box
// intersects it counts; when null, the whole document's text counts -- used
// inside provider frames, where the frame's own box already intersected the
// capture clip and a conservative whole-frame enumeration fails closed.
// Enumerated text: text nodes, input/textarea values, and the
// placeholder/aria-label/title/alt attributes that render as visible text.
function collectDomText(payload: { frameSelector: string | null }): string[] {
  const texts: string[] = [];
  const clip = payload.frameSelector
    ? (document.querySelector(payload.frameSelector)?.getBoundingClientRect() ?? null)
    : null;
  const intersects = (rect: DOMRect) =>
    clip === null ||
    (rect.right > clip.left && rect.left < clip.right && rect.bottom > clip.top && rect.top < clip.bottom);
  const push = (value: string | null | undefined) => {
    if (value && value.trim()) texts.push(value);
  };

  for (const element of Array.from(document.querySelectorAll("*"))) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (!intersects(rect)) continue;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) push(element.value);
    push(element.getAttribute("placeholder"));
    push(element.getAttribute("aria-label"));
    push(element.getAttribute("title"));
    push(element.getAttribute("alt"));
  }

  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (intersects(rect)) push(node.nodeValue);
  }
  return texts;
}

// The pre-persistence authority for rendered text (settled r2 F4): rasterised
// text is compressed pixel data, so no byte scan can prove anything about it.
// Every visible string in the capture region -- in the top document, clipped
// to the frame's own client rect so both sides share one coordinate space, and
// inside every frame whose owner box intersects the capture clip (Playwright
// evaluates inside the cross-origin provider frame) -- is run through the
// retention guard before any image byte exists.
async function scanVisibleDomTextInClip(
  page: Page,
  captureBox: { x: number; y: number; width: number; height: number },
) {
  const hits: RetentionCategory[] = [];
  const scanAll = (texts: string[]) => {
    for (const text of texts) hits.push(...retentionGuard.scanText(text));
  };

  scanAll(await page.evaluate(collectDomText, { frameSelector: captureFrameSelector }));

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    let intersecting = true;
    try {
      const owner = await frame.frameElement();
      const ownerBox = await owner.boundingBox();
      intersecting =
        ownerBox !== null &&
        ownerBox.x < captureBox.x + captureBox.width &&
        ownerBox.x + ownerBox.width > captureBox.x &&
        ownerBox.y < captureBox.y + captureBox.height &&
        ownerBox.y + ownerBox.height > captureBox.y;
    } catch {
      // A frame whose owner element cannot be resolved is treated as
      // intersecting: the enumeration fails closed rather than assuming the
      // frame was outside the clip.
    }
    if (!intersecting) continue;
    // An evaluation error here propagates and fails the capture: a frame that
    // cannot be enumerated cannot be proven text-free.
    scanAll(await frame.evaluate(collectDomText, { frameSelector: null }));
  }
  return hits;
}

// Nothing outside the provider's own frame is retained: the crop is the
// redaction, because the buyer's identity, the account menu, and every page
// chrome affordance live outside it. Refusal is pre-persistence by
// construction and DOM-text-based: visible text in the clip is enumerated and
// scanned before the screenshot is even taken, a hit names categories only,
// and nothing is attached or written. Persistence is an explicit write under
// the resolved outputDir -- the governed evidence root under the dedicated
// config -- because reporter attachment is not the persistence mechanism.
async function captureRedactedScreenshot(page: Page, testInfo: TestInfo, moment: ProbeMoment["moment"]) {
  const frameElement = page.locator(captureFrameSelector).nth(captureFrameIndex);
  const box = await frameElement.boundingBox();
  expect(box, "the provider frame must be laid out before a cropped screenshot can be retained").not.toBeNull();

  const domTextHits = await scanVisibleDomTextInClip(page, box!);
  if (domTextHits.length > 0) {
    retentionScan.forbiddenMarkerHits += domTextHits.length;
    throw new Error(
      `visible DOM text inside the ${moment} capture clip matched retention categories ` +
        `${[...new Set(domTextHits)].sort().join(", ")}; nothing was captured, attached, or persisted for this ` +
        "moment and no receipt may be minted from this run",
    );
  }

  const maskedRegions = 0;
  const buffer = await page.screenshot({
    clip: { x: box!.x, y: box!.y, width: box!.width, height: box!.height },
  });

  retentionScan.imageArtifacts += 1;
  // Secondary layer only: this byte scan sees PNG text chunks and incidental
  // byte runs in the compressed stream. It can say nothing about rasterised
  // (pixel-encoded) text -- the DOM-text enumeration above is the authority
  // for that.
  const hits = retentionGuard.scanBuffer(buffer);
  if (hits.length > 0) {
    retentionScan.forbiddenMarkerHits += hits.length;
    throw new Error(
      `retained image artifact for ${moment} matched retention categories ${[...new Set(hits)].sort().join(", ")}; ` +
        "the screenshot was not attached and no receipt may be minted from this run",
    );
  }

  const capturePath = testInfo.outputPath(`${moment}.png`);
  mkdirSync(dirname(capturePath), { recursive: true });
  writeFileSync(capturePath, buffer);
  return { sha256: createHash("sha256").update(buffer).digest("hex"), maskedRegions };
}

async function recordMoment(
  page: Page,
  testInfo: TestInfo,
  moment: ProbeMoment["moment"],
  mode: ColorMode,
  frame: FrameLocator,
  consoleMessages: { type: string; text: string }[],
) {
  const surface: ProbeSurface = moment.startsWith("elements-") ? "checkout" : "setup";
  const { measuredFrom, observations } = await awaitFrameObservables(frame, mode, surface);
  const screenshot = await captureRedactedScreenshot(page, testInfo, moment);

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
    screenshotSha256: screenshot.sha256,
    screenshotClip: "stripe-frame",
    screenshotMaskedRegions: screenshot.maskedRegions,
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
  registerGovernedIdentifierFields(payment);
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
    await awaitPaymentReadable(page.request, paymentId);

    await page.goto(`/account/payments/${paymentId}`, { waitUntil: "domcontentloaded" });

    const embedContainer = page.getByTestId("payment-element-container");
    await expect(embedContainer).toBeVisible({ timeout: embedReadyTimeoutMs });
    await expect(page.getByTestId("payment-element-skeleton")).toHaveCount(0, { timeout: embedReadyTimeoutMs });

    const stripeFrame = await resolveSecureCardInputFrame(page);
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
    watchProviderIdentifierDeliveries(page);
    if (probeControlMode !== "injection-off") {
      // The invalid-value control attacks `--border`, which production never
      // sends to this variables-only surface (r4 F5) -- the demonstration that
      // the control bites lives in the setup probe, the only surface where the
      // border rules ship. The stylesheet is still registered identically so a
      // combined control invocation stays deterministic.
      await registerCandidateStylesheet(page, {
        invalidProperty: probeControlMode === "invalid-value" ? "--border" : null,
      });
    }

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpurchases");
    await signInWithPassword(page, new URL(page.url()).origin, { email: buyerEmail, password: buyerPassword });
    probeState.host = new URL(page.url()).origin;
    await registerSessionRetentionValues(page);

    const installDiagnostics = await readInstallDiagnostics(page);
    if (probeControlMode !== "injection-off") {
      expect(
        installDiagnostics.initErrors,
        "the document-start init script must install without error; a throwing init script silently reverts the whole probe to shipped values",
      ).toEqual([]);
    }

    const paymentId = await createProbePayment(page.request);
    await awaitPaymentReadable(page.request, paymentId);
    registerRuntimeRetentionValue(paymentId, "payment-reference");
    // Hash-only authority: the payment id is a payment marker, so the raw value
    // never reaches an annotation, a log line, the receipt, or the pull request.
    testInfo.annotations.push({ type: "probe-payment-id-sha256", description: redactedDigest(paymentId) });

    // The mount mode is deterministic whatever the buyer's stored preference
    // (the shipped default is `system`), and driving it before navigating is
    // what makes the control re-runs deterministic rather than order-dependent.
    // signInWithPassword mints the session cookie without navigating, so the
    // current document is still the signed-out sign-in page, which never
    // renders the account menu; load an authenticated document first.
    await page.goto("/account/purchases", { waitUntil: "domcontentloaded" });
    await driveColorMode(page, "light");

    await page.goto(`/account/payments/${paymentId}`, { waitUntil: "domcontentloaded" });
    const embedContainer = page.getByTestId("payment-element-container");
    await expect(embedContainer).toBeVisible({ timeout: embedReadyTimeoutMs });
    await expect(page.getByTestId("payment-element-skeleton")).toHaveCount(0, { timeout: embedReadyTimeoutMs });

    const stripeFrame = await resolveSecureCardInputFrame(page);
    await expect(stripeFrame.locator('input[name="number"]')).toBeVisible({ timeout: embedReadyTimeoutMs });

    await recordMoment(page, testInfo, "elements-mount-complete", "light", stripeFrame, consoleMessages);

    // The dark values reach Stripe only on the mode transition: the shipped
    // control mutates data-color-mode, observeStripeAppearance fires, and the
    // caller runs elements.update. A mount-only capture proves nothing here.
    await driveColorMode(page, "dark");
    await expect(embedContainer).toBeVisible({ timeout: embedReadyTimeoutMs });
    await recordMoment(page, testInfo, "elements-update-complete", "dark", stripeFrame, consoleMessages);

    if (probeControlMode === "injection-off") {
      // Discrimination is per observable and per surface (r4 F5): this test
      // proves it for the Checkout variables-only contract over its own two
      // lifecycle moments; the setup probe proves its full-rules contract.
      const checkoutMoments = probeState.moments.filter((moment) => moment.moment.startsWith("elements-"));
      for (const mandatory of checkoutMandatoryObservables) {
        const results = checkoutMoments.flatMap((moment) =>
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
    expect(
      rejections.map((message) => message.text),
      "Stripe rejected or could not parse an appearance value",
    ).toEqual([]);
  });

  test("mounts the shipped saved-payment setup card with the candidate Ink & Foil appearance injected at document start and proves Stripe accepts the full-rules payload at the completed mount and the completed update @stripe-embed-uat @stripe-appearance-probe @stripe-appearance-probe-setup", async ({
    page,
  }, testInfo) => {
    test.setTimeout(captureTimeoutMs + embedReadyTimeoutMs);
    test.skip(!runStripeEmbedUat, "Set STRIPE_EMBED_UAT=true to run the Stripe embed confirmation UAT.");
    test.skip(
      !buyerEmail || !buyerPassword,
      "MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD are required for the Stripe embed confirmation UAT.",
    );

    // (r4 F5) The setup surface needs no orders and adds no environment gate:
    // the shipped `add` form intent mints a SetupIntent-backed setup session
    // server-side, and StripeSetupCard mounts the Payment Element through
    // stripe.elements() with the full-rules appearance at mount and
    // elements.update on mode change. This probe never enters card details,
    // never confirms, and never saves an instrument; the leftover setup
    // session is recorded operator-side in the pull-request body as its
    // internal reference id only, never a provider `seti_` reference.
    const consoleMessages = watchConsole(page);
    watchProviderIdentifierDeliveries(page);
    if (probeControlMode !== "injection-off") {
      // The invalid-value control attacks `--border` on exactly this surface:
      // it is the one Stripe-reaching value that is not a plain hex, it is the
      // observable this probe exists to settle, and the setup surface is the
      // only surface production sends the border rules to (r4 F5) -- so the
      // control bites either through a captured Stripe rejection or through a
      // named border mismatch.
      await registerCandidateStylesheet(page, {
        invalidProperty: probeControlMode === "invalid-value" ? "--border" : null,
      });
    }

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpurchases");
    await signInWithPassword(page, new URL(page.url()).origin, { email: buyerEmail, password: buyerPassword });
    probeState.host = new URL(page.url()).origin;
    await registerSessionRetentionValues(page);

    const installDiagnostics = await readInstallDiagnostics(page);
    if (probeControlMode !== "injection-off") {
      expect(
        installDiagnostics.initErrors,
        "the document-start init script must install without error; a throwing init script silently reverts the whole probe to shipped values",
      ).toEqual([]);
    }

    // The mount mode is deterministic whatever the buyer's stored preference,
    // driven before navigating exactly as the Checkout probe drives it —
    // including the authenticated document load the account menu needs.
    await page.goto("/account/purchases", { waitUntil: "domcontentloaded" });
    await driveColorMode(page, "light");

    await page.goto("/account/payment-methods", { waitUntil: "domcontentloaded" });
    // The shipped `add` form intent is the exact production mechanism; nothing
    // synthetic touches the route or the setup-session API.
    await page.locator('button[name="intent"][value="add"]').first().click();

    const stripeFrame = await resolveSecureCardInputFrame(page);
    await expect(stripeFrame.locator('input[name="number"]')).toBeVisible({ timeout: embedReadyTimeoutMs });

    await recordMoment(page, testInfo, "setup-mount-complete", "light", stripeFrame, consoleMessages);

    // The dark values reach Stripe only on the mode transition: the shipped
    // control mutates data-color-mode, observeStripeAppearance fires, and the
    // setup card runs elements.update with the full-rules payload.
    await driveColorMode(page, "dark");
    await recordMoment(page, testInfo, "setup-update-complete", "dark", stripeFrame, consoleMessages);

    if (probeControlMode === "injection-off") {
      // Discrimination for the full-rules contract, per observable, over this
      // surface's own two lifecycle moments (r4 F5): `--border` and
      // `--surface-2` discriminate only here, because only here are they sent.
      const setupMoments = probeState.moments.filter((moment) => moment.moment.startsWith("setup-"));
      for (const mandatory of setupMandatoryObservables) {
        const results = setupMoments.flatMap((moment) =>
          moment.observations.filter((observation) => observation.observable === mandatory.observable),
        );
        expect
          .soft(
            results.some((observation) => !observation.matched),
            `injection-off control: ${mandatory.observable} produced no named failure at either setup lifecycle moment. ` +
              `The candidate value for ${mandatory.sourceToken} is byte-identical to the shipped value in both modes, so this ` +
              "observable is non-discriminating and an aggregate failure elsewhere cannot stand in for it.",
          )
          .toBe(true);
      }
    }

    const rejections = consoleMessages.filter((message) => stripeAppearanceRejectionPattern.test(message.text));
    if (probeControlMode === "invalid-value") {
      // The named invalid-border/provider-rejection control on the only
      // surface where the border is sent. Capture-and-fail-on-warning is one
      // shared code path, so this single demonstration covers both probes'
      // warning assertions.
      const borderFailures = probeState.moments.flatMap((moment) =>
        moment.observations.filter((observation) => observation.sourceToken === "--border" && !observation.matched),
      );
      expect(
        rejections.length > 0 || borderFailures.length > 0,
        "invalid-value control: the deliberately invalid --border value produced neither a captured Stripe rejection " +
          "naming it nor a named border observation failure at either setup lifecycle moment, so neither console capture " +
          `nor the border observable bites. Captured console traffic: ${JSON.stringify(consoleMessages)}`,
      ).toBe(true);
    }
    expect(
      rejections.map((message) => message.text),
      "Stripe rejected or could not parse an appearance value",
    ).toEqual([]);
  });

  // The receipt is emitted from the run itself, never asserted from the issue.
  // At @playwright/test 1.60 the worker-side `tags` merges title-embedded
  // @-tokens with declared tags, so the unmodified confirmation test and both
  // probes enter the accumulation, while a --grep @stripe-appearance-probe
  // control invocation collects only the probes and therefore refuses.
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
    if (probeState.collected.length < 3) {
      refusals.push(`collected ${probeState.collected.length} tagged tests, need at least 3`);
    }
    if (probeState.collected.some((entry) => entry.status === "skipped")) refusals.push("a collected test skipped");
    if (probeState.collected.some((entry) => entry.status !== "passed" || entry.errors > 0)) {
      refusals.push("a collected test did not pass cleanly");
    }
    const recorded = probeState.moments.map((moment) => moment.moment);
    for (const required of [
      "elements-mount-complete",
      "elements-update-complete",
      "setup-mount-complete",
      "setup-update-complete",
    ] as const) {
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
      sourceDigests: receiptSourceDigests(),
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
      retentionScan: { ...retentionScan, textualArtifacts: retentionScan.textualArtifacts + 1 },
      moments: probeState.moments,
      substitutionsApplied: [],
    };

    // The last gate before anything durable exists: the fully serialised
    // receipt is compared against the run's actual configured secrets and
    // buyer/session/order/payment markers. A hit refuses the artifact -- it
    // never redacts and writes anyway, and it never names the value it found.
    const serialised = `${JSON.stringify(receipt, null, 2)}\n`;
    const hits = retentionGuard.scanText(serialised);
    if (hits.length > 0) {
      console.log(
        `stripe appearance acceptance receipt refused: retained-artifact scan matched categories ${[...new Set(hits)]
          .sort()
          .join(", ")}`,
      );
      return;
    }

    writeFileSync(acceptanceReceiptPath, serialised);
    console.log(`stripe appearance acceptance receipt written to ${acceptanceReceiptPath}`);
  });
});

async function getJson(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.ok(), `${path} failed with ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

// The account payment page reads the payment server-side and renders a
// non-retrying recovery boundary on a 404, so navigating the instant the
// creation API returns can race the read-model projection and strand the test
// on the "Payment not found." panel. Wait for the same account read the page
// performs before navigating.
async function awaitPaymentReadable(request: APIRequestContext, paymentId: string) {
  await expect
    .poll(
      async () => (await request.get(`/api/marketplace/account/payments/${encodeURIComponent(paymentId)}`)).status(),
      {
        message: "created payment never became readable -- the account payment projection did not surface it",
        intervals: [500, 1_000, 2_000],
        timeout: embedReadyTimeoutMs,
      },
    )
    .toBe(200);
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

// ---------------------------------------------------------------------------
// Provider-free mechanism controls.
//
// Everything above needs a configured Stripe test-mode session and a deployed
// staging host. The two mechanisms it rests on -- that the candidate values are
// installed before the first page script observes anything, and that no
// retained artifact can carry a real marker -- are not provider facts, and a
// mechanism that only runs during an operator window is a mechanism nobody can
// regress safely. These cases run in an ordinary browser against a routed
// synthetic document with no network, no host, no credentials, and no provider.
//
// They carry neither @stripe-embed-uat nor @stripe-appearance-probe, so the
// evidence grep still collects exactly the two tagged tests, and they live in
// their own describe so the receipt accumulator never sees them. They add no
// skip condition and no timeout constant.
// ---------------------------------------------------------------------------

const syntheticProbeOrigin = "https://ink-foil-document-start.probe.invalid";
const syntheticProviderFrameTitle = "synthetic provider frame";
const syntheticObservedTokens = ["--surface-2", "--foreground", "--border"] as const;
const firstObservationGlobal = "__chaseInkFoilFirstInlineScriptObservation";

// The shipped values, in `@layer base` exactly as styles.css authors them, so
// the control reproduces the real precedence question rather than an easier one.
function shippedBaselineStylesheet() {
  const declarations = (pick: (name: (typeof syntheticObservedTokens)[number]) => string) =>
    syntheticObservedTokens.map((name) => `    ${name}: ${pick(name)};`).join("\n");
  const darkLiterals = syntheticObservedTokens
    .map((name) => `    --dark-${name.slice(2)}: ${candidateFixture.dark[name]!.shipped};`)
    .join("\n");
  const darkAliases = syntheticObservedTokens.map((name) => `    ${name}: var(--dark-${name.slice(2)});`).join("\n");

  return [
    "@layer base {",
    "  :root {",
    declarations((name) => candidateFixture.light[name]!.shipped),
    darkLiterals,
    "  }",
    '  [data-chase-theme][data-color-mode="dark"] {',
    darkAliases,
    "  }",
    "}",
  ].join("\n");
}

function syntheticProbeDocument(includeProviderFrame: boolean) {
  const names = JSON.stringify([...syntheticObservedTokens]);
  const frame = includeProviderFrame
    ? `<iframe title="${syntheticProviderFrameTitle}" src="${syntheticProbeOrigin}/provider-frame"></iframe>`
    : "";

  // The recording script is the first script in the document, so what it reads
  // is exactly "what the first page script observes".
  return [
    "<!doctype html>",
    '<html data-chase-theme data-color-mode="light">',
    "<head>",
    '<meta charset="utf-8">',
    `<style>${shippedBaselineStylesheet()}</style>`,
    "<script>",
    `window.${firstObservationGlobal} = (function () {`,
    "  var computed = getComputedStyle(document.documentElement);",
    "  var observation = {};",
    `  ${names}.forEach(function (name) { observation[name] = computed.getPropertyValue(name).trim(); });`,
    "  return observation;",
    "})();",
    "</script>",
    "</head>",
    `<body>${frame}</body>`,
    "</html>",
  ].join("\n");
}

async function routeSyntheticProbeDocuments(page: Page) {
  await page.route(`${syntheticProbeOrigin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: syntheticProbeDocument(pathname === "/document-start-with-provider-frame"),
    });
  });
}

function firstInlineScriptObservation(page: Page) {
  return page.evaluate(
    (global: string) => (window as unknown as Record<string, Record<string, string>>)[global] ?? {},
    firstObservationGlobal,
  );
}

function resolvedFromDocument(page: Page) {
  return page.evaluate(
    (names: string[]) => {
      const computed = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name).trim()]));
    },
    [...syntheticObservedTokens],
  );
}

// Unmistakably synthetic, never a real value, and never used to authenticate
// anything. They exist only to prove the retention scan bites.
const plantedSyntheticMarkers = {
  credential: "SYNTHETIC-PLANTED-CREDENTIAL-NOT-A-REAL-SECRET-0a1b2c",
  buyer: "SYNTHETIC-PLANTED-BUYER-IDENTITY-NOT-A-REAL-PERSON-3d4e5f",
};

function plantedMarkerGuard() {
  return createRetentionGuard([
    { value: plantedSyntheticMarkers.credential, category: "credential" },
    { value: plantedSyntheticMarkers.buyer, category: "buyer-identity" },
  ]);
}

test.describe("stripe appearance probe mechanism, provider-free", () => {
  test("installs the candidate values at document start, before the first page script observes anything", async ({
    page,
  }) => {
    await routeSyntheticProbeDocuments(page);
    await registerCandidateStylesheet(page);
    await page.goto(`${syntheticProbeOrigin}/document-start`);

    const diagnostics = await readInstallDiagnostics(page);
    expect(
      diagnostics.initErrors,
      "the document-start init script threw before installing; the previous mechanism dereferenced a null insertion point here and reverted the probe to shipped values",
    ).toEqual([]);

    const observed = await firstInlineScriptObservation(page);
    for (const name of syntheticObservedTokens) {
      const candidate = candidateFixture.light[name]!.candidate;
      const shipped = candidateFixture.light[name]!.shipped;
      const line = `first inline script observed ${name}: expected candidate ${candidate}, got ${observed[name]} (shipped is ${shipped})`;
      expect(observed[name], line).toBe(candidate);
      expect(observed[name], `${name} is non-discriminating: candidate and shipped are byte-identical`).not.toBe(
        shipped,
      );
    }

    // Both stages ran: the adopted sheet is what makes the first observation
    // deterministic, and the prescribed element installation completed without
    // ever dereferencing a missing insertion point.
    expect(diagnostics.installStages).toContain("adopted-stylesheet");
    expect(
      diagnostics.installStages.some((stage) => stage === "head-element" || stage === "document-element"),
      `no element installation stage recorded; stages were ${JSON.stringify(diagnostics.installStages)}`,
    ).toBe(true);
    expect(await page.locator(`style[${probeStyleMarkerAttribute}]`).count()).toBe(1);
  });

  test("leaves the shipped values in place when the document-start registration is suppressed", async ({ page }) => {
    await routeSyntheticProbeDocuments(page);
    await page.goto(`${syntheticProbeOrigin}/document-start`);

    const observed = await firstInlineScriptObservation(page);
    for (const name of syntheticObservedTokens) {
      expect(observed[name], `injection-off control: ${name} must resolve to the shipped value`).toBe(
        candidateFixture.light[name]!.shipped,
      );
    }
    expect(await page.locator(`style[${probeStyleMarkerAttribute}]`).count()).toBe(0);
  });

  test("cannot be replaced by post-load injection, which never reaches the first observation", async ({ page }) => {
    await routeSyntheticProbeDocuments(page);
    await page.goto(`${syntheticProbeOrigin}/document-start`);
    await page.addStyleTag({ content: candidateStylesheet() });

    const observed = await firstInlineScriptObservation(page);
    const resolved = await resolvedFromDocument(page);
    for (const name of syntheticObservedTokens) {
      expect(
        observed[name],
        `post-load injection control: ${name} was already observed as shipped before the tag was appended`,
      ).toBe(candidateFixture.light[name]!.shipped);
      expect(resolved[name], `post-load injection control: ${name} changed only after the observation`).toBe(
        candidateFixture.light[name]!.candidate,
      );
    }
  });

  test("moves to the candidate dark values on a mode transition", async ({ page }) => {
    await routeSyntheticProbeDocuments(page);
    await registerCandidateStylesheet(page);
    await page.goto(`${syntheticProbeOrigin}/document-start`);
    await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));

    const resolved = await resolvedFromDocument(page);
    for (const name of syntheticObservedTokens) {
      expect(resolved[name], `dark transition: ${name} must reach the candidate dark value`).toBe(
        candidateFixture.dark[name]!.candidate,
      );
    }
  });

  test("never moves to dark when the dark alias groups are omitted", async ({ page }) => {
    await routeSyntheticProbeDocuments(page);
    await registerCandidateStylesheet(page, { omitDarkAliases: true });
    await page.goto(`${syntheticProbeOrigin}/document-start`);
    await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));

    const resolved = await resolvedFromDocument(page);
    // The unlayered light `:root` rule outranks the shipped dark aliases, so
    // the document stays on the light candidate instead of reaching dark.
    expect(
      resolved["--surface-2"],
      "omitted-dark-alias control: the document reached a dark value without the alias groups, so the alias groups are not load-bearing",
    ).toBe(candidateFixture.light["--surface-2"]!.candidate);
    expect(resolved["--surface-2"]).not.toBe(candidateFixture.dark["--surface-2"]!.candidate);
  });

  test("installs only in the top-level document, never in a provider frame", async ({ page }) => {
    await routeSyntheticProbeDocuments(page);
    await registerCandidateStylesheet(page);
    await page.goto(`${syntheticProbeOrigin}/document-start-with-provider-frame`);

    const providerFrame = page.frameLocator(`iframe[title="${syntheticProviderFrameTitle}"]`);
    const insideFrame = await providerFrame.locator("body").evaluate(
      (body: Element, names: string[]) => {
        const computed = getComputedStyle(body.ownerDocument.documentElement);
        return {
          probeStyles: body.ownerDocument.querySelectorAll("style[data-chase-ink-foil-probe]").length,
          resolved: Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name).trim()])),
        };
      },
      [...syntheticObservedTokens],
    );

    expect(
      insideFrame.probeStyles,
      "the candidate stylesheet reached the provider frame; expectations and observations would then come from the same document",
    ).toBe(0);
    for (const name of syntheticObservedTokens) {
      expect(insideFrame.resolved[name], `provider frame must still resolve ${name} to the shipped value`).toBe(
        candidateFixture.light[name]!.shipped,
      );
    }
  });

  test("refuses an ungoverned resolved config shape, naming each ungoverned setting", async () => {
    // The exact shape a forgotten --config resolves: the shared config's HTML
    // reporter and retry telemetry, retained failure artifacts, CI retries,
    // and the global Playwright outputDir.
    const problems = ungovernedSettings({
      reporterNames: ["list", "retry-telemetry-reporter", "html"],
      outputDir: "D:\\repo\\artifacts\\playwright\\test-results",
      retries: 2,
      trace: "on-first-retry",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    });
    for (const setting of ["reporter:", "outputDir:", "retries:", "use.trace:", "use.screenshot:", "use.video:"]) {
      expect(
        problems.some((problem) => problem.startsWith(setting)),
        `the predicate did not name ${setting} among: ${problems.join("; ")}`,
      ).toBe(true);
    }
    expect(problems).toHaveLength(6);

    // The governed shape -- the dedicated evidence config's resolved settings,
    // wherever on disk the repository sits -- refuses nothing.
    expect(
      ungovernedSettings({
        reporterNames: ["list"],
        outputDir: "D:\\repo\\artifacts\\stripe-appearance-evidence\\test-results",
        retries: 0,
        trace: "off",
        screenshot: "off",
        video: "off",
      }),
    ).toEqual([]);
  });

  // (r4 F4) The five governed provider-identifier classes, each value
  // assembled at run time so no provider-key-shaped literal lands in the diff.
  // `tok_visa` is planted at Stripe's own test-token granularity precisely
  // because an over-tight suffix bound would miss it.
  const plantedProviderIdentifierClasses = [
    {
      label: "checkout session client secret",
      category: "credential",
      value: () => ["cs", "test", "SYNTHETICPLANTEDDOMTEXTNOTAREALSECRET"].join("_"),
    },
    {
      label: "provider event identifier",
      category: "payment-reference",
      value: () => ["evt", "SYNTHETICPLANTEDEVENT0001"].join("_"),
    },
    {
      label: "provider request identifier",
      category: "payment-reference",
      value: () => ["req", "SYNTHETICPLANTEDREQUEST0001"].join("_"),
    },
    {
      label: "payment-method token at tok_visa granularity",
      category: "payment-reference",
      value: () => ["tok", "visa"].join("_"),
    },
    {
      label: "processor payment reference",
      category: "payment-reference",
      value: () => ["pi", "SYNTHETICPLANTEDREFERENCE0001"].join("_"),
    },
  ] as const;

  for (const planted of plantedProviderIdentifierClasses) {
    test(`refuses a production capture whose clip contains a visible planted ${planted.label}, persisting nothing`, async ({
      page,
    }, testInfo) => {
      const plantedValue = planted.value();
      await page.route(`${syntheticProbeOrigin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body:
            pathname === "/capture-frame"
              ? `<!doctype html><html><body><p>${plantedValue}</p></body></html>`
              : `<!doctype html><html><body><iframe title="Secure payment input frame" src="${syntheticProbeOrigin}/capture-frame" style="width:320px;height:120px"></iframe></body></html>`,
        });
      });
      await page.goto(`${syntheticProbeOrigin}/capture-host`);

      const imageArtifactsBefore = retentionScan.imageArtifacts;
      const capturePath = testInfo.outputPath("elements-mount-complete.png");

      // The production capture path, driven unmodified: the refusal names
      // categories only and fires before any image byte exists.
      await expect(captureRedactedScreenshot(page, testInfo, "elements-mount-complete")).rejects.toThrow(
        new RegExp(
          `visible DOM text inside the elements-mount-complete capture clip matched retention categories .*${planted.category}`,
        ),
      );

      // Pre-persistence by construction: the screenshot was never taken,
      // nothing was attached, and the explicit-write target does not exist.
      expect(retentionScan.imageArtifacts, "the screenshot must be refused before it is taken").toBe(
        imageArtifactsBefore,
      );
      expect(testInfo.attachments.filter((attachment) => attachment.contentType === "image/png")).toEqual([]);
      expect(existsSync(capturePath)).toBe(false);
    });
  }

  test("refuses every governed provider identifier class in each durable artifact form, keeping redacted warnings retainable", async () => {
    // Shape-only detection must bite with zero configured values, per class
    // and per artifact form: text artifact, PNG byte stream, annotation
    // candidate, and scratch receipt candidate are refused; console text is
    // redacted by category and the sanitized warning stays retainable.
    const shapeOnlyGuard = createRetentionGuard([]);
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const planted of plantedProviderIdentifierClasses) {
      const value = planted.value();

      expect(shapeOnlyGuard.scanText(`probe log ${value}`), `text artifact scan missed ${planted.label}`).toContain(
        planted.category,
      );
      expect(
        shapeOnlyGuard.scanBuffer(Buffer.concat([pngSignature, Buffer.from(`tEXtComment ${value}`, "latin1")])),
        `image byte-stream scan missed ${planted.label}`,
      ).toContain(planted.category);
      expect(shapeOnlyGuard.scanText(`probe annotation ${value}`), `annotation scan missed ${planted.label}`).toContain(
        planted.category,
      );
      const scratchReceipt = JSON.stringify({
        moments: [{ consoleMessages: [{ type: "log", text: `probe log ${value}` }] }],
      });
      expect(shapeOnlyGuard.scanText(scratchReceipt), `scratch receipt scan missed ${planted.label}`).toContain(
        planted.category,
      );

      // A sanitized Stripe warning may legitimately carry a provider request
      // id; category redaction keeps the warning evidence retainable while the
      // identifier itself never survives.
      const { text, categories } = shapeOnlyGuard.redactText(
        `IntegrationError: Invalid value for appearance.rules['.Input'].border (${value})`,
      );
      expect(categories, `redaction categories missed ${planted.label}`).toContain(planted.category);
      expect(shapeOnlyGuard.scanText(text), `redaction left bytes the scan still matches for ${planted.label}`).toEqual(
        [],
      );
      expect(
        stripeAppearanceRejectionPattern.test(text),
        `redaction must preserve the Stripe warning evidence (${planted.label})`,
      ).toBe(true);
    }
  });

  test("registers browser-delivered provider identifiers from both governed endpoint families", async ({ page }) => {
    // (r4 F4) Endpoint-coverage control: a payments payload the browser
    // fetches, a setup-session payload from the payment-methods API family,
    // and an encoded-stream delivery the name-keyed walk cannot parse -- which
    // the shape-based registration must still bind. Unshaped values (a
    // fake-provider client secret, the internal setup reference) discriminate
    // name-keyed registration from shape matching; the streamed `seti_` value
    // discriminates the raw-text path.
    const syntheticPaymentSecret = ["synthetic", "fake", "provider", "client", "secret", "0001"].join("-");
    const syntheticEventId = ["evt", "SYNTHETICDELIVERED0001"].join("_");
    const syntheticSetupReference = ["seti", "SYNTHETICDELIVERED0001"].join("_");
    const syntheticSetupSecret = ["synthetic", "fake", "setup", "client", "secret", "0001"].join("-");
    const syntheticInternalSetupReference = ["synthetic", "internal", "setup", "reference", "0001"].join("-");
    const syntheticStreamedSetupReference = ["seti", "SYNTHETICSTREAMED0001"].join("_");

    await page.route(`${syntheticProbeOrigin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/marketplace/account/payments/synthetic-probe") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            payment_id: "synthetic-payment-0001",
            processor_client_secret: syntheticPaymentSecret,
            processor_payment_reference: ["pi", "SYNTHETICDELIVERED0001"].join("_"),
            provider_events: [{ provider_event_id: syntheticEventId }],
          }),
        });
        return;
      }
      if (pathname === "/api/marketplace/account/payment-methods/setup-sessions") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            setup_reference_id: syntheticInternalSetupReference,
            processor_setup_reference: syntheticSetupReference,
            processor_client_secret: syntheticSetupSecret,
          }),
        });
        return;
      }
      if (pathname === "/account/payment-methods.data") {
        await route.fulfill({
          status: 200,
          contentType: "text/x-script",
          body: `P${JSON.stringify(["setup", 1])}\n${JSON.stringify([syntheticStreamedSetupReference])}\n`,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><body>synthetic delivery host</body></html>",
      });
    });

    watchProviderIdentifierDeliveries(page);
    await page.goto(`${syntheticProbeOrigin}/delivery-host`);
    await page.evaluate(async () => {
      await fetch("/api/marketplace/account/payments/synthetic-probe");
      await fetch("/api/marketplace/account/payment-methods/setup-sessions", { method: "POST" });
      await fetch("/account/payment-methods.data", { method: "POST" });
    });

    // The response listeners read bodies asynchronously after the fetches
    // resolve, so the registration set is polled rather than read once.
    const expectedRegistrations: [string, RetentionCategory][] = [
      [syntheticPaymentSecret, "credential"],
      [syntheticEventId, "payment-reference"],
      [syntheticSetupReference, "payment-reference"],
      [syntheticSetupSecret, "credential"],
      [syntheticInternalSetupReference, "session-marker"],
      [syntheticStreamedSetupReference, "payment-reference"],
    ];
    await expect
      .poll(() =>
        expectedRegistrations
          .filter(
            ([value, category]) =>
              !runtimeRetentionValues.some((entry) => entry.value === value && entry.category === category),
          )
          .map(([value]) => value),
      )
      .toEqual([]);

    // The registered unshaped values now refuse a scratch artifact exactly as
    // a configured value would.
    expect(retentionGuard.scanText(`probe log ${syntheticPaymentSecret}`)).toContain("credential");
    expect(retentionGuard.scanText(`probe log ${syntheticInternalSetupReference}`)).toContain("session-marker");
  });

  test("refuses a textual artifact carrying a planted synthetic marker", async () => {
    const guard = plantedMarkerGuard();

    const plantedReceipt = JSON.stringify({
      moments: [{ consoleMessages: [{ type: "log", text: `probe log ${plantedSyntheticMarkers.credential}` }] }],
    });
    expect(guard.scanText(plantedReceipt)).toEqual(["credential"]);

    const plantedAnnotation = `probe annotation ${plantedSyntheticMarkers.buyer}`;
    expect(guard.scanText(plantedAnnotation)).toEqual(["buyer-identity"]);

    // Shape-only markers must bite with no configured value at all, so a run
    // that was given nothing to compare against still fails closed.
    const shapeOnlyGuard = createRetentionGuard([]);
    // Assembled at run time rather than written out: a committed literal in
    // provider-key shape is itself the hazard this control exists to catch, and
    // GitHub push protection refuses it -- correctly -- before it can land.
    const providerKeyShape = ["sk", "test", "SYNTHETICPLANTEDNOTAREALKEY"].join("_");
    const checkoutSessionSecretShape = ["cs", "test", "SYNTHETICPLANTEDNOTAREALSECRET"].join("_");
    const shapedMarkers = [
      "buyer-account-id=acct_SYNTHETICPLACEHOLDER password=synthetic-planted-passphrase",
      providerKeyShape,
      checkoutSessionSecretShape,
      "contact synthetic.planted@example.invalid",
      "pan 4242424242424242",
    ];
    for (const marker of shapedMarkers) {
      expect(shapeOnlyGuard.scanText(marker).length, `shape scan missed ${marker}`).toBeGreaterThan(0);
    }

    expect(guard.scanText('{"host":"https://marketplace.staging.chasesets.com","workers":1}')).toEqual([]);
  });

  test("refuses an image artifact carrying a planted synthetic marker", async () => {
    const guard = plantedMarkerGuard();
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const plantedTextChunk = Buffer.concat([
      pngSignature,
      Buffer.from(`tEXtComment ${plantedSyntheticMarkers.buyer}`, "latin1"),
    ]);
    expect(guard.scanBuffer(plantedTextChunk), "a marker in a PNG text chunk must refuse the attachment").toEqual([
      "buyer-identity",
    ]);

    const plantedWideChunk = Buffer.concat([pngSignature, Buffer.from(plantedSyntheticMarkers.credential, "utf16le")]);
    expect(guard.scanBuffer(plantedWideChunk), "a marker encoded as UTF-16 must refuse the attachment").toEqual([
      "credential",
    ]);

    const cleanImage = Buffer.concat([pngSignature, Buffer.from("tEXtComment ink-and-foil probe", "latin1")]);
    expect(guard.scanBuffer(cleanImage)).toEqual([]);
  });

  test("retains redacted provider warning evidence when the sample is otherwise clean", async () => {
    const guard = plantedMarkerGuard();
    const warning = "IntegrationError: Invalid value for appearance.rules['.Input'].border";

    const { text, categories } = guard.redactText(`${warning} (${plantedSyntheticMarkers.credential})`);
    expect(categories).toEqual(["credential"]);
    expect(guard.scanText(text), "redaction must leave nothing the scan still matches").toEqual([]);
    expect(
      stripeAppearanceRejectionPattern.test(text),
      "redaction must preserve the Stripe warning evidence the probe depends on",
    ).toBe(true);
    expect(text).toContain("appearance.rules");
  });
});
