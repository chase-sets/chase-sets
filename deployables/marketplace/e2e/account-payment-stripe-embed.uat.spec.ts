import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

// Retention controls preserve provider diagnostics while removing identifiers.
const stripeAppearanceRejectionPattern =
  /IntegrationError|Invalid value for|Unrecognized (?:appearance )?(?:variable|rule|property)|appearance\.(?:variables|rules)|Unsupported (?:CSS )?(?:value|property)/i;

// ---------------------------------------------------------------------------
// Retention-governance surface (settled r2 F4).
//
// Every invocation of this spec -- functional UAT, refusal, and the
// provider-free battery -- carries --config with the dedicated evidence
// config, which governs report, screenshot, video, trace, attachment, and
// .last-run.json output by construction: list reporter only, artifacts off,
// retries 0, governed outputDir. The guard below turns a configured or
// configured invocation under an ungoverned resolved config into a named
// refusal before sign-in, navigation, or any content capture. A forgotten
// --config cannot be made byte-free -- the runner itself writes its report
// and .last-run.json before any test code runs -- so the guarantee is a
// content-free early refusal, never "no framework bytes".
// ---------------------------------------------------------------------------

const governedEvidenceRoot = "artifacts/stripe-appearance-evidence/test-results";
const evidenceConfigRelativePath = "playwright.stripe-appearance-evidence.config.ts";

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
// configured (STRIPE_EMBED_UAT=true), an ungoverned
// resolved config is a hard failure naming each ungoverned setting -- never a
// skip. Unconfigured runs return here untouched and skip exactly as before.
test.beforeEach(async ({}, testInfo) => {
  if (!testInfo.tags.includes("@stripe-embed-uat")) return;
  if (!runStripeEmbedUat) return;
  const problems = ungovernedSettings(resolvedRetentionSettings(testInfo));
  expect(
    problems,
    `configured invocation under an ungoverned resolved config; every invocation of this spec must carry ` +
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
  for (const orderId of orderIds) push(orderId, "order-reference");
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    // Secret-by-name, plus any credential-shaped Stripe value whatever its
    // name. Non-secret UAT configuration is not a credential; shape patterns
    // still catch a real key wherever it appears.
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
// is an internal reference; provider `seti_` references remain forbidden.
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
const evidenceConfigRelativePath = "playwright.stripe-appearance-evidence.config.ts";

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
        // Stripe's accordion renderer lists the payment methods with no card
        // fields mounted until the buyer selects Card; drive that selection
        // exactly the way a buyer does, inside the provider's own frame.
        for (const handle of handles) {
          const frame = await handle.contentFrame();
          if (!frame) continue;
          const cardOption = frame
            .locator('button, [role="button"], [role="radio"], [role="tab"]')
            .filter({ hasText: /^Card$/ })
            .first();
          if ((await cardOption.count()) > 0 && (await cardOption.isVisible().catch(() => false))) {
            await cardOption.click().catch(() => {});
            break;
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
// `maskRects` (document-local) excludes only text whose rendered box lies
// entirely inside a region the capture path covers with an opaque overlay
// before any pixel exists; partial overlap still counts, failing closed.
function collectDomText(payload: {
  frameSelector: string | null;
  frameIndex?: number;
  maskRects?: { x: number; y: number; width: number; height: number }[];
}): string[] {
  const texts: string[] = [];
  const clip = payload.frameSelector
    ? (document.querySelectorAll(payload.frameSelector)[payload.frameIndex ?? 0]?.getBoundingClientRect() ?? null)
    : null;
  const intersects = (rect: DOMRect) =>
    clip === null ||
    (rect.right > clip.left && rect.left < clip.right && rect.bottom > clip.top && rect.top < clip.bottom);
  const masks = payload.maskRects ?? [];
  const maskEpsilonPx = 1;
  const masked = (rect: DOMRect) =>
    masks.some(
      (mask) =>
        rect.left >= mask.x - maskEpsilonPx &&
        rect.top >= mask.y - maskEpsilonPx &&
        rect.right <= mask.x + mask.width + maskEpsilonPx &&
        rect.bottom <= mask.y + mask.height + maskEpsilonPx,
    );
  const push = (value: string | null | undefined) => {
    if (value && value.trim()) texts.push(value);
  };

  for (const element of Array.from(document.querySelectorAll("*"))) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (!intersects(rect)) continue;
    if (masked(rect)) continue;
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
    if (intersects(rect) && !masked(rect)) push(node.nodeValue);
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
  captureFrameMaskRects: { x: number; y: number; width: number; height: number }[] = [],
) {
  const hits: RetentionCategory[] = [];
  const scanAll = (texts: string[]) => {
    for (const text of texts) hits.push(...retentionGuard.scanText(text));
  };

  scanAll(await page.evaluate(collectDomText, { frameSelector: captureFrameSelector, frameIndex: captureFrameIndex }));

  // The masks are frame-local coordinates inside the capture frame, so only
  // that frame's enumeration may consume them; every other frame stays on the
  // unmasked whole-document path.
  const captureFrameHandle = await page
    .locator(captureFrameSelector)
    .nth(captureFrameIndex)
    .elementHandle()
    .catch(() => null);
  const captureFrame = captureFrameHandle ? await captureFrameHandle.contentFrame() : null;

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
    scanAll(
      await frame.evaluate(collectDomText, {
        frameSelector: null,
        maskRects: frame === captureFrame ? captureFrameMaskRects : [],
      }),
    );
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
// Stripe's current checkout surface renders the buyer's contact email as a
// visible form field inside the provider frame itself, so the crop alone no
// longer excludes buyer identity. Every email-bearing form field in the
// capture frame is masked: an opaque overlay covers exactly that region
// before any pixel exists, the enumeration excludes only text lying entirely
// under an overlay before capture.
// Anything outside a mask still refuses on any hit.
async function resolveEmailFieldMaskRegions(page: Page) {
  const frameElement = page.locator(captureFrameSelector).nth(captureFrameIndex);
  const frameBox = await frameElement.boundingBox();
  const handle = await frameElement.elementHandle().catch(() => null);
  const frame = handle ? await handle.contentFrame() : null;
  if (!frame || !frameBox) return { frameLocal: [], viewport: [] };
  const frameLocal = await frame.evaluate(() => {
    const emailShape = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const regions: { x: number; y: number; width: number; height: number }[] = [];
    for (const element of Array.from(document.querySelectorAll("input, textarea"))) {
      const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : "";
      const placeholder = element.getAttribute("placeholder") ?? "";
      if (!emailShape.test(value) && !emailShape.test(placeholder)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        regions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    }
    return regions;
  });
  const viewport = frameLocal.map((region) => ({
    x: frameBox.x + region.x,
    y: frameBox.y + region.y,
    width: region.width,
    height: region.height,
  }));
  return { frameLocal, viewport };
}

const maskOverlayMarkerAttribute = "data-stripe-appearance-probe-mask-overlay";

async function withMaskOverlays<T>(
  page: Page,
  regions: { x: number; y: number; width: number; height: number }[],
  action: () => Promise<T>,
): Promise<T> {
  await page.evaluate(
    ({ overlayRegions, marker }) => {
      for (const region of overlayRegions) {
        const overlay = document.createElement("div");
        overlay.setAttribute(marker, "");
        overlay.style.cssText =
          `position:fixed;left:${region.x}px;top:${region.y}px;width:${region.width}px;` +
          `height:${region.height}px;background:#000;z-index:2147483647;pointer-events:none;`;
        document.body.append(overlay);
      }
    },
    { overlayRegions: regions, marker: maskOverlayMarkerAttribute },
  );
  try {
    return await action();
  } finally {
    await page.evaluate((marker) => {
      for (const element of Array.from(document.querySelectorAll(`[${marker}]`))) element.remove();
    }, maskOverlayMarkerAttribute);
  }
}

async function captureRedactedScreenshot(page: Page, testInfo: TestInfo, moment: "elements-mount-complete") {
  const frameElement = page.locator(captureFrameSelector).nth(captureFrameIndex);
  const box = await frameElement.boundingBox();
  expect(box, "the provider frame must be laid out before a cropped screenshot can be retained").not.toBeNull();

  const maskRegions = await resolveEmailFieldMaskRegions(page);

  const domTextHits = await scanVisibleDomTextInClip(page, box!, maskRegions.frameLocal);
  if (domTextHits.length > 0) {
    retentionScan.forbiddenMarkerHits += domTextHits.length;
    throw new Error(
      `visible DOM text inside the ${moment} capture clip matched retention categories ` +
        `${[...new Set(domTextHits)].sort().join(", ")}; nothing was captured, attached, or persisted for this ` +
        "moment",
    );
  }

  const maskedRegions = maskRegions.viewport.length;
  const buffer = await withMaskOverlays(page, maskRegions.viewport, () =>
    page.screenshot({
      clip: { x: box!.x, y: box!.y, width: box!.width, height: box!.height },
    }),
  );

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
        "the screenshot was not attached or persisted",
    );
  }

  const capturePath = testInfo.outputPath(`${moment}.png`);
  mkdirSync(dirname(capturePath), { recursive: true });
  writeFileSync(capturePath, buffer);
  return { sha256: createHash("sha256").update(buffer).digest("hex"), maskedRegions };
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

    watchProviderIdentifierDeliveries(page);
    watchConsole(page);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fpurchases");
    await signInWithPassword(page, new URL(page.url()).origin, { email: buyerEmail, password: buyerPassword });
    await registerSessionRetentionValues(page);

    const paymentId = await createPendingPayment(page.request);
    registerRuntimeRetentionValue(paymentId, "payment-reference");
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

    // With a known buyer email, Stripe pre-selects the Link save-my-info
    // opt-in, which makes a mobile phone number a required field and blocks
    // the confirm with "Please provide a mobile phone number." Decline it the
    // way a buyer does; card confirmation itself needs no Link enrollment.
    // The opt-in input is visually hidden behind the provider's styled label,
    // so a single forced click on the input can land outside the interactive
    // surface and silently not toggle -- drive the label (the provider's own
    // pointer target) and poll the input state until the decline sticks.
    const linkOptIn = stripeFrame.locator('input[name="linkOptIn"]');
    if ((await linkOptIn.count()) > 0 && (await linkOptIn.isChecked().catch(() => false))) {
      const linkOptInLabel = stripeFrame.locator('label[for="payment-linkOptInInput"]');
      await expect
        .poll(
          async () => {
            if (await linkOptIn.isChecked().catch(() => false)) {
              const target = (await linkOptInLabel.count()) > 0 ? linkOptInLabel : linkOptIn;
              await target.click({ force: true }).catch(() => {});
            }
            return linkOptIn.isChecked().catch(() => true);
          },
          {
            message: "the Link opt-in checkbox never unchecked, so the confirm would demand a mobile phone number",
            intervals: [250, 500, 1_000],
            timeout: embedReadyTimeoutMs,
          },
        )
        .toBe(false);
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
// Retention controls run against routed synthetic documents without a provider
// or credentials. They remain separate from the configured functional UAT and
// do not qualify provider appearance.
// ---------------------------------------------------------------------------

const syntheticProbeOrigin = "https://ink-foil-document-start.probe.invalid";

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

test.describe("stripe embed artifact safety, provider-free", () => {

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
