import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type FrameLocator,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { signInWithPassword } from "./support/auth";

// Manual staging UAT for issue #6699. Phase A lands this harness but mints no
// session artifact. Discovery and acceptance become truthful only after the
// Phase A merge commit is the deployed staging release; Phase B then runs the
// two tagged tests serially and commits their exact outputs.

const runConnectAppearanceUat = process.env.STRIPE_CONNECT_APPEARANCE_UAT === "true";
const sellerEmail = process.env.MARKETPLACE_E2E_SELLER_EMAIL?.trim() ?? "";
const sellerPassword = process.env.MARKETPLACE_E2E_SELLER_PASSWORD?.trim() ?? "";
const probeControlMode = process.env.STRIPE_APPEARANCE_PROBE_CONTROL?.trim() ?? "";
const connectInitializationTimeoutMs = 60_000;
const connectCaptureTimeoutMs = 180_000;

const probeEnvironmentVariableNames = [
  "STRIPE_CONNECT_APPEARANCE_UAT",
  "MARKETPLACE_E2E_SELLER_EMAIL",
  "MARKETPLACE_E2E_SELLER_PASSWORD",
];
const evidenceCommand =
  "pnpm exec playwright test --config playwright.stripe-appearance-evidence.config.ts --grep @connect-appearance-uat --workers=1";
const discoveryCommand =
  "pnpm exec playwright test --config playwright.stripe-appearance-evidence.config.ts --grep @connect-appearance-discovery --workers=1";
const acceptanceTestTitle =
  "proves the deployed Connect embedded surface accepts the candidate appearance at the completed initialisation and after the mode-change re-initialisation @connect-appearance-uat";

const qualifyingHost = "https://marketplace.staging.chasesets.com";
const payoutSetupPath = "/account/desk/settings?mode=manage";
const governedEvidenceRoot = "artifacts/stripe-appearance-evidence/test-results";
const candidateFixtureRelativePath = "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json";
const appearanceFactoryRelativePath = "packages/design-system/src/theme/stripe-appearance.ts";
const probeSpecRelativePath = "deployables/marketplace/e2e/payout-connect-appearance.uat.spec.ts";
const evidenceConfigRelativePath = "playwright.stripe-appearance-evidence.config.ts";
const discoverySchemaRelativePath =
  "packages/design-system/src/theme/__fixtures__/stripe-connect-discovery.schema.json";
const discoveryArtifactRelativePath = "packages/design-system/src/theme/__fixtures__/stripe-connect-discovery.json";
const acceptanceReceiptRelativePath =
  "packages/design-system/src/theme/__fixtures__/stripe-connect-acceptance-receipt.json";
const receiptSourceDigestPaths = [
  appearanceFactoryRelativePath,
  candidateFixtureRelativePath,
  probeSpecRelativePath,
  evidenceConfigRelativePath,
] as const;

function repositoryRoot() {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`Could not locate repository root from ${process.cwd()}`);
    candidate = parent;
  }
  return candidate;
}

const root = repositoryRoot();
const candidateFixtureBytes = readFileSync(join(root, candidateFixtureRelativePath));
const candidateFixture = JSON.parse(candidateFixtureBytes.toString("utf8")) as Record<
  "light" | "dark",
  Record<string, { candidate: string; shipped: string }>
>;
const candidateFixtureSha256 = createHash("sha256").update(candidateFixtureBytes).digest("hex");
const appearanceFactorySource = readFileSync(join(root, appearanceFactoryRelativePath), "utf8");
const discoverySchema = JSON.parse(readFileSync(join(root, discoverySchemaRelativePath), "utf8"));
const discoveryArtifactPath = join(root, discoveryArtifactRelativePath);
const acceptanceReceiptPath = join(root, acceptanceReceiptRelativePath);

const consumedTokenNames = (() => {
  const names = new Set<string>();
  for (const match of appearanceFactorySource.matchAll(/(?:pxToken|token)\(\s*"(--[\w-]+)"/g)) {
    names.add(match[1]!);
  }
  const snapshot = appearanceFactorySource.match(/const appearanceSnapshotTokens = \[([\s\S]*?)\] as const;/);
  if (!snapshot) throw new Error("appearanceSnapshotTokens array not found -- the derivation seam moved");
  for (const match of snapshot[1]!.matchAll(/"(--[\w-]+)"/g)) names.add(match[1]!);
  return [...names].sort();
})();

const connectSourcePropertyGroups = [
  {
    sourceToken: "--card",
    cssProperty: "background-color",
    minimum: true,
    sentinelColor: "#ff00ff",
    variables: ["colorBackground"],
  },
  {
    sourceToken: "--foreground",
    cssProperty: "color",
    minimum: true,
    sentinelColor: "#00ff00",
    variables: ["buttonSecondaryColorText", "colorText"],
  },
  {
    sourceToken: "--text-secondary",
    cssProperty: "color",
    minimum: false,
    sentinelColor: "#00ffff",
    variables: [
      "actionSecondaryColorText",
      "actionSecondaryTextDecorationColor",
      "badgeNeutralColorText",
      "colorSecondaryText",
      "formPlaceholderTextColor",
    ],
  },
  {
    sourceToken: "--surface-2",
    cssProperty: "background-color",
    minimum: false,
    sentinelColor: "#ffff00",
    variables: [
      "badgeNeutralColorBackground",
      "buttonSecondaryColorBackground",
      "formBackgroundColor",
      "offsetBackgroundColor",
    ],
  },
] as const;
const connectObservableNameSeparator = "::";

type ColorMode = "light" | "dark";
type ComponentMode = "account-onboarding" | "account-management";
type RetentionCategory = "credential" | "seller-identity" | "provider-reference" | "session-marker";
type RetentionValue = { value: string; category: RetentionCategory };
type RetentionScan = {
  textualArtifacts: number;
  imageArtifacts: number;
  redactionsApplied: number;
  forbiddenMarkerHits: number;
};
type RetentionGuard = {
  scanText: (text: string) => RetentionCategory[];
  redactText: (text: string) => { text: string; categories: RetentionCategory[] };
  scanBuffer: (buffer: Buffer) => RetentionCategory[];
};

const retentionShapePatterns: { category: RetentionCategory; pattern: RegExp }[] = [
  { category: "credential", pattern: /\b(?:sk|pk|rk|cs)_(?:test|live)_[A-Za-z0-9]{4,}/g },
  { category: "credential", pattern: /\bwhsec_[A-Za-z0-9]{4,}/g },
  { category: "credential", pattern: /\b(?:password|passwd|secret|api[-_]?key|apikey|bearer)\b\s*[=:]\s*\S+/gi },
  { category: "seller-identity", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    category: "provider-reference",
    pattern: /\b(?:pi|seti|pm|cus|acct|person|ch|py|src|sub|in)_[A-Za-z0-9]{4,}/g,
  },
  { category: "provider-reference", pattern: /\b(?:evt|req)_[A-Za-z0-9]{4,}/g },
  { category: "provider-reference", pattern: /\btok_[A-Za-z0-9][A-Za-z0-9_]{3,}/g },
  { category: "session-marker", pattern: /\b(?:session|sid|sess|csrf|xsrf)[-_]?(?:id|token)?\b\s*[=:]\s*\S+/gi },
];

function createRetentionGuard(configured: RetentionValue[]): RetentionGuard {
  const comparable = configured.filter((entry) => entry.value.length >= 6);
  const scan = (text: string) => {
    const categories = new Set<RetentionCategory>();
    for (const { category, pattern } of retentionShapePatterns) {
      if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text)) categories.add(category);
    }
    for (const entry of comparable) if (text.includes(entry.value)) categories.add(entry.category);
    return [...categories];
  };

  return {
    scanText: scan,
    redactText: (text) => {
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
    scanBuffer: (buffer) => {
      const categories = new Set<RetentionCategory>();
      for (const encoding of ["latin1", "utf8", "utf16le"] as const) {
        for (const category of scan(buffer.toString(encoding))) categories.add(category);
      }
      return [...categories];
    },
  };
}

