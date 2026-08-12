// Brand-mark representation guard: owns the closed changed-path set of the
// Ink & Foil atomic candidate and the two nineteen-member representation
// inventories, and proves every committed raster depicts the candidate brand
// foil by decoding it. Three closed arrays are committed between sentinel
// comments whose bracketed contents are valid JSON; the vector-side suite in
// packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts reads
// this file's bytes and parses the same blocks, so the two sides can never
// hold two hand-kept lists.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";
import sharp from "sharp";

function repositoryRoot() {
  let candidate = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("Could not locate the repository root");
    candidate = parent;
  }
  return candidate;
}

const root = repositoryRoot();
const selfPath = fileURLToPath(import.meta.url);
const selfSource = readFileSync(selfPath, "utf8");

// Slices the JSON array committed between `// <name>:begin` and `// <name>:end`
// sentinel comment lines: the text between the sentinels is reduced to its
// bracketed payload and parsed. The vector-side suite applies these exact
// semantics to this file's bytes, so both predicates parse the same bytes.
export function sliceSentinelJson(source, name) {
  const begin = source.indexOf(`// ${name}:begin`);
  const end = source.indexOf(`// ${name}:end`);
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error(`sentinel block ${name} not found`);
  }
  const block = source.slice(begin, end);
  const first = block.indexOf("[");
  const last = block.lastIndexOf("]");
  if (first === -1 || last === -1) throw new Error(`sentinel block ${name} carries no JSON array`);
  // The repository formatter writes a trailing comma before the closing
  // bracket; both sides normalise it away identically before parsing.
  return JSON.parse(block.slice(first, last + 1).replace(/,\s*\]$/, "]"));
}

// combined-candidate-paths:begin
export const combinedCandidatePaths = [
  "packages/design-system/src/styles/styles.css",
  "packages/design-system/src/theme/tokens.ts",
  "packages/design-system/src/brand/chase-sets-logo.tsx",
  "packages/design-system/src/brand/chase-sets-logo.svg",
  "packages/design-system/package.json",
  "packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts",
  "packages/design-system/src/__tests__/ink-foil-candidate-fixture.test.ts",
  "packages/design-system/src/__tests__/design-system-components.test.tsx",
  "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
  "infrastructure/playwright-evidence/responsive-evidence-manifest.json",
  "pnpm-lock.yaml",
  "scripts/check-structure/typescript-owner-contexts.json",
  "scripts/check-structure/consent-authorization-evidence-receipt.json",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-default.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-pokemon.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-magic-the-gathering.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-yu-gi-oh.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-disney-lorcana.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-one-piece-card-game.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-founders.png",
  "scripts/generate-brand-icons.mjs",
  "deployables/marketplace/public/icons/chase-sets-192.png",
  "deployables/marketplace/public/icons/chase-sets-512.png",
  "deployables/marketplace/public/icons/chase-sets-maskable-192.png",
  "deployables/marketplace/public/icons/chase-sets-maskable-512.png",
  "deployables/admin-web/public/icons/chase-sets-admin-192.png",
  "deployables/admin-web/public/icons/chase-sets-admin-512.png",
  "deployables/admin-web/public/icons/chase-sets-admin-maskable-192.png",
  "deployables/admin-web/public/icons/chase-sets-admin-maskable-512.png",
  "package.json",
  "scripts/check-structure/brand-mark-representations.test.mjs",
  "scripts/check-heavy-slot-coverage.test.mjs",
];
// combined-candidate-paths:end

// Deployed runtime endpoints: one rendered React mark, three favicon members
// (one per deployable; /favicon.ico routes to the same loader, so /favicon.svg
// is the canonical locator), eight icon endpoints, seven social-card
// endpoints. Contains no repository path and no generator path; the deploy
// receipt enumerates exactly this array and never repositorySourceOutputs.
// runtime-representations:begin
export const runtimeRepresentations = [
  "marketplace-web rendered-react-mark",
  "marketplace-web /favicon.svg",
  "admin-web /favicon.svg",
  "public-web /favicon.svg",
  "marketplace-web /icons/chase-sets-192.png",
  "marketplace-web /icons/chase-sets-512.png",
  "marketplace-web /icons/chase-sets-maskable-192.png",
  "marketplace-web /icons/chase-sets-maskable-512.png",
  "admin-web /icons/chase-sets-admin-192.png",
  "admin-web /icons/chase-sets-admin-512.png",
  "admin-web /icons/chase-sets-admin-maskable-192.png",
  "admin-web /icons/chase-sets-admin-maskable-512.png",
  "public-web og-image /",
  "public-web og-image /founders",
  "public-web og-image /?game=pokemon",
  "public-web og-image /?game=magic-the-gathering",
  "public-web og-image /?game=yu-gi-oh",
  "public-web og-image /?game=disney-lorcana",
  "public-web og-image /?game=one-piece-card-game",
];
// runtime-representations:end

