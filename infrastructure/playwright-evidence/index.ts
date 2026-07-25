import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type Locator, type Page, type TestInfo } from "@playwright/test";
import sourceManifest from "./responsive-evidence-manifest.json" with { type: "json" };

type NumericAssertion = Readonly<{
  equals?: number;
  minimum?: number;
  maximum?: number;
  tolerance?: number;
}>;

type Measurement = Readonly<{
  identity: string;
  scope: "target" | "page" | "document";
  selector?: string;
  property:
    | "width"
    | "height"
    | "display"
    | "visible"
    | "horizontal-overflow"
    | "gap-above"
    | "scroll-margin-bottom"
    | "css-custom-property";
  // Additive: page-scoped selector for the "gap-above" property's reference element.
  // Required for "gap-above", unused otherwise.
  relativeToSelector?: string;
  // Additive: CSS custom property name for the "css-custom-property" property.
  // Required for "css-custom-property", unused otherwise.
  customProperty?: string;
  assertion: NumericAssertion | Readonly<{ equals: string | boolean }>;
}>;

type ResponsiveEvidenceClaim = Readonly<{
  kind: "claim" | "negative-control";
  id: string;
  file: string;
  testTitle: string;
  route: Readonly<{ name: string; path: string }>;
  fixture: Readonly<{ identity: string }>;
  viewport: Readonly<{ width: number; height: number }>;
  target: Readonly<{
    identity: string;
    selector: string;
    populatedSelector: string;
  }>;
  measurements: readonly Measurement[];
  artifact: string;
}>;

type ResponsiveEvidenceSourceManifest = Readonly<{
  contract: "fail-closed-responsive-evidence";
  schemaVersion: 1;
  claims: readonly ResponsiveEvidenceClaim[];
}>;

const manifest = sourceManifest as ResponsiveEvidenceSourceManifest;

export async function captureResponsiveEvidence(input: {
  page: Page;
  testInfo: TestInfo;
  claimId: string;
}): Promise<void> {
  const claim = findClaim(input.claimId);

  await test.step(`responsive evidence: ${claim.id}`, async () => {
    await input.page.setViewportSize(claim.viewport);
    assertExactRoute(input.page, claim);

    const target = input.page.locator(claim.target.selector);
    await requireExactVisibleTarget(target, claim);
    await requirePopulatedTarget(target, claim);

    const assertions = [];
    for (const measurement of claim.measurements) {
      const actual = await observeMeasurement(input.page, target, claim, measurement);
      assertMeasurement(claim, measurement, actual);
      assertions.push({
        identity: measurement.identity,
        property: measurement.property,
        expected: measurement.assertion,
        actual,
      });
    }

    const artifactPaths = responsiveEvidenceArtifactPaths(input.testInfo, claim.id);
    await mkdir(path.dirname(artifactPaths.screenshot), { recursive: true });
    await input.page.screenshot({ path: artifactPaths.screenshot, fullPage: true });
    const screenshotSha256 = await fileSha256(artifactPaths.screenshot);
    const configPath = path.resolve(process.cwd(), "playwright.config.ts");

    const runtimeEntry = {
      contract: "responsive-evidence-runtime",
      schemaVersion: 2,
      claimId: claim.id,
      route: {
        ...claim.route,
        observed: routePath(input.page),
      },
      fixture: claim.fixture,
      viewport: claim.viewport,
      target: {
        identity: claim.target.identity,
        selector: claim.target.selector,
        populatedSelector: claim.target.populatedSelector,
      },
      assertions,
      artifacts: {
        screenshot: {
          path: relativeArtifactPath(artifactPaths.screenshot),
          sha256: screenshotSha256,
        },
        manifest: {
          path: relativeArtifactPath(artifactPaths.manifest),
        },
        sourceClaimSha256: sha256(JSON.stringify(claim)),
        playwrightConfig: {
          path: "playwright.config.ts",
          sha256: await fileSha256(configPath),
        },
      },
    };

    await writeFile(artifactPaths.manifest, `${JSON.stringify(runtimeEntry, null, 2)}\n`, "utf8");
    await input.testInfo.attach(`responsive-evidence:${claim.id}:screenshot`, {
      path: artifactPaths.screenshot,
      contentType: "image/png",
    });
    await input.testInfo.attach(`responsive-evidence:${claim.id}:manifest`, {
      path: artifactPaths.manifest,
      contentType: "application/json",
    });
  });
}

export function responsiveEvidenceArtifactPaths(testInfo: TestInfo, claimId: string) {
  const claim = findClaim(claimId);
  const directory = testInfo.outputPath("responsive-evidence");
  return {
    screenshot: path.join(directory, `${claim.artifact}.png`),
    manifest: path.join(directory, `${claim.artifact}.manifest.json`),
  };
}