function configuredRetentionValues(): RetentionValue[] {
  const values: RetentionValue[] = [];
  const push = (value: string | undefined, category: RetentionCategory) => {
    const trimmed = value?.trim();
    if (trimmed) values.push({ value: trimmed, category });
  };
  push(sellerEmail, "seller-identity");
  push(sellerPassword, "credential");
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/(?:SECRET|PASSWORD|PASSPHRASE|TOKEN|CREDENTIAL|PRIVATE_KEY|_KEY|APIKEY)$/.test(name)) {
      push(value, "credential");
    } else if (/^(?:sk|pk|rk|cs)_(?:test|live)_|^whsec_/.test(value)) {
      push(value, "credential");
    }
    const userinfo = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@/i);
    if (userinfo) push(userinfo[1], "credential");
  }
  return values;
}

const runtimeRetentionValues: RetentionValue[] = [];
let liveRetentionGuard = createRetentionGuard(configuredRetentionValues());
const liveRetentionScan: RetentionScan = {
  textualArtifacts: 0,
  imageArtifacts: 0,
  redactionsApplied: 0,
  forbiddenMarkerHits: 0,
};

function registerRuntimeRetentionValue(value: string | undefined | null, category: RetentionCategory) {
  const trimmed = value?.trim();
  if (!trimmed) return;
  if (!runtimeRetentionValues.some((entry) => entry.value === trimmed && entry.category === category)) {
    runtimeRetentionValues.push({ value: trimmed, category });
    liveRetentionGuard = createRetentionGuard([...configuredRetentionValues(), ...runtimeRetentionValues]);
  }
}

async function registerSessionRetentionValues(page: Page) {
  for (const cookie of await page.context().cookies()) {
    registerRuntimeRetentionValue(cookie.value, "session-marker");
  }
}

function watchConsole(page: Page) {
  const messages: { type: string; text: string }[] = [];
  const record = (type: string, text: string) => {
    const redacted = liveRetentionGuard.redactText(text);
    liveRetentionScan.textualArtifacts += 1;
    liveRetentionScan.redactionsApplied += redacted.categories.length;
    messages.push({ type, text: redacted.text });
  };
  page.on("console", (message) => record(message.type(), message.text()));
  page.on("pageerror", (error) => record("pageerror", error.message));
  return messages;
}

type ResolvedRetentionSettings = {
  reporterNames: string[];
  outputDir: string;
  retries: number;
  trace: unknown;
  screenshot: unknown;
  video: unknown;
};

export function ungovernedSettings(resolved: ResolvedRetentionSettings): string[] {
  const problems: string[] = [];
  if (resolved.reporterNames.join(",") !== "list") {
    problems.push(`reporter: must be exactly the list reporter, resolved [${resolved.reporterNames.join(", ")}]`);
  }
  if (!resolved.outputDir.replace(/\\/g, "/").endsWith(governedEvidenceRoot)) {
    problems.push(`outputDir: must resolve to ${governedEvidenceRoot}, resolved ${resolved.outputDir}`);
  }
  if (resolved.retries !== 0) problems.push(`retries: must be 0, resolved ${resolved.retries}`);
  for (const [name, mode] of [
    ["trace", resolved.trace],
    ["screenshot", resolved.screenshot],
    ["video", resolved.video],
  ] as const) {
    if (mode !== "off") problems.push(`use.${name}: must be "off", resolved ${JSON.stringify(mode)}`);
  }
  return problems;
}

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

test.beforeEach(async ({}, testInfo) => {
  if (!testInfo.title.includes("@connect-appearance-")) return;
  if (!runConnectAppearanceUat && !probeControlMode) return;
  const problems = ungovernedSettings(resolvedRetentionSettings(testInfo));
  expect(
    problems,
    `configured or control-mode Connect invocation must carry --config ${evidenceConfigRelativePath}; ` +
      `ungoverned settings: ${problems.join("; ")}`,
  ).toEqual([]);
});

function resolvedHost(testInfo: TestInfo) {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string" || baseURL.length === 0) {
    throw new Error("Connect probe populated-target failure: the resolved Playwright baseURL is empty");
  }
  const origin = new URL(baseURL).origin;
  if (origin !== qualifyingHost) {
    throw new Error(`Connect probe host ${origin} is not the sole qualifying host ${qualifyingHost}`);
  }
  return origin;
}

function receiptSourceDigests() {
  return Object.fromEntries(
    receiptSourceDigestPaths.map((relativePath) => [
      relativePath,
      createHash("sha256")
        .update(readFileSync(join(root, relativePath)))
        .digest("hex"),
    ]),
  );
}

function implementationHead() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`implementation head is not a 40-character sha: ${head}`);
  return head;
}