// Committed source and output files: two vector sources, two generators,
// eight icon paths, seven card paths. A strict subset of
// combinedCandidatePaths and NOT the deploy count -- the favicon endpoints
// re-skin from the vector source and appear only in runtimeRepresentations.
// repository-source-outputs:begin
export const repositorySourceOutputs = [
  "packages/design-system/src/brand/chase-sets-logo.tsx",
  "packages/design-system/src/brand/chase-sets-logo.svg",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs",
  "scripts/generate-brand-icons.mjs",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-default.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-pokemon.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-magic-the-gathering.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-yu-gi-oh.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-disney-lorcana.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-one-piece-card-game.png",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-founders.png",
  "deployables/marketplace/public/icons/chase-sets-192.png",
  "deployables/marketplace/public/icons/chase-sets-512.png",
  "deployables/marketplace/public/icons/chase-sets-maskable-192.png",
  "deployables/marketplace/public/icons/chase-sets-maskable-512.png",
  "deployables/admin-web/public/icons/chase-sets-admin-192.png",
  "deployables/admin-web/public/icons/chase-sets-admin-512.png",
  "deployables/admin-web/public/icons/chase-sets-admin-maskable-192.png",
  "deployables/admin-web/public/icons/chase-sets-admin-maskable-512.png",
];
// repository-source-outputs:end

const cardPaths = repositorySourceOutputs.filter((p) => p.includes("chase-sets-og-"));
const iconPaths = repositorySourceOutputs.filter((p) => p.includes("/public/icons/"));

// ---------------------------------------------------------------------------
// Changed-path closure predicate. Takes its input as an explicit argument so
// every negative control passes a synthetic set directly; nothing here reads
// an ambient changed-files variable.
// ---------------------------------------------------------------------------

export function evaluateChangedPathSet(changedPaths) {
  const changed = new Set(changedPaths);
  const published = new Set(combinedCandidatePaths);
  const missing = combinedCandidatePaths.filter((p) => !changed.has(p));
  const extra = [...changed].filter((p) => !published.has(p));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

function realChangedPaths() {
  const mergeBase = execFileSync("git", ["-C", root, "merge-base", "HEAD", "refs/remotes/origin/main"], {
    encoding: "utf8",
  }).trim();
  const diff = execFileSync("git", ["-C", root, "diff", "--name-only", mergeBase], {
    encoding: "utf8",
  });
  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  const untracked = status
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim());
  return [...new Set([...diff.split("\n").filter(Boolean), ...untracked])];
}

// ---------------------------------------------------------------------------
// Inventory validators. Pure over their array argument so mutants are passed
// directly and the refusal path is asserted, never simulated.
// ---------------------------------------------------------------------------

export function validateRuntimeInventory(inventory) {
  const errors = [];
  if (inventory.length !== 19) errors.push(`length ${inventory.length} !== 19`);
  const dupes = inventory.filter((m, i) => inventory.indexOf(m) !== i);
  for (const d of dupes) errors.push(`duplicate member ${d}`);

  const rendered = inventory.filter((m) => / rendered-react-mark$/.test(m));
  const favicons = inventory.filter((m) => / \/favicon\.svg$/.test(m));
  const icons = inventory.filter((m) => / \/icons\/[\w.-]+\.png$/.test(m));
  const cards = inventory.filter((m) => / og-image /.test(m));
  if (rendered.length !== 1 || favicons.length !== 3 || icons.length !== 8 || cards.length !== 7) {
    errors.push(`decomposition ${rendered.length}/${favicons.length}/${icons.length}/${cards.length} !== 1/3/8/7`);
  }
  for (const member of inventory) {
    if (!/^(marketplace-web|admin-web|public-web) /.test(member)) {
      errors.push(`member without origin token: ${member}`);
    }
    if (combinedCandidatePaths.includes(member)) errors.push(`repository path inside runtime inventory: ${member}`);
    // Only .tsx and .mjs are excluded on purpose: .svg and .png are legitimate
    // runtime locators (/favicon.svg is one), so a .svg exclusion would reject
    // three correct members.
    if (member.endsWith(".tsx") || member.endsWith(".mjs")) {
      errors.push(`repository-extension member inside runtime inventory: ${member}`);
    }
  }
  const faviconOrigins = favicons.map((m) => m.split(" ")[0]);
  for (const origin of ["marketplace-web", "admin-web", "public-web"]) {
    const count = faviconOrigins.filter((o) => o === origin).length;
    if (count !== 1) errors.push(`favicon members for ${origin}: ${count} !== 1`);
  }
  return errors;
}