function findClaim(claimId: string): ResponsiveEvidenceClaim {
  if (manifest.contract !== "fail-closed-responsive-evidence" || manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported responsive evidence manifest schema ${String(manifest.schemaVersion)}.`);
  }
  const matching = manifest.claims.filter((claim) => claim.id === claimId);
  if (matching.length !== 1) {
    throw new Error(`Responsive evidence claim '${claimId}' must have exactly one manifest entry.`);
  }
  const claim = matching[0]!;
  if (
    !claim.route.name.trim() ||
    !claim.route.path.startsWith("/") ||
    !claim.fixture.identity.trim() ||
    !claim.target.identity.trim() ||
    !claim.target.selector.trim() ||
    !claim.target.populatedSelector.trim() ||
    claim.measurements.length === 0
  ) {
    throw new Error(`Responsive evidence claim '${claimId}' has an incomplete fail-closed manifest entry.`);
  }
  for (const measurement of claim.measurements) {
    validateMeasurement(claim, measurement);
  }
  return claim;
}

function validateMeasurement(claim: ResponsiveEvidenceClaim, measurement: Measurement) {
  const supportedProperties = [
    "width",
    "height",
    "display",
    "visible",
    "horizontal-overflow",
    "gap-above",
    "scroll-margin-bottom",
    "css-custom-property",
  ];
  if (
    !measurement.identity?.trim() ||
    !["target", "page", "document"].includes(measurement.scope) ||
    !supportedProperties.includes(measurement.property)
  ) {
    fail(claim, `invalid-measurement(${String(measurement.identity)})`);
  }
  if (
    (measurement.scope === "document" && measurement.selector !== undefined) ||
    (measurement.scope !== "document" && !measurement.selector?.trim())
  ) {
    fail(claim, `invalid-measurement-selector(${measurement.identity})`);
  }
  if (measurement.property === "gap-above" && !measurement.relativeToSelector?.trim()) {
    fail(claim, `measurement-relative-to-missing(${measurement.identity})`);
  }
  if (measurement.property === "css-custom-property" && !measurement.customProperty?.trim()) {
    fail(claim, `measurement-custom-property-missing(${measurement.identity})`);
  }
  const assertion = measurement.assertion;
  if (
    !assertion ||
    typeof assertion !== "object" ||
    !("equals" in assertion || "minimum" in assertion || "maximum" in assertion)
  ) {
    fail(claim, `measurement-assertion-missing(${measurement.identity})`);
  }
}

function assertExactRoute(page: Page, claim: ResponsiveEvidenceClaim) {
  const observed = routePath(page);
  if (observed !== claim.route.path) {
    fail(claim, `route-mismatch(expected=${claim.route.path}, observed=${observed})`, observed);
  }
}

async function requireExactVisibleTarget(target: Locator, claim: ResponsiveEvidenceClaim) {
  const count = await target.count();
  if (count === 0) fail(claim, "target-absent");
  if (count !== 1) fail(claim, `target-not-exact(count=${count})`);
  if (!(await target.isVisible())) fail(claim, "target-hidden-or-collapsed");
  const box = await target.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) fail(claim, "target-has-no-observable-layout");
}

async function requirePopulatedTarget(target: Locator, claim: ResponsiveEvidenceClaim) {
  const populated = target.locator(claim.target.populatedSelector);
  const count = await populated.count();
  if (count === 0) fail(claim, "target-population-empty");
  for (let index = 0; index < count; index += 1) {
    const item = populated.nth(index);
    if (!(await item.isVisible())) fail(claim, `target-population-hidden(index=${index})`);
    const box = await item.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      fail(claim, `target-population-has-no-observable-layout(index=${index})`);
    }
  }
}

async function observeMeasurement(
  page: Page,
  target: Locator,
  claim: ResponsiveEvidenceClaim,
  measurement: Measurement,
): Promise<number | string | boolean> {
  if (measurement.scope === "document") {
    if (measurement.property !== "horizontal-overflow" || measurement.selector) {
      fail(claim, `invalid-document-measurement(${measurement.identity})`);
    }
    return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }

  if (!measurement.selector?.trim()) {
    fail(claim, `measurement-selector-missing(${measurement.identity})`);
  }
  const locator =
    measurement.scope === "target" ? target.locator(measurement.selector!) : page.locator(measurement.selector!);
  const count = await locator.count();
  if (count !== 1) {
    fail(claim, `measurement-target-not-exact(${measurement.identity}, count=${count})`);
  }
  if (measurement.property === "visible") {
    return locator.isVisible();
  }
  if (!(await locator.isVisible())) {
    fail(claim, `measurement-target-hidden(${measurement.identity})`);
  }
  if (measurement.property === "display") {
    return locator.evaluate((element) => getComputedStyle(element).display);
  }
  if (measurement.property === "horizontal-overflow") {
    // Additive: the pre-existing "horizontal-overflow" property only supported
    // document scope. Element scope reuses the same scrollWidth/clientWidth
    // semantics to prove a label is not clipped, with no change to the document-scope
    // branch above.
    return locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  }
  if (measurement.property === "scroll-margin-bottom") {
    const raw = await locator.evaluate((element) => getComputedStyle(element).scrollMarginBottom);
    return parsePixelMeasurement(claim, measurement, raw);
  }
  if (measurement.property === "css-custom-property") {
    if (!measurement.customProperty?.trim()) {
      fail(claim, `measurement-custom-property-missing(${measurement.identity})`);
    }
    const observed = await locator.evaluate(
      (element, propertyName) => ({
        value: getComputedStyle(element).getPropertyValue(propertyName).trim(),
        rootFontSizePx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      }),
      measurement.customProperty!,
    );
    return parseCustomPropertyPixels(claim, measurement, observed.value, observed.rootFontSizePx);
  }
  const box = await locator.boundingBox();
  if (!box) fail(claim, `measurement-target-has-no-layout(${measurement.identity})`);
  if (measurement.property === "width") return box!.width;
  if (measurement.property === "height") return box!.height;
  if (measurement.property === "gap-above") {
    if (!measurement.relativeToSelector?.trim()) {
      fail(claim, `measurement-relative-to-missing(${measurement.identity})`);
    }
    const reference = page.locator(measurement.relativeToSelector!);
    const referenceCount = await reference.count();
    if (referenceCount !== 1) {
      fail(claim, `measurement-relative-to-not-exact(${measurement.identity}, count=${referenceCount})`);
    }
    if (!(await reference.isVisible())) {
      fail(claim, `measurement-relative-to-hidden(${measurement.identity})`);
    }
    const referenceBox = await reference.boundingBox();
    if (!referenceBox) {
      fail(claim, `measurement-relative-to-has-no-layout(${measurement.identity})`);
    }
    return referenceBox!.y - (box!.y + box!.height);
  }
  fail(claim, `unsupported-measurement(${measurement.identity}:${measurement.property})`);
}

function parsePixelMeasurement(claim: ResponsiveEvidenceClaim, measurement: Measurement, raw: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    fail(claim, `measurement-not-numeric(${measurement.identity}, actual=${raw || "<empty>"})`);
  }
  return value;
}

// An unregistered CSS custom property computes to its authored token sequence, not to a
// resolved length: getPropertyValue returns "5.25rem" for a shell nav height the browser
// resolves to 84px. Number.parseFloat reads that token as 5.25 and would compare a rem
// count against a pixel bound — a silently wrong number rather than a failure. Resolve
// the length units the design system authors against the document's own root font size,
// and fail closed on every other token so an unrecognized unit can never be truncated
// into a number.
function parseCustomPropertyPixels(
  claim: ResponsiveEvidenceClaim,
  measurement: Measurement,
  raw: string,
  rootFontSizePx: number,
): number {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem)?$/.exec(raw);
  const magnitude = match ? Number.parseFloat(match[1]!) : Number.NaN;
  const unit = match?.[2];
  if (!Number.isFinite(magnitude) || (unit === undefined && magnitude !== 0)) {
    fail(claim, `measurement-not-numeric(${measurement.identity}, actual=${raw || "<empty>"})`);
  }
  if (unit !== "rem") {
    return magnitude;
  }
  if (!Number.isFinite(rootFontSizePx) || rootFontSizePx <= 0) {
    fail(claim, `measurement-root-font-size-unresolved(${measurement.identity}, actual=${raw})`);
  }
  return magnitude * rootFontSizePx;
}

function assertMeasurement(
  claim: ResponsiveEvidenceClaim,
  measurement: Measurement,
  actual: number | string | boolean,
) {
  const assertion = measurement.assertion;
  if ("equals" in assertion && typeof assertion.equals !== "number") {
    if (actual !== assertion.equals) {
      fail(
        claim,
        `measurement-failed(${measurement.identity}, expected=${String(assertion.equals)}, actual=${String(actual)})`,
      );
    }
    return;
  }
  if (typeof actual !== "number") {
    fail(claim, `measurement-not-numeric(${measurement.identity}, actual=${String(actual)})`);
  }
  const numericAssertion = assertion as NumericAssertion;
  const tolerance = numericAssertion.tolerance ?? 0;
  if (
    (numericAssertion.equals !== undefined && Math.abs(actual - numericAssertion.equals) > tolerance) ||
    (numericAssertion.minimum !== undefined && actual < numericAssertion.minimum - tolerance) ||
    (numericAssertion.maximum !== undefined && actual > numericAssertion.maximum + tolerance)
  ) {
    fail(claim, `measurement-failed(${measurement.identity}, expected=${JSON.stringify(assertion)}, actual=${actual})`);
  }
}

function fail(claim: ResponsiveEvidenceClaim, reason: string, observedRoute = claim.route.path): never {
  throw new Error(
    `Responsive evidence '${claim.id}' failed: route=${claim.route.name}:${observedRoute} viewport=${claim.viewport.width}x${claim.viewport.height} target=${claim.target.identity} fixture=${claim.fixture.identity} reason=${reason}`,
  );
}

function routePath(page: Page) {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}${url.hash}`;
}

function relativeArtifactPath(artifactPath: string) {
  return path.relative(process.cwd(), artifactPath).replaceAll("\\", "/");
}

async function fileSha256(filePath: string) {
  return sha256(await readFile(filePath));
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