function deployedRunId(head: string) {
  const runs = JSON.parse(
    execFileSync(
      "gh",
      [
        "run",
        "list",
        "--repo",
        "chase-sets/chase-sets",
        "--workflow",
        "platform-production.yml",
        "--commit",
        head,
        "--status",
        "completed",
        "--limit",
        "20",
        "--json",
        "databaseId,headSha,conclusion",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  ) as { databaseId: number; headSha: string; conclusion: string }[];
  const candidate = runs.find((run) => run.headSha === head && run.conclusion === "success");
  if (!candidate) throw new Error(`no successful Platform Deploy run resolves the implementation head ${head}`);
  const jobs = JSON.parse(
    execFileSync(
      "gh",
      ["run", "view", String(candidate.databaseId), "--repo", "chase-sets/chase-sets", "--json", "jobs"],
      { cwd: root, encoding: "utf8" },
    ),
  ) as { jobs: { name: string; conclusion: string }[] };
  const staging = jobs.jobs.find((job) => job.name === "Deploy Staging");
  if (staging?.conclusion !== "success") {
    throw new Error(`Platform Deploy run ${candidate.databaseId} does not carry a green Deploy Staging job`);
  }
  return String(candidate.databaseId);
}

function candidateStylesheet(invalidProperty: string | null = null) {
  const names = Object.keys(candidateFixture.light);
  const value = (name: string, mode: ColorMode) =>
    name === invalidProperty ? "chase-sets-not-a-colour" : candidateFixture[mode][name]!.candidate;
  const darkDiffering = names.filter(
    (name) => candidateFixture.light[name]!.candidate !== candidateFixture.dark[name]!.candidate,
  );
  const lightSelectors = [
    ":root",
    '[data-theme="light"]',
    '[data-chase-theme][data-color-mode="light"]',
    '[data-chase-theme-scope][data-color-mode="light"]',
  ].join(",\n");
  const darkSelectors = [
    '[data-theme="dark"]',
    '[data-chase-theme][data-color-mode="dark"]',
    '[data-chase-theme-scope][data-color-mode="dark"]',
  ].join(",\n");
  const darkDeclarations = names
    .map((name) =>
      darkDiffering.includes(name) ? `  ${name}: var(--dark-${name.slice(2)});` : `  ${name}: ${value(name, "dark")};`,
    )
    .join("\n");
  return [
    `${lightSelectors} {\n${names.map((name) => `  ${name}: ${value(name, "light")};`).join("\n")}\n}`,
    `:root {\n${darkDiffering.map((name) => `  --dark-${name.slice(2)}: ${value(name, "dark")};`).join("\n")}\n}`,
    `${darkSelectors} {\n${darkDeclarations}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${darkDeclarations}\n  }\n}`,
  ].join("\n\n");
}

function sentinelStylesheet(sourceToken: string, sentinelColor: string) {
  return (
    [
      ":root",
      '[data-theme="light"]',
      '[data-theme="dark"]',
      '[data-chase-theme][data-color-mode="light"]',
      '[data-chase-theme][data-color-mode="dark"]',
      '[data-chase-theme-scope][data-color-mode="light"]',
      '[data-chase-theme-scope][data-color-mode="dark"]',
    ].join(",\n") + ` {\n  ${sourceToken}: ${sentinelColor};\n}`
  );
}

async function installDocumentStartStylesheet(context: BrowserContext, css: string) {
  await context.addInitScript((stylesheet: string) => {
    if (window.top !== window.self) return;
    const install = () => {
      const parent = document.head ?? document.documentElement;
      if (!parent || parent.querySelector("style[data-chase-connect-appearance-probe]")) return Boolean(parent);
      const style = document.createElement("style");
      style.setAttribute("data-chase-connect-appearance-probe", "");
      style.textContent = stylesheet;
      parent.append(style);
      return true;
    };
    try {
      if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in document) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(stylesheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
    } catch {
      // The DOM style below is the portable installation path.
    }
    if (install()) return;
    const observer = new MutationObserver(() => {
      if (install()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => install(), { once: true });
  }, css);
}

type ConnectTarget = {
  componentMode: ComponentMode;
  frameSelector: string;
  frame: FrameLocator;
};

async function resolveConnectTarget(page: Page): Promise<ConnectTarget> {
  const container = page.getByTestId("stripe-connect-embedded-component");
  const componentSelector = "stripe-connect-account-onboarding, stripe-connect-account-management";
  try {
    await expect
      .poll(
        async () => {
          const components = container.locator(componentSelector);
          const componentCount = await components.count();
          const iframeCount = componentCount === 1 ? await components.first().locator("iframe").count() : 0;
          return { componentCount, iframeCount };
        },
        { timeout: connectInitializationTimeoutMs },
      )
      .toEqual({ componentCount: 1, iframeCount: 1 });
  } catch (error) {
    const state = (await container.count()) === 0 ? "container-missing" : (await container.innerText()).trim();
    throw new Error(
      `Connect populated-target failure: expected exactly one initialised custom element and one iframe; state=${JSON.stringify(state)}; ${String(error)}`,
    );
  }

  const component = container.locator(componentSelector).first();
  const tagName = await component.evaluate((element) => element.tagName.toLowerCase());
  const componentMode = tagName.replace("stripe-connect-", "") as ComponentMode;
  if (!(["account-onboarding", "account-management"] as string[]).includes(componentMode)) {
    throw new Error(`Connect populated-target failure: unexpected component mode ${componentMode}`);
  }
  const frameSelector = `[data-testid="stripe-connect-embedded-component"] stripe-connect-${componentMode} iframe`;
  const count = await page.locator(frameSelector).count();
  if (count !== 1) throw new Error(`Connect frame resolution failure: ${frameSelector} resolved ${count} iframes`);
  return { componentMode, frameSelector, frame: page.frameLocator(frameSelector) };
}

async function driveColorMode(page: Page, mode: ColorMode) {
  const rootElement = page.locator("[data-chase-theme]").first();
  await expect(rootElement).toBeVisible();
  if ((await rootElement.getAttribute("data-color-mode")) === mode) return;
  const choice = page.locator(`input[data-theme-choice="${mode}"]`);
  if ((await choice.count()) === 0) {
    await page.getByRole("button", { name: "Account menu", exact: true }).first().click();
  }
  await page.locator(`label:has(input[data-theme-choice="${mode}"])`).first().click();
  await expect(rootElement).toHaveAttribute("data-color-mode", mode);
  await page.keyboard.press("Escape");
}

type FrameStyle = { selectorPath: string; color: string; backgroundColor: string };

async function readFrameStyles(frame: FrameLocator): Promise<FrameStyle[]> {
  return frame.locator("body").evaluate((body) => {
    const selectorPath = (element: Element) => {
      if (element === document.body) return "body";
      const segments: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body) {
        const parent: Element | null = current.parentElement;
        const siblings: Element[] = parent
          ? Array.from(parent.children).filter((sibling: Element) => sibling.tagName === current!.tagName)
          : [];
        const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
        segments.unshift(`${current.tagName.toLowerCase()}${suffix}`);
        current = parent;
      }
      return `body > ${segments.join(" > ")}`;
    };
    return [body, ...Array.from(body.querySelectorAll("*"))]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          selectorPath: selectorPath(element),
          color: style.color,
          backgroundColor: style.backgroundColor,
        };
      });
  });
}

function normaliseCssColor(value: string) {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const number = Number.parseInt(hex[1]!, 16);
    return `rgb(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255})`;
  }
  return value.replace(/\s+/g, " ").replace(/,\s*/g, ", ").trim().toLowerCase();
}

async function resolvedTokensFromDocument(page: Page) {
  return page.evaluate((names: string[]) => {
    const root = document.querySelector("[data-chase-theme]") ?? document.documentElement;
    const style = getComputedStyle(root);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
  }, consumedTokenNames);
}

function assertionObservable(variable: string, selectorPath: string, cssProperty: string) {
  return [variable, selectorPath, cssProperty].join(connectObservableNameSeparator);
}