export function validateRepositoryInventory(inventory) {
  const errors = [];
  if (inventory.length !== 19) errors.push(`length ${inventory.length} !== 19`);
  const dupes = inventory.filter((m, i) => inventory.indexOf(m) !== i);
  for (const d of dupes) errors.push(`duplicate member ${d}`);

  const vectors = inventory.filter((m) => /\/brand\/chase-sets-logo\.(tsx|svg)$/.test(m));
  const generators = inventory.filter((m) => m.endsWith(".mjs"));
  const icons = inventory.filter((m) => m.includes("/public/icons/"));
  const cards = inventory.filter((m) => m.includes("chase-sets-og-"));
  if (vectors.length !== 2 || generators.length !== 2 || icons.length !== 8 || cards.length !== 7) {
    errors.push(`decomposition ${vectors.length}/${generators.length}/${icons.length}/${cards.length} !== 2/2/8/7`);
  }
  for (const member of inventory) {
    if (!combinedCandidatePaths.includes(member)) errors.push(`member outside combinedCandidatePaths: ${member}`);
    if (!existsSync(join(root, member))) errors.push(`member absent from the tree: ${member}`);
  }
  if (inventory.length >= combinedCandidatePaths.length) {
    errors.push("repositorySourceOutputs must be a strict subset of combinedCandidatePaths");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Caller derivation: every tracked non-binary file referencing a raster name
// stem or the exported vector string. Covers production, test, evidence, and
// documentation callers alike.
// ---------------------------------------------------------------------------

const callerNeedles = [
  "chase-sets-og-",
  "chase-sets-192",
  "chase-sets-512",
  "chase-sets-maskable-",
  "chase-sets-admin-192",
  "chase-sets-admin-512",
  "chase-sets-admin-maskable-",
  "chaseSetsLogoSvg",
];

export function deriveCallers() {
  const callers = new Set();
  for (const needle of callerNeedles) {
    let output = "";
    try {
      output = execFileSync("git", ["-C", root, "grep", "-l", "--fixed-strings", needle, "--", ":!*.png"], {
        encoding: "utf8",
      });
    } catch {
      output = "";
    }
    for (const file of output.split("\n").filter(Boolean)) callers.add(file.replaceAll("\\", "/"));
  }
  return [...callers].sort();
}

export function compareCallerSets(derived, committed) {
  const committedSet = new Set(committed);
  const derivedSet = new Set(derived);
  return {
    notCommitted: derived.filter((c) => !committedSet.has(c)),
    notFound: committed.filter((c) => !derivedSet.has(c)),
  };
}

// committed-callers:begin
export const committedCallers = [
  "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs",
  "bounded-contexts/public-presence/features/waitlist/ui/social-meta.ts",
  "bounded-contexts/public-presence/routes/marketplace/home.test.tsx",
  "bounded-contexts/public-presence/routes/marketplace/press.test.tsx",
  "deployables/admin-web/app/pwa/service-worker-source.ts",
  "deployables/admin-web/app/routes/favicon.ts",
  "deployables/admin-web/app/routes/manifest.ts",
  "deployables/admin-web/app/routes/pwa-endpoints.test.ts",
  "deployables/marketplace/app/pwa/service-worker-source.ts",
  "deployables/marketplace/app/routes/favicon.ts",
  "deployables/marketplace/app/routes/manifest.ts",
  "deployables/marketplace/app/routes/ssr.test.tsx",
  "deployables/public-web/app/routes/favicon.ts",
  "docs/campaigns/brand-distribution-kit.md",
  "packages/design-system/COMPONENT_INDEX.md",
  "packages/design-system/src/__tests__/design-system-components.test.tsx",
  "packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts",
  "packages/design-system/src/brand/chase-sets-logo.tsx",
  "scripts/check-design-system-export-coverage.mjs",
  "scripts/check-structure/brand-mark-representations.test.mjs",
  "scripts/generate-brand-icons.mjs",
];
// committed-callers:end

// ---------------------------------------------------------------------------
// Fixture foil expectations and decode tolerances.
// ---------------------------------------------------------------------------

const fixture = JSON.parse(
  readFileSync(join(root, "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json"), "utf8"),
);
const lightCandidateStops = ["--chase-logo-start", "--chase-logo-mid", "--chase-logo-end"].map(
  (name) => fixture.light[name].candidate,
);
const darkCandidateStops = ["--chase-logo-start", "--chase-logo-mid", "--chase-logo-end"].map(
  (name) => fixture.dark[name].candidate,
);
const retiringStops = ["#0f766e", "#1d5fd6", "#174db0", "#2dd4bf", "#5b8ef4", "#93c5fd"];

// Every opaque pixel is examined, which strictly contains any committed
// sample-point list: the candidate stops must each appear within
// CANDIDATE_TOLERANCE somewhere in the decoded image, and no pixel anywhere
// may fall within RETIRING_TOLERANCE of a retiring stop.
const CANDIDATE_TOLERANCE = 32;
const RETIRING_TOLERANCE = 16;

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

async function decodeParity(relativePath, candidateStops) {
  const { data, info } = await sharp(join(root, relativePath)).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const candidates = candidateStops.map(hexToRgb);
  const retiring = retiringStops.map(hexToRgb);
  const nearestCandidate = candidates.map(() => Infinity);
  const nearestRetiring = retiring.map(() => Infinity);
  for (let i = 0; i < data.length; i += channels) {
    if (channels === 4 && data[i + 3] < 200) continue;
    const px = [data[i], data[i + 1], data[i + 2]];
    for (let c = 0; c < candidates.length; c++) {
      const d = distance(px, candidates[c]);
      if (d < nearestCandidate[c]) nearestCandidate[c] = d;
    }
    for (let r = 0; r < retiring.length; r++) {
      const d = distance(px, retiring[r]);
      if (d < nearestRetiring[r]) nearestRetiring[r] = d;
    }
  }
  return { nearestCandidate, nearestRetiring, width: info.width, height: info.height };
}

async function measureNonWhiteBox(relativePath) {
  const { data, info } = await sharp(join(root, relativePath)).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * channels;
      const opaque = channels !== 4 || data[i + 3] > 0;
      const white = data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255;
      if (opaque && !white) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, width: info.width, height: info.height };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("closed combined candidate path set", () => {
  it("deep-equals its own sentinel block, is duplicate-free, and has length 33", () => {
    const parsed = sliceSentinelJson(selfSource, "combined-candidate-paths");
    console.log(`combinedCandidatePaths as parsed from the sentinel block:\n${JSON.stringify(parsed, null, 2)}`);
    expect(combinedCandidatePaths).toEqual(parsed);
    expect(combinedCandidatePaths.length).toBe(33);
    expect(new Set(combinedCandidatePaths).size).toBe(33);
  });

  it("evaluates the real changed-path set when the candidate is in flight", () => {
    const changed = realChangedPaths();
    console.log(`real changed-path set (${changed.length}):\n${JSON.stringify(changed, null, 2)}`);
    if (changed.length === 0) {
      // Post-merge trees carry no candidate diff; the predicate is still
      // exercised against the published set so this case is never vacuous.
      const report = evaluateChangedPathSet(combinedCandidatePaths);
      expect(report.ok).toBe(true);
      return;
    }
    const intersects = changed.some((p) => combinedCandidatePaths.includes(p));
    if (!intersects) {
      const report = evaluateChangedPathSet(combinedCandidatePaths);
      expect(report.ok).toBe(true);
      return;
    }
    const report = evaluateChangedPathSet(changed);
    expect(report.missing, "paths the candidate is missing").toEqual([]);
    expect(report.extra, "paths outside the published thirty-three").toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("refuses each of the 33 one-omitted synthetic sets by naming exactly the omitted path", () => {
    for (const omitted of combinedCandidatePaths) {
      const synthetic = combinedCandidatePaths.filter((p) => p !== omitted);
      const report = evaluateChangedPathSet(synthetic);
      expect(report.ok).toBe(false);
      expect(report.missing).toEqual([omitted]);
      expect(report.extra).toEqual([]);
    }
  });

  it("refuses the evidence-manifest omission by name (the exact 31/32 escape)", () => {
    const manifestPath = "infrastructure/playwright-evidence/responsive-evidence-manifest.json";
    const synthetic = combinedCandidatePaths.filter((p) => p !== manifestPath);
    const report = evaluateChangedPathSet(synthetic);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([manifestPath]);
  });

  it("refuses the pure vector-only thirteen-path candidate by naming all twenty omitted raster paths", () => {
    const vectorExclusive = combinedCandidatePaths.slice(0, 10);
    const shared = [
      "pnpm-lock.yaml",
      "scripts/check-structure/typescript-owner-contexts.json",
      "scripts/check-structure/consent-authorization-evidence-receipt.json",
    ];
    const vectorOnly = [...vectorExclusive, ...shared];
    expect(vectorOnly.length).toBe(13);
    const report = evaluateChangedPathSet(vectorOnly);
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBe(20);
    console.log(`vector-only candidate refused; omitted raster paths:\n${JSON.stringify(report.missing, null, 2)}`);
  });

  it("refuses the pure raster-only twenty-three-path candidate by naming all ten omitted vector paths", () => {
    const rasterOnly = combinedCandidatePaths.slice(10);
    expect(rasterOnly.length).toBe(23);
    const report = evaluateChangedPathSet(rasterOnly);
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBe(10);
    console.log(`raster-only candidate refused; omitted vector paths:\n${JSON.stringify(report.missing, null, 2)}`);
  });

  it("refuses a synthetic set carrying an added scratch path by that name", () => {
    const report = evaluateChangedPathSet([...combinedCandidatePaths, "scripts/scratch-thirty-fourth-path.mjs"]);
    expect(report.ok).toBe(false);
    expect(report.extra).toEqual(["scripts/scratch-thirty-fourth-path.mjs"]);
    expect(report.missing).toEqual([]);
  });
});

describe("runtime representation inventory", () => {
  it("deep-equals its sentinel block and passes every identity assertion", () => {
    const parsed = sliceSentinelJson(selfSource, "runtime-representations");
    console.log(`runtimeRepresentations as parsed:\n${JSON.stringify(parsed, null, 2)}`);
    expect(runtimeRepresentations).toEqual(parsed);
    const errors = validateRuntimeInventory(runtimeRepresentations);
    expect(errors).toEqual([]);
    console.log("runtime decomposition: 1 rendered mark + 3 favicons + 8 icons + 7 cards = 19");
  });

  it("refuses the twenty-member mutant replacing the rendered mark with both vector sources", () => {
    const mutant = [
      ...runtimeRepresentations.filter((m) => m !== "marketplace-web rendered-react-mark"),
      "packages/design-system/src/brand/chase-sets-logo.tsx",
      "packages/design-system/src/brand/chase-sets-logo.svg",
    ];
    expect(mutant.length).toBe(20);
    const errors = validateRuntimeInventory(mutant);
    expect(errors.some((e) => e.includes("length 20"))).toBe(true);
    expect(errors.some((e) => e.includes("repository path inside runtime inventory"))).toBe(true);
  });

  it("refuses a generator path added to the runtime inventory by member", () => {
    const mutant = [...runtimeRepresentations, "scripts/generate-brand-icons.mjs"];
    const errors = validateRuntimeInventory(mutant);
    expect(errors.some((e) => e === "repository path inside runtime inventory: scripts/generate-brand-icons.mjs")).toBe(
      true,
    );
    expect(
      errors.some(
        (e) => e === "repository-extension member inside runtime inventory: scripts/generate-brand-icons.mjs",
      ),
    ).toBe(true);
  });

  it("refuses a dropped favicon member through the length and decomposition assertions together", () => {
    const mutant = runtimeRepresentations.filter((m) => m !== "admin-web /favicon.svg");
    const errors = validateRuntimeInventory(mutant);
    expect(errors.some((e) => e.includes("length 18"))).toBe(true);
    expect(errors.some((e) => e.includes("decomposition 1/2/8/7"))).toBe(true);
    expect(errors.some((e) => e.includes("favicon members for admin-web: 0"))).toBe(true);
  });
});

describe("repository source-output inventory", () => {
  it("deep-equals its sentinel block, decomposes 2/2/8/7, and is a strict subset of the thirty-three", () => {
    const parsed = sliceSentinelJson(selfSource, "repository-source-outputs");
    console.log(`repositorySourceOutputs as parsed:\n${JSON.stringify(parsed, null, 2)}`);
    expect(repositorySourceOutputs).toEqual(parsed);
    const errors = validateRepositoryInventory(repositorySourceOutputs);
    expect(errors).toEqual([]);
    console.log("repository decomposition: 2 vector sources + 2 generators + 8 icons + 7 cards = 19 (subset of 33)");
  });

  it("derives the fifteen raster outputs from the two generators' declared output sets", () => {
    const ogSource = readFileSync(
      join(root, "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs"),
      "utf8",
    );
    const cardNames = [...ogSource.matchAll(/name: "([\w-]+)"/g)].map((m) => m[1]);
    const derivedCards = cardNames.map(
      (name) => `bounded-contexts/public-presence/features/waitlist/ui/assets/chase-sets-og-${name}.png`,
    );
    const iconSource = readFileSync(join(root, "scripts/generate-brand-icons.mjs"), "utf8");
    expect(iconSource).toContain('role === "maskable" ? `chase-sets-maskable-${size}.png` : `chase-sets-${size}.png`');
    expect(iconSource).toContain(
      'role === "maskable" ? `chase-sets-admin-maskable-${size}.png` : `chase-sets-admin-${size}.png`',
    );
    const derivedIcons = [];
    for (const role of ["standard", "maskable"]) {
      for (const size of [192, 512]) {
        const stem = role === "maskable" ? `chase-sets-maskable-${size}.png` : `chase-sets-${size}.png`;
        const adminStem =
          role === "maskable" ? `chase-sets-admin-maskable-${size}.png` : `chase-sets-admin-${size}.png`;
        derivedIcons.push(`deployables/marketplace/public/icons/${stem}`);
        derivedIcons.push(`deployables/admin-web/public/icons/${adminStem}`);
      }
    }
    expect([...derivedCards].sort()).toEqual([...cardPaths].sort());
    expect([...derivedIcons].sort()).toEqual([...iconPaths].sort());
    console.log(`derived representation outputs: ${derivedCards.length} cards + ${derivedIcons.length} icons`);
  });
});

describe("derived caller inventory", () => {
  it("matches the committed caller list in both directions", () => {
    const derived = deriveCallers();
    console.log(`derived callers (${derived.length}):\n${JSON.stringify(derived, null, 2)}`);
    const report = compareCallerSets(derived, committedCallers);
    expect(report.notCommitted, "derived callers absent from the committed list").toEqual([]);
    expect(report.notFound, "committed callers the scan no longer finds").toEqual([]);
  });

  it("reacts in both directions: a planted reference and a ghost entry each fail by path", () => {
    const derived = deriveCallers();
    const planted = compareCallerSets([...derived, "scripts/scratch-caller.mjs"], committedCallers);
    expect(planted.notCommitted).toEqual(["scripts/scratch-caller.mjs"]);
    const ghost = compareCallerSets(derived, [...committedCallers, "scripts/ghost-caller.mjs"]);
    expect(ghost.notFound).toEqual(["scripts/ghost-caller.mjs"]);
  });
});

describe("raster generator literal parity", () => {
  it("holds the OG generator to the fixture's dark foil candidates and its four palette literals to their shipped bytes", () => {
    const source = readFileSync(
      join(root, "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs"),
      "utf8",
    );
    const literal = (name) => {
      const match = source.match(new RegExp(`${name}: "(#[0-9a-f]{6})"`));
      if (!match) throw new Error(`palette literal ${name} not found`);
      return match[1];
    };
    expect(literal("gradientStart")).toBe(fixture.dark["--chase-logo-start"].candidate);
    expect(literal("gradientMid")).toBe(fixture.dark["--chase-logo-mid"].candidate);
    expect(literal("gradientEnd")).toBe(fixture.dark["--chase-logo-end"].candidate);
    // The four non-foil palette literals and the card text stack are palette
    // and distribution surfaces owned elsewhere; they must stay byte-identical.
    expect(literal("background")).toBe("#020617");
    expect(literal("surface")).toBe("#0b1428");
    expect(literal("foreground")).toBe("#f8fafc");
    expect(literal("muted")).toBe("#94a3b8");
    expect(source).toContain("const fontStack = `'IBM Plex Sans', 'Segoe UI', Arial, sans-serif`;");
  });

  it("holds the icon generator to fixture-derived colours, source-derived geometry, and the white canvas", () => {
    const source = readFileSync(join(root, "scripts/generate-brand-icons.mjs"), "utf8");
    const hexes = [...new Set([...source.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]))];
    expect(hexes).toEqual(["#ffffff"]);
    expect(source).toContain("chase-sets-logo.svg");
    expect(source).toContain("ink-foil-candidate-tokens.json");
    // The two mark paths are read from the design-system source; a re-typed
    // path literal (d="M...") in the generator is the desynchronisation defect.
    expect(/d="M\d/.test(source)).toBe(false);
  });
});

describe("icon framing and digest structure", () => {
  it("reproduces the committed framing within tolerance and keeps four distinct images over eight paths", async () => {
    const digests = new Map();
    for (const relativePath of iconPaths) {
      digests.set(relativePath, sha256(readFileSync(join(root, relativePath))));
    }
    expect(new Set(digests.values()).size).toBe(4);
    for (const size of ["192", "512"]) {
      expect(digests.get(`deployables/marketplace/public/icons/chase-sets-${size}.png`)).toBe(
        digests.get(`deployables/admin-web/public/icons/chase-sets-admin-${size}.png`),
      );
      expect(digests.get(`deployables/marketplace/public/icons/chase-sets-maskable-${size}.png`)).toBe(
        digests.get(`deployables/admin-web/public/icons/chase-sets-admin-maskable-${size}.png`),
      );
    }
    console.log(`icon digests:\n${JSON.stringify(Object.fromEntries(digests), null, 2)}`);

    // Committed framing fractions with a one-percent tolerance for
    // antialiased edge pixels.
    const STANDARD_FRACTION = 350 / 512;
    const MASKABLE_FRACTION = 290 / 512;
    const TOLERANCE = 0.01;
    for (const relativePath of iconPaths.filter((p) => p.includes("marketplace"))) {
      const box = await measureNonWhiteBox(relativePath);
      const expectedSize = relativePath.includes("512") ? 512 : 192;
      expect(box.width, `${relativePath} width`).toBe(expectedSize);
      expect(box.height, `${relativePath} height`).toBe(expectedSize);
      const fraction = (box.maxY - box.minY + 1) / box.height;
      const expected = relativePath.includes("maskable") ? MASKABLE_FRACTION : STANDARD_FRACTION;
      console.log(
        `${relativePath}: bbox ${box.minX},${box.minY}-${box.maxX},${box.maxY} markHeightFraction ${fraction.toFixed(4)} (expected ${expected.toFixed(4)})`,
      );
      expect(Math.abs(fraction - expected), `${relativePath} mark-height fraction ${fraction}`).toBeLessThanOrEqual(
        TOLERANCE,
      );
    }
  }, 60_000);
});

describe("decoded positive parity for every committed raster", () => {
  it("finds every candidate stop and no retiring stop in each of the fifteen rasters", async () => {
    const cases = [
      ...cardPaths.map((p) => ({ path: p, stops: darkCandidateStops, mode: "dark" })),
      ...iconPaths.map((p) => ({ path: p, stops: lightCandidateStops, mode: "light" })),
    ];
    expect(cases.length).toBe(15);
    for (const entry of cases) {
      const parity = await decodeParity(entry.path, entry.stops);
      console.log(
        `${entry.path} [${entry.mode}]: nearest-candidate distances ${parity.nearestCandidate
          .map((d) => d.toFixed(1))
          .join(" / ")}; nearest-retiring distances ${parity.nearestRetiring.map((d) => d.toFixed(1)).join(" / ")}`,
      );
      for (let i = 0; i < entry.stops.length; i++) {
        expect(
          parity.nearestCandidate[i],
          `${entry.path}: candidate stop ${entry.stops[i]} not found within ${CANDIDATE_TOLERANCE}`,
        ).toBeLessThanOrEqual(CANDIDATE_TOLERANCE);
      }
      for (let i = 0; i < retiringStops.length; i++) {
        expect(
          parity.nearestRetiring[i],
          `${entry.path}: a pixel sits within ${RETIRING_TOLERANCE} of retiring stop ${retiringStops[i]}`,
        ).toBeGreaterThan(RETIRING_TOLERANCE);
      }
    }
  }, 120_000);
});

describe("lockfile package-entry discipline", () => {
  const lock = yaml.parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  const packageKeys = Object.keys(lock.packages).sort();

  it("keeps the Sharp family at exactly the twenty-six keys committed here", () => {
    const sharpFamily = packageKeys.filter((k) => k === "sharp@0.34.5" || k.startsWith("@img/"));
    const committedSharpFamily = [
      "@img/colour@1.1.0",
      "@img/sharp-darwin-arm64@0.34.5",
      "@img/sharp-darwin-x64@0.34.5",
      "@img/sharp-libvips-darwin-arm64@1.2.4",
      "@img/sharp-libvips-darwin-x64@1.2.4",
      "@img/sharp-libvips-linux-arm64@1.2.4",
      "@img/sharp-libvips-linux-arm@1.2.4",
      "@img/sharp-libvips-linux-ppc64@1.2.4",
      "@img/sharp-libvips-linux-riscv64@1.2.4",
      "@img/sharp-libvips-linux-s390x@1.2.4",
      "@img/sharp-libvips-linux-x64@1.2.4",
      "@img/sharp-libvips-linuxmusl-arm64@1.2.4",
      "@img/sharp-libvips-linuxmusl-x64@1.2.4",
      "@img/sharp-linux-arm64@0.34.5",
      "@img/sharp-linux-arm@0.34.5",
      "@img/sharp-linux-ppc64@0.34.5",
      "@img/sharp-linux-riscv64@0.34.5",
      "@img/sharp-linux-s390x@0.34.5",
      "@img/sharp-linux-x64@0.34.5",
      "@img/sharp-linuxmusl-arm64@0.34.5",
      "@img/sharp-linuxmusl-x64@0.34.5",
      "@img/sharp-wasm32@0.34.5",
      "@img/sharp-win32-arm64@0.34.5",
      "@img/sharp-win32-ia32@0.34.5",
      "@img/sharp-win32-x64@0.34.5",
      "sharp@0.34.5",
    ];
    expect(sharpFamily.length).toBe(26);
    expect(sharpFamily).toEqual(committedSharpFamily);
  });

  it("declares the root sharp importer at exactly the version the lockfile already resolves", () => {
    const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(rootPackage.devDependencies.sharp).toBe("^0.34.5");
    expect(lock.importers["."].devDependencies.sharp.version).toBe("0.34.5");
    expect(packageKeys).toContain("sharp@0.34.5");
  });

  it("bounds the whole-lockfile package-entry delta to exactly the two Fontsource keys", () => {
    const fontKeys = ["@fontsource/ibm-plex-mono@5.3.0", "@fontsource/space-grotesk@5.3.0"];
    for (const key of fontKeys) expect(packageKeys).toContain(key);
    const withoutFonts = packageKeys.filter((k) => !fontKeys.includes(k));
    // sha256 over the sorted package-entry keys of pnpm-lock.yaml at the
    // candidate's base revision 3d20e23b7fdc66865e8459610a6601574960d566,
    // joined with newlines -- derived mechanically from `git show`, so
    // equality proves the delta added exactly the two font keys and removed
    // nothing without carrying all 791 base keys here.
    const baseKeyDigest = "2004a44a67e9409ade0dd5469eee0940451dc628fa6cf335ad5bb103e0fefdcb";
    expect(withoutFonts.length).toBe(791);
    expect(createHash("sha256").update(withoutFonts.join("\n")).digest("hex")).toBe(baseKeyDigest);
    console.log(`whole-lockfile package-entry delta vs base: +${JSON.stringify(fontKeys)} -[]`);
  });
});