type DiscoveryElement = {
  selectorPath: string;
  cssProperty: "background-color" | "color";
  before: string;
  after: string;
};
type DiscoveryGroup = {
  variables: string[];
  sentinelColor: string;
  elements: DiscoveryElement[];
};
type DiscoveryArtifact = {
  schemaVersion: "stripe-connect-discovery/v1";
  sessionNonce: string;
  implementationHead: string;
  deployRunId: string;
  host: string;
  capturedAt: string;
  componentMode: ComponentMode;
  frameSelector: string;
  environmentVariableNames: string[];
  fixtureSha256: string;
  sourceDigests: Record<string, string>;
  retentionScan: RetentionScan;
  groups: Record<string, DiscoveryGroup>;
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.join("|") === wanted.join("|")
    ? []
    : [`${path} keys must be exactly ${wanted.join(", ")}; got ${actual.join(", ")}`];
}

function discoveryShapeViolations(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return ["discovery artifact must be an object"];
  const artifact = value as Record<string, unknown>;
  problems.push(
    ...exactKeys(
      artifact,
      [
        "schemaVersion",
        "sessionNonce",
        "implementationHead",
        "deployRunId",
        "host",
        "capturedAt",
        "componentMode",
        "frameSelector",
        "environmentVariableNames",
        "fixtureSha256",
        "sourceDigests",
        "retentionScan",
        "groups",
      ],
      "discovery",
    ),
  );
  if (artifact.schemaVersion !== "stripe-connect-discovery/v1") problems.push("discovery.schemaVersion is invalid");
  if (typeof artifact.sessionNonce !== "string" || !/^[0-9a-f]{32}$/.test(artifact.sessionNonce)) {
    problems.push("discovery.sessionNonce must be 32 lowercase hex characters");
  }
  if (typeof artifact.implementationHead !== "string" || !/^[0-9a-f]{40}$/.test(artifact.implementationHead)) {
    problems.push("discovery.implementationHead must be 40 lowercase hex characters");
  }
  if (typeof artifact.deployRunId !== "string" || !/^[1-9][0-9]{0,19}$/.test(artifact.deployRunId)) {
    problems.push("discovery.deployRunId must be a bounded positive numeric string");
  }
  if (artifact.host !== qualifyingHost) problems.push(`discovery.host must be ${qualifyingHost}`);
  if (
    typeof artifact.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(artifact.capturedAt)
  ) {
    problems.push("discovery.capturedAt must be a timezone-bearing instant");
  }
  if (!(artifact.componentMode === "account-onboarding" || artifact.componentMode === "account-management")) {
    problems.push("discovery.componentMode is invalid");
  }
  if (typeof artifact.frameSelector !== "string" || artifact.frameSelector.length === 0) {
    problems.push("discovery.frameSelector must be non-empty");
  }
  if (!Array.isArray(artifact.environmentVariableNames)) {
    problems.push("discovery.environmentVariableNames must be an array");
  } else {
    const names = artifact.environmentVariableNames;
    if (
      names.length !== 3 ||
      new Set(names).size !== names.length ||
      names.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))
    ) {
      problems.push("discovery.environmentVariableNames must contain exactly three unique environment names");
    }
  }
  if (typeof artifact.fixtureSha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.fixtureSha256)) {
    problems.push("discovery.fixtureSha256 must be a sha256");
  }
  const sourceDigests = artifact.sourceDigests;
  if (typeof sourceDigests !== "object" || sourceDigests === null || Array.isArray(sourceDigests)) {
    problems.push("discovery.sourceDigests must be an object");
  } else {
    const entries = Object.entries(sourceDigests);
    if (
      entries.length < 3 ||
      entries.some(
        ([path, digest]) =>
          !/^[a-z0-9][a-z0-9/._-]*\.(?:ts|json)$/.test(path) ||
          typeof digest !== "string" ||
          !/^[0-9a-f]{64}$/.test(digest),
      )
    ) {
      problems.push("discovery.sourceDigests must contain at least three path-bound sha256 values");
    }
  }
  const retentionScan = artifact.retentionScan;
  if (typeof retentionScan !== "object" || retentionScan === null || Array.isArray(retentionScan)) {
    problems.push("discovery.retentionScan must be an object");
  } else {
    const scan = retentionScan as Record<string, unknown>;
    problems.push(
      ...exactKeys(
        scan,
        ["textualArtifacts", "imageArtifacts", "redactionsApplied", "forbiddenMarkerHits"],
        "discovery.retentionScan",
      ),
    );
    for (const [name, minimum] of [
      ["textualArtifacts", 1],
      ["imageArtifacts", 0],
      ["redactionsApplied", 0],
    ] as const) {
      const count = scan[name];
      if (!Number.isInteger(count) || (count as number) < minimum || (count as number) > 2_147_483_647) {
        problems.push(`discovery.retentionScan.${name} must be an integer from ${minimum} through 2147483647`);
      }
    }
    if (scan.forbiddenMarkerHits !== 0) {
      problems.push("discovery.retentionScan.forbiddenMarkerHits must be zero");
    }
  }
  const groups = artifact.groups;
  if (typeof groups !== "object" || groups === null || Array.isArray(groups)) {
    problems.push("discovery.groups must be an object");
  } else {
    const groupRecord = groups as Record<string, unknown>;
    for (const descriptor of connectSourcePropertyGroups) {
      const group = groupRecord[descriptor.sourceToken];
      if (group === undefined) {
        if (descriptor.minimum) problems.push(`discovery.groups is missing minimum source ${descriptor.sourceToken}`);
        continue;
      }
      if (typeof group !== "object" || group === null || Array.isArray(group)) {
        problems.push(`discovery.groups.${descriptor.sourceToken} must be an object`);
        continue;
      }
      const record = group as Record<string, unknown>;
      problems.push(
        ...exactKeys(record, ["variables", "sentinelColor", "elements"], `groups.${descriptor.sourceToken}`),
      );
      if (
        !Array.isArray(record.variables) ||
        [...record.variables].sort().join("|") !== [...descriptor.variables].sort().join("|")
      ) {
        problems.push(`groups.${descriptor.sourceToken}.variables does not match the factory group`);
      }
      if (record.sentinelColor !== descriptor.sentinelColor) {
        problems.push(`groups.${descriptor.sourceToken}.sentinelColor does not match the settled sentinel`);
      }
      if (!Array.isArray(record.elements) || record.elements.length === 0) {
        problems.push(`groups.${descriptor.sourceToken}.elements must record at least one moved element`);
      } else {
        for (const [index, element] of record.elements.entries()) {
          if (typeof element !== "object" || element === null || Array.isArray(element)) {
            problems.push(`groups.${descriptor.sourceToken}.elements[${index}] must be an object`);
            continue;
          }
          const entry = element as Record<string, unknown>;
          problems.push(
            ...exactKeys(
              entry,
              ["selectorPath", "cssProperty", "before", "after"],
              `groups.${descriptor.sourceToken}.elements[${index}]`,
            ),
          );
          if (entry.cssProperty !== descriptor.cssProperty) {
            problems.push(`groups.${descriptor.sourceToken}.elements[${index}].cssProperty is wrong`);
          }
          for (const name of ["selectorPath", "before", "after"] as const) {
            if (typeof entry[name] !== "string" || entry[name].length === 0) {
              problems.push(`groups.${descriptor.sourceToken}.elements[${index}].${name} must be non-empty`);
            }
          }
        }
      }
    }
    const allowed = new Set<string>(connectSourcePropertyGroups.map((descriptor) => descriptor.sourceToken));
    for (const name of Object.keys(groupRecord))
      if (!allowed.has(name)) problems.push(`discovery.groups has unknown source ${name}`);
  }
  return problems;
}

function boundDiscoveryViolations(
  bytes: Buffer,
  expected: { head: string; host: string; acceptanceStartedAt: string },
): { artifact: DiscoveryArtifact | null; problems: string[] } {
  let artifact: DiscoveryArtifact;
  try {
    artifact = JSON.parse(bytes.toString("utf8")) as DiscoveryArtifact;
  } catch {
    return { artifact: null, problems: ["discovery artifact is not valid JSON"] };
  }
  const problems = discoveryShapeViolations(artifact);
  if (artifact.implementationHead !== expected.head) problems.push("discovery implementationHead binding is stale");
  if (artifact.host !== expected.host) problems.push("discovery host binding is stale");
  if (artifact.fixtureSha256 !== candidateFixtureSha256) problems.push("discovery fixtureSha256 binding is stale");
  if (Date.parse(artifact.capturedAt) > Date.parse(expected.acceptanceStartedAt)) {
    problems.push("discovery capturedAt is newer than the acceptance run start");
  }
  const expectedNames = [...probeEnvironmentVariableNames].sort().join("|");
  if ([...(artifact.environmentVariableNames ?? [])].sort().join("|") !== expectedNames) {
    problems.push("discovery environmentVariableNames binding is stale");
  }
  const expectedDigests = receiptSourceDigests();
  const digestEntries = (digests: unknown) =>
    typeof digests !== "object" || digests === null || Array.isArray(digests)
      ? "<invalid>"
      : Object.entries(digests)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, digest]) => `${path}:${digest}`)
          .join("|");
  if (digestEntries(artifact.sourceDigests) !== digestEntries(expectedDigests)) {
    problems.push("discovery sourceDigests binding is stale");
  }
  return { artifact, problems };
}

function readBoundDiscoveryArtifactAt(
  path: string,
  displayPath: string,
  expected: { head: string; host: string; acceptanceStartedAt: string },
) {
  if (!existsSync(path)) {
    throw new Error(`Connect discovery binding missing at ${displayPath}`);
  }
  const bytes = readFileSync(path);
  const result = boundDiscoveryViolations(bytes, expected);
  if (!result.artifact || result.problems.length > 0) {
    throw new Error(`Connect discovery binding stale or invalid: ${result.problems.join("; ")}`);
  }
  return { artifact: result.artifact, bytes };
}

function readBoundDiscoveryArtifact(expected: { head: string; host: string; acceptanceStartedAt: string }) {
  return readBoundDiscoveryArtifactAt(discoveryArtifactPath, discoveryArtifactRelativePath, expected);
}

async function signInSeller(page: Page, host: string) {
  await signInWithPassword(page, host, { email: sellerEmail, password: sellerPassword });
  await registerSessionRetentionValues(page);
}

async function frameTextMaskSelectors(frame: FrameLocator) {
  return frame.locator("body").evaluate((body) => {
    const selectorPath = (element: Element) => {
      if (element === document.body) return "body";
      const segments: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body) {
        const parent: Element | null = current.parentElement;
        const siblings: Element[] = parent
          ? Array.from(parent.children).filter((sibling: Element) => sibling.tagName === current!.tagName)
          : [];
        const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
        segments.unshift(`${current.tagName.toLowerCase()}${suffix}`);
        current = parent;
      }
      return `body > ${segments.join(" > ")}`;
    };
    return [body, ...Array.from(body.querySelectorAll("*"))]
      .filter((element) => {
        const directText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .trim();
        if (!directText) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map(selectorPath);
  });
}

async function captureFrameScreenshot(frame: FrameLocator, testInfo: TestInfo, moment: string) {
  const selectorPaths = [...new Set(await frameTextMaskSelectors(frame))];
  const masks: Locator[] = selectorPaths.map((selector) => frame.locator(selector));
  const buffer = await frame.locator("body").screenshot({
    animations: "disabled",
    caret: "hide",
    mask: masks,
  });
  liveRetentionScan.imageArtifacts += 1;
  liveRetentionScan.redactionsApplied += masks.length;
  const hits = liveRetentionGuard.scanBuffer(buffer);
  if (hits.length > 0) {
    liveRetentionScan.forbiddenMarkerHits += hits.length;
    throw new Error(
      `retained Connect frame image for ${moment} matched ${[...new Set(hits)].sort().join(", ")}; no receipt may be emitted`,
    );
  }
  await testInfo.attach(`${moment}.png`, { body: buffer, contentType: "image/png" });
  return {
    screenshotSha256: createHash("sha256").update(buffer).digest("hex"),
    screenshotClip: "stripe-frame" as const,
    screenshotMaskedRegions: masks.length,
  };
}

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
  moment: "connect-mount-complete" | "connect-update-complete";
  colorMode: ColorMode;
  resolvedTokens: Record<string, string>;
  observations: ProbeObservation[];
  consoleMessages: { type: string; text: string }[];
  screenshotSha256: string;
  screenshotClip: "stripe-frame";
  screenshotMaskedRegions: number;
};

async function captureMoment(
  page: Page,
  target: ConnectTarget,
  artifact: DiscoveryArtifact,
  mode: ColorMode,
  moment: ProbeMoment["moment"],
  consoleMessages: { type: string; text: string }[],
  testInfo: TestInfo,
) {
  const observations: ProbeObservation[] = [];
  for (const descriptor of connectSourcePropertyGroups) {
    const group = artifact.groups[descriptor.sourceToken];
    if (!group) continue;
    const expected = normaliseCssColor(candidateFixture[mode][descriptor.sourceToken]!.candidate);
    for (const element of group.elements) {
      const locator = target.frame.locator(element.selectorPath);
      const count = await locator.count();
      const computed =
        count === 1
          ? await locator.evaluate(
              (node, property: string) => getComputedStyle(node).getPropertyValue(property),
              element.cssProperty,
            )
          : `<unresolved:${count}>`;
      const normalisedComputed = normaliseCssColor(computed);
      for (const variable of group.variables) {
        const observable = assertionObservable(variable, element.selectorPath, element.cssProperty);
        expect
          .soft(normalisedComputed, `${variable} | ${moment} | expected ${expected} | computed ${normalisedComputed}`)
          .toBe(expected);
        observations.push({
          observable,
          sourceToken: descriptor.sourceToken,
          cssProperty: element.cssProperty,
          expected,
          computed: normalisedComputed,
          matched: normalisedComputed === expected,
          mandatory: true,
        });
      }
    }
  }

  const resolvedTokens = await resolvedTokensFromDocument(page);
  for (const name of consumedTokenNames) {
    expect
      .soft(
        resolvedTokens[name],
        `${moment} outer document token ${name} must resolve to the committed ${mode} candidate`,
      )
      .toBe(candidateFixture[mode][name]!.candidate);
  }
  const screenshot = await captureFrameScreenshot(target.frame, testInfo, moment);
  return {
    moment,
    colorMode: mode,
    resolvedTokens,
    observations,
    consoleMessages: [...consoleMessages],
    ...screenshot,
  } satisfies ProbeMoment;
}

async function captureFreshConnectContext(
  browser: Browser,
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
  host: string,
  stylesheet: string | null,
) {
  const context = await browser.newContext({ baseURL: host, storageState });
  try {
    if (stylesheet) await installDocumentStartStylesheet(context, stylesheet);
    const page = await context.newPage();
    await page.goto(payoutSetupPath);
    await driveColorMode(page, "light");
    const target = await resolveConnectTarget(page);
    return { target, styles: await readFrameStyles(target.frame) };
  } finally {
    await context.close();
  }
}

function sourceValue(style: FrameStyle, cssProperty: "background-color" | "color") {
  return cssProperty === "background-color" ? style.backgroundColor : style.color;
}

async function discoverGroups(
  browser: Browser,
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
  host: string,
) {
  const baseline = await captureFreshConnectContext(browser, storageState, host, null);
  const groups: Record<string, DiscoveryGroup> = {};
  for (const descriptor of connectSourcePropertyGroups) {
    const sentinel = await captureFreshConnectContext(
      browser,
      storageState,
      host,
      sentinelStylesheet(descriptor.sourceToken, descriptor.sentinelColor),
    );
    if (sentinel.target.componentMode !== baseline.target.componentMode) {
      throw new Error(
        `Connect discovery component-mode mismatch for ${descriptor.sourceToken}: baseline ${baseline.target.componentMode}, sentinel ${sentinel.target.componentMode}`,
      );
    }
    const sentinelByPath = new Map(sentinel.styles.map((style) => [style.selectorPath, style]));
    const elements: DiscoveryElement[] = [];
    for (const before of baseline.styles) {
      const after = sentinelByPath.get(before.selectorPath);
      if (!after) {
        throw new Error(
          `Connect discovery baseline path unresolved in ${descriptor.sourceToken} sentinel frame: ${before.selectorPath} (${descriptor.cssProperty})`,
        );
      }
      const beforeValue = sourceValue(before, descriptor.cssProperty);
      const afterValue = sourceValue(after, descriptor.cssProperty);
      if (
        normaliseCssColor(beforeValue) !== normaliseCssColor(afterValue) &&
        normaliseCssColor(afterValue) === normaliseCssColor(descriptor.sentinelColor)
      ) {
        elements.push({
          selectorPath: before.selectorPath,
          cssProperty: descriptor.cssProperty,
          before: beforeValue,
          after: afterValue,
        });
      }
    }
    if (elements.length === 0) {
      if (descriptor.minimum) {
        throw new Error(`Connect discovery minimum source ${descriptor.sourceToken} moved no carrying element`);
      }
      continue;
    }
    groups[descriptor.sourceToken] = {
      variables: [...descriptor.variables],
      sentinelColor: descriptor.sentinelColor,
      elements,
    };
  }
  return { baseline: baseline.target, groups };
}

type ProbeState = {
  moments: ProbeMoment[];
  host: string;
  workers: number;
  collected: { title: string; status: string | undefined; expectedStatus: string; errors: number }[];
  implementationHead: string;
  capturedAt: string;
  componentMode: ComponentMode | "";
  discoveryArtifact: { path: string; sha256: string; sessionNonce: string } | null;
};

const probeState: ProbeState = {
  moments: [],
  host: "",
  workers: 0,
  collected: [],
  implementationHead: "",
  capturedAt: "",
  componentMode: "",
  discoveryArtifact: null,
};

function receiptRefusalReasons(
  state: ProbeState,
  gates: { enabled: boolean; sellerEmail: boolean; sellerPassword: boolean },
  controlMode: string,
) {
  const reasons: string[] = [];
  if (!gates.enabled) reasons.push("STRIPE_CONNECT_APPEARANCE_UAT is not true");
  if (!gates.sellerEmail) reasons.push("MARKETPLACE_E2E_SELLER_EMAIL is absent");
  if (!gates.sellerPassword) reasons.push("MARKETPLACE_E2E_SELLER_PASSWORD is absent");
  if (controlMode) reasons.push(`control mode ${controlMode} may not emit artifacts`);
  if (state.collected.length !== 1) reasons.push(`expected one acceptance result, got ${state.collected.length}`);
  const result = state.collected[0];
  if (
    result &&
    (result.title !== acceptanceTestTitle ||
      result.status !== "passed" ||
      result.expectedStatus !== "passed" ||
      result.errors !== 0)
  ) {
    reasons.push(
      `acceptance result was not one clean pass: title=${result.title}, status=${result.status}, expected=${result.expectedStatus}, errors=${result.errors}`,
    );
  }
  const moments = state.moments
    .map((moment) => moment.moment)
    .sort()
    .join("|");
  if (moments !== "connect-mount-complete|connect-update-complete") {
    reasons.push(`required Connect moments are incomplete: ${moments || "none"}`);
  }
  if (!state.discoveryArtifact) reasons.push("same-session discovery binding is absent");
  if (state.host !== qualifyingHost) reasons.push(`host ${state.host || "<unset>"} is not qualifying`);
  if (liveRetentionScan.forbiddenMarkerHits !== 0) reasons.push("retention scan recorded a forbidden marker hit");
  return reasons;
}

function writeAcceptanceReceiptIfEligible(
  path: string,
  state: ProbeState,
  gates: { enabled: boolean; sellerEmail: boolean; sellerPassword: boolean },
  controlMode: string,
) {
  const reasons = receiptRefusalReasons(state, gates, controlMode);
  if (reasons.length > 0) return { written: false, reasons };
  const receipt = {
    schemaVersion: "stripe-appearance-acceptance-receipt/v1",
    surface: "connect",
    stripeMode: "test",
    implementationHead: state.implementationHead,
    fixturePath: candidateFixtureRelativePath,
    fixtureSha256: candidateFixtureSha256,
    sourceDigests: receiptSourceDigests(),
    capturedAt: state.capturedAt,
    host: state.host,
    environmentVariableNames: probeEnvironmentVariableNames,
    runSummary: {
      command: evidenceCommand,
      workers: state.workers,
      collected: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      testTitles: [acceptanceTestTitle],
    },
    retentionScan: { ...liveRetentionScan, textualArtifacts: liveRetentionScan.textualArtifacts + 1 },
    moments: state.moments,
    substitutionsApplied: [],
    componentMode: state.componentMode,
    discoveryArtifact: state.discoveryArtifact,
  };
  const serialised = `${JSON.stringify(receipt, null, 2)}\n`;
  const hits = liveRetentionGuard.scanText(serialised);
  if (hits.length > 0) {
    return {
      written: false,
      reasons: [`retention scan matched ${[...new Set(hits)].sort().join(", ")} in the receipt candidate`],
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialised, { flag: "wx" });
  return { written: true, reasons: [] };
}

test.afterEach(async ({}, testInfo) => {
  if (!testInfo.title.includes("@connect-appearance-uat")) return;
  probeState.workers = testInfo.config.workers;
  probeState.collected.push({
    title: testInfo.title,
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    errors: testInfo.errors.length,
  });
});

test.afterAll(async () => {
  const result = writeAcceptanceReceiptIfEligible(
    acceptanceReceiptPath,
    probeState,
    {
      enabled: runConnectAppearanceUat,
      sellerEmail: sellerEmail.length > 0,
      sellerPassword: sellerPassword.length > 0,
    },
    probeControlMode,
  );
  if (result.written) {
    console.log(`Stripe Connect acceptance receipt written to ${acceptanceReceiptRelativePath}`);
  } else {
    console.log(`Stripe Connect acceptance receipt refused: ${result.reasons.join("; ")}`);
  }
});

test("resolves the Connect frame and attributes source-property groups by sentinel differential @connect-appearance-discovery", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(connectCaptureTimeoutMs + 5 * connectInitializationTimeoutMs);
  test.skip(!runConnectAppearanceUat, "Set STRIPE_CONNECT_APPEARANCE_UAT=true to run Connect discovery.");
  test.skip(!sellerEmail, "Set MARKETPLACE_E2E_SELLER_EMAIL to a qualifying seller account.");
  test.skip(!sellerPassword, "Set MARKETPLACE_E2E_SELLER_PASSWORD for the qualifying seller account.");

  expect(probeControlMode, "a control-mode run writes neither discovery nor receipt bytes").toBe("");
  expect(existsSync(discoveryArtifactPath), "discovery output path must be absent before a fresh session").toBe(false);
  const host = resolvedHost(testInfo);
  await signInSeller(page, host);
  const storageState = await page.context().storageState();
  const discovered = await discoverGroups(browser, storageState, host);
  const head = implementationHead();
  const artifact: DiscoveryArtifact = {
    schemaVersion: "stripe-connect-discovery/v1",
    sessionNonce: randomBytes(16).toString("hex"),
    implementationHead: head,
    deployRunId: deployedRunId(head),
    host,
    capturedAt: new Date().toISOString(),
    componentMode: discovered.baseline.componentMode,
    frameSelector: discovered.baseline.frameSelector,
    environmentVariableNames: probeEnvironmentVariableNames,
    fixtureSha256: candidateFixtureSha256,
    sourceDigests: receiptSourceDigests(),
    retentionScan: { ...liveRetentionScan, textualArtifacts: liveRetentionScan.textualArtifacts + 1 },
    groups: discovered.groups,
  };
  const violations = discoveryShapeViolations(artifact);
  expect(violations, "session discovery must satisfy the closed artifact shape before writing").toEqual([]);
  expect(discoverySchema.$id).toBe("https://chase-sets.com/schemas/stripe-connect-discovery/v1.json");
  const serialised = `${JSON.stringify(artifact, null, 2)}\n`;
  const hits = liveRetentionGuard.scanText(serialised);
  expect(hits, "discovery artifact retention scan must be clean before any durable byte exists").toEqual([]);
  writeFileSync(discoveryArtifactPath, serialised, { flag: "wx" });
  console.log(`Stripe Connect discovery artifact written by ${discoveryCommand} to ${discoveryArtifactRelativePath}`);
});

test("proves the deployed Connect embedded surface accepts the candidate appearance at the completed initialisation and after the mode-change re-initialisation @connect-appearance-uat", async ({
  page,
}, testInfo) => {
  test.setTimeout(connectCaptureTimeoutMs + connectInitializationTimeoutMs);
  test.skip(!runConnectAppearanceUat, "Set STRIPE_CONNECT_APPEARANCE_UAT=true to run Connect acceptance.");
  test.skip(!sellerEmail, "Set MARKETPLACE_E2E_SELLER_EMAIL to a qualifying seller account.");
  test.skip(!sellerPassword, "Set MARKETPLACE_E2E_SELLER_PASSWORD for the qualifying seller account.");

  expect(existsSync(acceptanceReceiptPath), "acceptance output path must be absent before a fresh session").toBe(false);
  const host = resolvedHost(testInfo);
  const head = implementationHead();
  const acceptanceStartedAt = new Date().toISOString();
  const discovery = readBoundDiscoveryArtifact({ head, host, acceptanceStartedAt });
  if (probeControlMode !== "injection-off") {
    await installDocumentStartStylesheet(
      page.context(),
      candidateStylesheet(probeControlMode === "invalid-value" ? "--foreground" : null),
    );
  }
  const consoleMessages = watchConsole(page);
  await signInSeller(page, host);
  await page.goto(payoutSetupPath);
  await driveColorMode(page, "light");
  const lightTarget = await resolveConnectTarget(page);
  expect(
    lightTarget.componentMode,
    `Connect component mode differs from discovery: ${lightTarget.componentMode} vs ${discovery.artifact.componentMode}`,
  ).toBe(discovery.artifact.componentMode);
  expect(lightTarget.frameSelector, "Connect frame selector differs from discovery").toBe(
    discovery.artifact.frameSelector,
  );
  const lightMoment = await captureMoment(
    page,
    lightTarget,
    discovery.artifact,
    "light",
    "connect-mount-complete",
    consoleMessages,
    testInfo,
  );

  await driveColorMode(page, "dark");
  const darkTarget = await resolveConnectTarget(page);
  expect(
    darkTarget.componentMode,
    `Connect component mode changed across re-initialisation: ${lightTarget.componentMode} vs ${darkTarget.componentMode}`,
  ).toBe(lightTarget.componentMode);
  expect(darkTarget.frameSelector, "Connect frame selector no longer resolves after re-initialisation").toBe(
    discovery.artifact.frameSelector,
  );
  const darkMoment = await captureMoment(
    page,
    darkTarget,
    discovery.artifact,
    "dark",
    "connect-update-complete",
    consoleMessages,
    testInfo,
  );

  const moments = [lightMoment, darkMoment];
  const appearanceRejections = consoleMessages.filter((message) =>
    /IntegrationError|Invalid value for|Unrecognized (?:appearance )?(?:variable|property)|Unsupported (?:CSS )?(?:value|property)/i.test(
      message.text,
    ),
  );
  if (!probeControlMode) {
    expect.soft(appearanceRejections, "Connect emitted an appearance rejection").toEqual([]);
  } else if (probeControlMode === "injection-off") {
    const lightText = lightMoment.observations.filter((observation) => observation.sourceToken === "--foreground");
    const darkBackground = darkMoment.observations.filter((observation) => observation.sourceToken === "--card");
    expect(lightText.length).toBeGreaterThan(0);
    expect(darkBackground.length).toBeGreaterThan(0);
    expect(lightText.every((observation) => !observation.matched)).toBe(true);
    expect(darkBackground.every((observation) => !observation.matched)).toBe(true);
  } else if (probeControlMode === "invalid-value") {
    const invalidForeground = lightMoment.observations.filter(
      (observation) => observation.sourceToken === "--foreground",
    );
    const otherObservations = moments.flatMap((moment) =>
      moment.observations.filter((observation) => observation.sourceToken !== "--foreground"),
    );
    expect(invalidForeground.length).toBeGreaterThan(0);
    expect(invalidForeground.every((observation) => !observation.matched)).toBe(true);
    expect(otherObservations.every((observation) => observation.matched)).toBe(true);
  } else {
    throw new Error(`unknown STRIPE_APPEARANCE_PROBE_CONTROL mode ${probeControlMode}`);
  }

  probeState.moments = moments;
  probeState.host = host;
  probeState.implementationHead = head;
  probeState.capturedAt = new Date().toISOString();
  probeState.componentMode = lightTarget.componentMode;
  probeState.discoveryArtifact = {
    path: discoveryArtifactRelativePath,
    sha256: createHash("sha256").update(discovery.bytes).digest("hex"),
    sessionNonce: discovery.artifact.sessionNonce,
  };
});

test.describe("Connect appearance probe machinery, provider-free", () => {
  test("names every ungoverned resolved retention setting", () => {
    const problems = ungovernedSettings({
      reporterNames: ["html"],
      outputDir: "test-results",
      retries: 1,
      trace: "on",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    });
    expect(problems).toHaveLength(6);
    for (const name of ["reporter", "outputDir", "retries", "trace", "screenshot", "video"]) {
      expect(
        problems.some((problem) => problem.includes(name)),
        `missing named config refusal for ${name}`,
      ).toBe(true);
    }
  });

  test("refuses planted textual markers and masks every frame-visible text region before image retention", async ({
    page,
  }) => {
    const guard = createRetentionGuard([
      { value: "seller@example.test", category: "seller-identity" },
      { value: "synthetic-password", category: "credential" },
    ]);
    const markers = [
      ["sk", "test", "SYNTHETIC123"].join("_"),
      "seller@example.test",
      "acct_SYNTHETIC123",
      "person_SYNTHETIC123",
      "session-token=synthetic-session",
      "password=synthetic-password",
    ];
    for (const marker of markers) {
      expect(guard.scanText(marker), `textual retention scan missed ${marker.split("=")[0]}`).not.toEqual([]);
    }
    await page.setContent(`<iframe title="synthetic Connect frame"></iframe>`);
    const iframe = page.locator("iframe");
    await iframe.evaluate((element) => {
      const document = (element as HTMLIFrameElement).contentDocument!;
      document.open();
      document.write("<body><span>seller@example.test</span><span>acct_SYNTHETIC123</span></body>");
      document.close();
    });
    const frame = page.frameLocator('iframe[title="synthetic Connect frame"]');
    expect(await frameTextMaskSelectors(frame)).toHaveLength(2);
  });

  test("writes no receipt bytes when all three environment gates are unset", ({}, testInfo) => {
    const output = testInfo.outputPath("synthetic-connect-receipt.json");
    const result = writeAcceptanceReceiptIfEligible(
      output,
      { ...probeState, collected: [], moments: [], discoveryArtifact: null, host: "" },
      { enabled: false, sellerEmail: false, sellerPassword: false },
      "",
    );
    expect(result.written).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "STRIPE_CONNECT_APPEARANCE_UAT is not true",
        "MARKETPLACE_E2E_SELLER_EMAIL is absent",
        "MARKETPLACE_E2E_SELLER_PASSWORD is absent",
      ]),
    );
    expect(existsSync(output)).toBe(false);
  });

  test("names missing and stale discovery bindings before acceptance", ({}, testInfo) => {
    const expected = {
      head: "1".repeat(40),
      host: qualifyingHost,
      acceptanceStartedAt: "2026-08-10T12:00:00Z",
    };
    const missing = testInfo.outputPath("missing-discovery.json");
    expect(() => readBoundDiscoveryArtifactAt(missing, "synthetic missing discovery", expected)).toThrow(
      /Connect discovery binding missing/,
    );
    const staleArtifact: DiscoveryArtifact = {
      schemaVersion: "stripe-connect-discovery/v1",
      sessionNonce: "a".repeat(32),
      implementationHead: "2".repeat(40),
      deployRunId: "1",
      host: qualifyingHost,
      capturedAt: "2026-08-10T11:00:00Z",
      componentMode: "account-management",
      frameSelector: "synthetic-frame",
      environmentVariableNames: [...probeEnvironmentVariableNames],
      fixtureSha256: candidateFixtureSha256,
      sourceDigests: receiptSourceDigests(),
      retentionScan: { textualArtifacts: 1, imageArtifacts: 0, redactionsApplied: 0, forbiddenMarkerHits: 0 },
      groups: {
        "--card": {
          variables: ["colorBackground"],
          sentinelColor: "#ff00ff",
          elements: [
            {
              selectorPath: "body > div",
              cssProperty: "background-color",
              before: "rgb(255, 255, 255)",
              after: "rgb(255, 0, 255)",
            },
          ],
        },
        "--foreground": {
          variables: ["buttonSecondaryColorText", "colorText"],
          sentinelColor: "#00ff00",
          elements: [
            {
              selectorPath: "body > p",
              cssProperty: "color",
              before: "rgb(15, 23, 42)",
              after: "rgb(0, 255, 0)",
            },
          ],
        },
      },
    };
    const stale = boundDiscoveryViolations(Buffer.from(JSON.stringify(staleArtifact)), expected);
    expect(stale.problems).toContain("discovery implementationHead binding is stale");

    const malformed = structuredClone(staleArtifact) as DiscoveryArtifact & {
      retentionScan: RetentionScan & { unknown?: boolean };
    };
    malformed.implementationHead = expected.head;
    malformed.retentionScan.imageArtifacts = -1;
    malformed.retentionScan.unknown = true;
    const malformedResult = boundDiscoveryViolations(Buffer.from(JSON.stringify(malformed)), expected);
    expect(malformedResult.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("discovery.retentionScan keys must be exactly"),
        "discovery.retentionScan.imageArtifacts must be an integer from 0 through 2147483647",
      ]),
    );
  });
});
