import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  brandFoilRegistry,
  discoverBrandFoilSites,
  lexicalLaw,
  validateBrandFoilDiscovery,
} from "./brand-foil-sites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validatorPath = "scripts/check-structure/brand-foil-sites.mjs";
const proofPath = "scripts/check-structure/brand-foil-proof.mjs";
const runPath = "scripts/check-structure/run.mjs";
import {
  assertProofArguments,
  inspectProofCandidate,
  snapshotProofRepository,
  withProofClone,
  withProofMutation,
  omitBrandFoilRegistration,
  proofEnvironment,
} from "./brand-foil-proof.mjs";
const temporaryRoots = [];
const proofRows = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
const write = (cwd, name, content) => {
  mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  writeFileSync(path.join(cwd, name), content);
};
function temporaryRepo(source) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "brand-foil-"));
  temporaryRoots.push(directory);
  if (source) git(path.dirname(directory), ["clone", "--quiet", "--shared", "--no-checkout", "--", source, directory]);
  else git(directory, ["init", "--quiet"]);
  return directory;
}
function removeTemporaryRepo(directory) {
  const resolved = path.resolve(directory);
  if (!temporaryRoots.includes(resolved) || !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error("Not an owned temporary repository");
  rmSync(resolved, { recursive: true, force: true });
}
afterAll(() => {
  for (const directory of temporaryRoots) removeTemporaryRepo(directory);
  if (process.env.BRAND_FOIL_PROOF_PATH)
    writeFileSync(process.env.BRAND_FOIL_PROOF_PATH, JSON.stringify(proofRows, null, 2));
});

describe("proof CLI boundaries and cleanup", () => {
  function committedFixture() {
    const directory = temporaryRepo();
    write(directory, runPath, readFileSync(path.join(root, runPath)));
    write(directory, ".gitignore", "node_modules/\n");
    git(directory, ["add", "--all"]);
    git(directory, [
      "-c",
      "user.name=Proof fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Synthetic proof fixture",
    ]);
    git(directory, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    return directory;
  }

  it("rejects unsupported arguments before any proof work", () => {
    expect(() => assertProofArguments([])).not.toThrow();
    for (const args of [["--root", root], ["--help"], [root]]) {
      expect(() => assertProofArguments(args)).toThrow("no arguments");
    }
    const child = spawnSync(process.execPath, [path.join(root, proofPath), "--root", root], {
      cwd: root,
      encoding: "utf8",
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("no arguments");
    expect(child.stdout).not.toContain("Brand foil proof candidate:");
  });
  it("requires invocation from the module's actual root", () => {
    const directory = temporaryRepo();
    const child = spawnSync(process.execPath, [path.join(root, proofPath)], { cwd: directory, encoding: "utf8" });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("real repository root");
    expect(child.stdout).toBe("");
  });
  it("imports helpers without executing the proof", () => {
    const directory = temporaryRepo();
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(new URL("./brand-foil-proof.mjs", import.meta.url).href)})`,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
  });
  it("refuses a non-Git source even with ambient changed files", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "brand-foil-"));
    temporaryRoots.push(directory);
    expect(() => inspectProofCandidate(directory, directory)).toThrow();
    const result = validateBrandFoilDiscovery(discoverBrandFoilSites(directory), []);
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toContain("Git index");
  });
  it("refuses missing HEAD before cloning", () => {
    const directory = temporaryRepo();
    expect(() => inspectProofCandidate(directory, directory)).toThrow();
  });
  it("refuses missing base despite populated ambient scope", () => {
    const directory = committedFixture();
    git(directory, ["update-ref", "-d", "refs/remotes/origin/main"]);
    expect(() => inspectProofCandidate(directory, directory)).toThrow();
  });
  it.each(["unstaged", "staged", "untracked"])("refuses a %s candidate without modifying its index", (kind) => {
    const directory = committedFixture();
    const name = kind === "untracked" ? "untracked.txt" : runPath;
    write(directory, name, "changed bytes");
    if (kind === "staged") git(directory, ["add", "--", name]);
    const before = snapshotProofRepository(directory);
    expect(() => inspectProofCandidate(directory, directory)).toThrow("clean committed candidate");
    expect(snapshotProofRepository(directory)).toEqual(before);
  });
  it("requires exactly one import and fold and retains all unrelated bytes", () => {
    const source = readFileSync(path.join(root, runPath), "utf8");
    const omission = omitBrandFoilRegistration(source);
    expect(omission.spans).toHaveLength(2);
    for (const span of omission.spans) {
      expect(() => omitBrandFoilRegistration(source.replace(span.target, ""))).toThrow("exactly one");
      expect(() => omitBrandFoilRegistration(source + span.target)).toThrow("exactly one");
    }
    let reconstructed = omission.source;
    for (const span of omission.spans)
      reconstructed = reconstructed.slice(0, span.start) + span.target + reconstructed.slice(span.start);
    expect(reconstructed).toBe(source);
    expect(hash(omission.source)).toBe(omission.retainedSha256);
  });
  it.each([false, true])("restores source and clone bytes/index on injected failure=%s", (fail) => {
    const directory = committedFixture();
    const before = snapshotProofRepository(directory);
    const candidate = inspectProofCandidate(directory, directory);
    const messages = [];
    let ownedClone;
    const execute = () =>
      withProofClone(
        candidate,
        (clone) => {
          ownedClone = clone;
          const cloneBefore = snapshotProofRepository(clone);
          try {
            return withProofMutation(
              clone,
              () => {
                write(clone, runPath, "mutated run bytes");
                if (fail) throw new Error("injected mutation failure");
                return "completed";
              },
              (line) => messages.push(line),
            );
          } finally {
            expect(snapshotProofRepository(clone)).toEqual(cloneBefore);
            expect(existsSync(path.join(clone, "scripts/opaque-violation.data"))).toBe(false);
          }
        },
        (line) => messages.push(line),
      );
    if (fail) expect(execute).toThrow("injected mutation failure");
    else expect(execute()).toBe("completed");
    expect(existsSync(path.dirname(ownedClone))).toBe(false);
    expect(snapshotProofRepository(directory)).toEqual(before);
    expect(messages.some((line) => line.includes("owned temporary clone removed"))).toBe(true);
  });
  it("binds all candidate paths and mutations independently of ambient scope", () => {
    const directory = committedFixture();
    write(directory, "new-candidate.txt", "candidate");
    git(directory, ["add", "--all"]);
    git(directory, [
      "-c",
      "user.name=Proof fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Synthetic candidate change",
    ]);
    const candidate = inspectProofCandidate(directory, directory);
    for (const ambient of ["[]", "{", '["unrelated.txt"]']) {
      const env = proofEnvironment(candidate, { CHANGED_FILES_JSON: ambient, SENTINEL: "preserved" });
      expect(JSON.parse(env.CHANGED_FILES_JSON)).toEqual([
        "new-candidate.txt",
        runPath,
        "scripts/opaque-violation.data",
      ]);
      expect(env.SENTINEL).toBe("preserved");
    }
  });
});

describe("existing structure command enrollment", () => {
  const command = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts["check:structure"];
  function wiringFixture() {
    const directory = temporaryRepo();
    for (const [name, label, statusName] of [
      ["scripts/check-structure.mjs", "aggregate", "AGGREGATE_STATUS"],
      [proofPath, "proof", "PROOF_STATUS"],
    ]) {
      write(
        directory,
        name,
        `import { appendFileSync } from "node:fs";\nappendFileSync("trace.txt", "${label}\\n");\nprocess.exitCode = Number(process.env.${statusName});\n`,
      );
    }
    return directory;
  }
  it.each([
    [0, 0, ["aggregate", "proof"], 0],
    [7, 0, ["aggregate"], 7],
    [0, 9, ["aggregate", "proof"], 9],
  ])("runs the actual command in order and propagates aggregate=%s/proof=%s", (aggregate, proof, expected, exit) => {
    const directory = wiringFixture();
    const child = spawnSync(command, {
      cwd: directory,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, AGGREGATE_STATUS: String(aggregate), PROOF_STATUS: String(proof) },
    });
    expect(child.status, child.stderr).toBe(exit);
    expect(readFileSync(path.join(directory, "trace.txt"), "utf8").trim().split("\n")).toEqual(expected);
  });
  it("turns enrollment evidence red when only the proof command is omitted", () => {
    const parts = command.split(/\s*&&\s*/);
    expect(parts).toEqual(["node ./scripts/check-structure.mjs", `node ./${proofPath}`]);
    const directory = wiringFixture();
    const child = spawnSync(parts[0], {
      cwd: directory,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, AGGREGATE_STATUS: "0", PROOF_STATUS: "0" },
    });
    expect(child.status).toBe(0);
    const trace = readFileSync(path.join(directory, "trace.txt"), "utf8").trim().split("\n");
    expect(() => expect(trace).toEqual(["aggregate", "proof"])).toThrow();
  });
});

// Independent input examples: expected detectors are explicit, not computed by the classifier.
function lexicalCases() {
  return [
    ["lower-six", "#8a682a", "raw"],
    ["upper-six", "#8A682A", "raw"],
    ["alpha-ff", "#8a682aff", "raw"],
    ["alpha-80", "#8A682A80", "raw"],
    ["alpha-gradient", "linear-gradient(#8a682aff, #edd28d80)", "raw"],
    ["dark-property", "--dark-chase-logo-end", "literal"],
    ["var", "var(--chase-logo-start)", "literal"],
    ["identifier", "chaseLogoMid", "literal"],
    ["raw-stop", "#d4a94e", "raw"],
    ["constructor", "`--chase-logo-${stop}`", "constructor"],
    ["one-alpha", "#8a682aF", null],
    ["three-alpha", "#8a682aff0", null],
    ["long-run", "#8a682aff012345", null],
    ["near-stop", "#8a682b", null],
    ["width-constructor", "`--chase-logo-${width}`", null],
    ["width-property", "--chase-logo-width", null],
    ["width-identifier", "chaseLogoWidth", null],
    ["property-suffix", "--chase-logo-start-extra", null],
    ["identifier-suffix", "chaseLogoMidValue", null],
    ["constructor-suffix", "`--chase-logo-${stop}-extra`", null],
    ["property-prefix", "x--chase-logo-start", null],
    ["identifier-prefix", "otherchaseLogoMid", null],
    ["constructor-prefix", "x--chase-logo-${stop}", null],
    ["raw-prefix", "a#8a682a", null],
    ["unrelated-prose", "brand foil is distinct from holofoil", null],
    ["unrelated-gradient", "linear-gradient(#fff, #000)", null],
    ["rgb", "rgb(138,104,42)", null],
    ["hsl", "hsl(39,53%,35%)", null],
  ];
}

// One independently authored misuse for each issue-table path, not registry-generated examples.
function misplacedUses() {
  return [
    ["packages/design-system/src/styles/styles.css", "\nbutton { background: var(--chase-logo-start); }\n", "literal"],
    [
      "packages/design-system/src/theme/tokens.ts",
      '\nconst buttonFill = { chaseLogoStart: "var(--chase-logo-start)" };\n',
      "literal",
    ],
    [
      "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
      '\n"buttonFill": "#8a682a"',
      "raw",
    ],
    [
      "packages/design-system/src/brand/chase-sets-logo.tsx",
      '\nconst button = <button style={{ background: "var(--chase-logo-start)" }} />;\n',
      "literal",
    ],
    ["packages/design-system/src/brand/chase-sets-logo.svg", '\n<rect fill="#8a682a"/>', "raw"],
    ["scripts/generate-brand-icons.mjs", "\nconst buttonFill = `--chase-logo-${stop}`;\n", "constructor"],
    [
      "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs",
      '\nconst buttonPalette = { fill: "#b9863b" };\n',
      "raw",
    ],
    [
      "packages/design-system/src/__tests__/design-system-components.test.tsx",
      '\nfunction unrelatedButton() { return "var(--chase-logo-mid)"; }\n',
      "literal",
    ],
    [
      "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
      '\nconst buttonColour = getComputedStyle(button).getPropertyValue("--chase-logo-start");\n',
      "literal",
    ],
    [
      "scripts/check-structure/brand-mark-representations.test.mjs",
      '\nconst unrelatedArray = ["--chase-logo-start"];\n',
      "literal",
    ],
    ["packages/design-system/README.md", "\nButtons may use `var(--chase-logo-start)` for fill.\n", "literal"],
    ["scripts/check-structure/brand-foil-sites.mjs", '\nconsole.log("var(--chase-logo-start)");\n', "literal"],
    [
      "scripts/check-structure/brand-foil-sites.test.mjs",
      '\nconst unrelatedSample = "var(--chase-logo-start)";\n',
      "literal",
    ],
    [
      "scripts/check-structure/brand-foil-proof.mjs",
      '\nfunction unrelatedProofHelper() { return "#8a682a"; }\n',
      "raw",
    ],
  ];
}

const requiredLexicalIds = [
  "lower-six",
  "upper-six",
  "alpha-ff",
  "alpha-80",
  "alpha-gradient",
  "dark-property",
  "var",
  "identifier",
  "raw-stop",
  "constructor",
  "one-alpha",
  "three-alpha",
  "long-run",
  "near-stop",
  "width-constructor",
  "width-property",
  "width-identifier",
  "property-suffix",
  "identifier-suffix",
  "constructor-suffix",
  "property-prefix",
  "identifier-prefix",
  "constructor-prefix",
  "raw-prefix",
  "unrelated-prose",
  "unrelated-gradient",
  "rgb",
  "hsl",
];
const sameIds = (rows, expected) =>
  rows.length === expected.length && new Set(rows).size === rows.length && rows.every((id) => expected.includes(id));
// Independently transcribed ordered carrier table; neither registry nor mutants derive this list.
const requiredCarrierPaths = [
  "packages/design-system/src/styles/styles.css",
  "packages/design-system/src/theme/tokens.ts",
  "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
  "packages/design-system/src/brand/chase-sets-logo.tsx",
  "packages/design-system/src/brand/chase-sets-logo.svg",
  "scripts/generate-brand-icons.mjs",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs",
  "packages/design-system/src/__tests__/design-system-components.test.tsx",
  "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
  "scripts/check-structure/brand-mark-representations.test.mjs",
  "packages/design-system/README.md",
  "scripts/check-structure/brand-foil-sites.mjs",
  "scripts/check-structure/brand-foil-sites.test.mjs",
  "scripts/check-structure/brand-foil-proof.mjs",
];
function freezeDiscovery(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freezeDiscovery(child);
  return Object.freeze(value);
}
let canonical;
let clean;
beforeAll(() => {
  canonical = temporaryRepo();
  for (const name of requiredCarrierPaths) write(canonical, name, readFileSync(path.join(root, name)));
  git(canonical, ["add", "--all"]);
  clean = freezeDiscovery(discoverBrandFoilSites(canonical));
});

describe("closed lexical law", () => {
  it("requires every independently named case, including one-row omission controls", () => {
    const ids = lexicalCases().map(([id]) => id);
    expect(sameIds(ids, requiredLexicalIds)).toBe(true);
    for (const omitted of ids)
      expect(
        sameIds(
          ids.filter((id) => id !== omitted),
          requiredLexicalIds,
        ),
      ).toBe(false);
  });
  it.each(lexicalCases())("classifies %s through real tracked arbitrary-path discovery", (id, text, detector) => {
    const directory = temporaryRepo();
    const name = "unrelated folder/opaque input-Ã©.data";
    write(directory, name, text);
    git(directory, ["add", "--all"]);
    const discovery = discoverBrandFoilSites(directory);
    const result = validateBrandFoilDiscovery(discovery, []);
    expect(result.summary.tracked).toBe(1);
    expect(result.summary.scanned).toBe(1);
    expect(result.summary.allowed + result.summary.violations).toBe(result.summary.union);
    expect(result.ok).toBe(detector === null);
    proofRows.push({
      kind: "lexical",
      id,
      expectedExit: detector ? 1 : 0,
      actualExit: result.ok ? 0 : 1,
      detector,
      summary: result.summary,
    });
    expect(discovery.carriers.flatMap((carrier) => carrier.occurrences.map((hit) => hit.detector))).toEqual(
      detector ? Array(id === "alpha-gradient" ? 2 : 1).fill(detector) : [],
    );
    console.log(
      JSON.stringify({
        id,
        expectedExit: detector ? 1 : 0,
        actualExit: result.ok ? 0 : 1,
        detector,
        ...result.summary,
      }),
    );
  });
  it("derives the closed names and values from the actual authorities", () => {
    const fixture = JSON.parse(readFileSync(path.join(root, brandFoilRegistry[2].path), "utf8"));
    const tokens = readFileSync(path.join(root, brandFoilRegistry[1].path), "utf8");
    for (const mode of ["light", "dark"]) {
      expect(lexicalLaw.properties.slice(0, 3).map((name) => fixture[mode][name].candidate)).toEqual(lexicalLaw[mode]);
    }
    for (const name of lexicalLaw.identifiers) expect(tokens).toContain(`${name}: string;`);
    expect(new Set(lexicalLaw.properties).size).toBe(6);
    expect(new Set(lexicalLaw.identifiers).size).toBe(3);
  });
});

describe("occurrence owners and complete accounting", () => {
  it("admits every actual canonical expression and pins the measured role partition", () => {
    const result = validateBrandFoilDiscovery(clean);
    proofRows.push({ kind: "canonical", ...result });
    console.log(JSON.stringify(result, null, 2));
    expect(result.violations).toEqual([]);
    expect(result.summary).toMatchObject({
      tracked: 14,
      scanned: 14,
      literal: 11,
      raw: 9,
      constructor: 3,
      token: 12,
      union: 14,
      allowed: 14,
      violations: 0,
    });
    expect(result.summary.roles).toEqual({
      "value-authority": 3,
      wordmark: 2,
      "wordmark-raster-generator": 2,
      verification: 4,
      documentation: 1,
      "detector-definition": 2,
    });
  });
  it("has exactly the issue's 14 mutation paths and rejects omission of any one row", () => {
    const ids = misplacedUses().map(([name]) => name);
    const expected = requiredCarrierPaths;
    expect(expected).toHaveLength(14);
    expect(brandFoilRegistry.map((entry) => entry.path)).toEqual(expected);
    expect(ids).toEqual(expected);
    expect(sameIds(ids, expected)).toBe(true);
    for (const omitted of expected)
      expect(
        sameIds(
          ids.filter((id) => id !== omitted),
          expected,
        ),
      ).toBe(false);
  });
  it.each(misplacedUses())("rejects misplaced use and reveals validator omission: %s", (name, addition, detector) => {
    const original = readFileSync(path.join(canonical, name));
    let mutated = original.toString("utf8") + addition;
    if (name.endsWith(".json")) mutated = original.toString("utf8").replace(/}\s*$/, `,${addition}\n}`);
    if (name.endsWith(".svg")) mutated = original.toString("utf8").replace("</svg>", `${addition}\n</svg>`);
    try {
      write(canonical, name, mutated);
      const discovered = discoverBrandFoilSites(canonical);
      const result = validateBrandFoilDiscovery(discovered);
      expect(result.ok).toBe(false);
      expect(
        result.violations.some(
          (message) => message.includes(name) && message.includes(detector) && message.includes("expression="),
        ),
      ).toBe(true);
      // Freeze discovery, lexical classification, all other rows, and the clean registry.
      // Removing only this row's role-expression enforcement recreates the path-only bug.
      const bypass = brandFoilRegistry.map((entry) =>
        entry.path !== name
          ? entry
          : {
              ...entry,
              counts: ["literal", "raw", "constructor"].map(
                (kind) =>
                  discovered.carriers
                    .find((carrier) => carrier.path === name)
                    .occurrences.filter((hit) => hit.detector === kind).length,
              ),
              validate: (source) => [{ id: "omitted-validator", count: 1, spans: [[0, source.length]] }],
            },
      );
      const falseGreen = validateBrandFoilDiscovery(discovered, bypass);
      proofRows.push({
        kind: "validator-omission",
        name,
        detector,
        candidateExit: result.ok ? 0 : 1,
        bypassExit: falseGreen.ok ? 0 : 1,
        summary: result.summary,
        errors: result.violations,
      });
      expect(falseGreen.violations).toEqual([]);
      const assertionUnderAttack = (report) => expect(report.ok).toBe(false);
      expect(() => assertionUnderAttack(result)).not.toThrow();
      expect(() => assertionUnderAttack(falseGreen)).toThrow();
      console.log(
        JSON.stringify({
          name,
          detector,
          role: brandFoilRegistry.find((entry) => entry.path === name).role,
          candidateExit: 1,
          bypassExit: 0,
          omissionAssertionExit: 1,
          scanned: discovered.scanned,
          tracked: discovered.tracked,
          errors: result.violations,
        }),
      );
    } finally {
      write(canonical, name, original);
    }
    expect(readFileSync(path.join(canonical, name))).toEqual(original);
  });
  it.each(requiredCarrierPaths)("rejects registry removal: %s", (name) => {
    const result = validateBrandFoilDiscovery(
      clean,
      brandFoilRegistry.filter((row) => row.path !== name),
    );
    expect(result.violations.some((message) => message.includes(name) && message.includes("unregistered"))).toBe(true);
    expect(result.summary.scanned).toBe(result.summary.tracked);
    console.log(
      JSON.stringify({
        kind: "registry-removal",
        name,
        expectedExit: 1,
        actualExit: result.ok ? 0 : 1,
        summary: result.summary,
      }),
    );
  });
  it("rejects a stale absent registry entry", () => {
    expect(
      validateBrandFoilDiscovery(clean, [...brandFoilRegistry, { ...brandFoilRegistry[0], path: "absent.css" }]).ok,
    ).toBe(false);
  });
  it("rejects a duplicate registry entry", () => {
    expect(validateBrandFoilDiscovery(clean, [...brandFoilRegistry, brandFoilRegistry[0]]).ok).toBe(false);
  });
  it("rejects a swapped registry validator", () => {
    const swapped = brandFoilRegistry.map((entry, index) =>
      index === 0 ? { ...entry, validate: brandFoilRegistry[1].validate } : entry,
    );
    expect(validateBrandFoilDiscovery(clean, swapped).ok).toBe(false);
  });
  it("rejects a wrong registry role", () => {
    const wrongRole = brandFoilRegistry.map((entry, index) => (index === 0 ? { ...entry, role: "wordmark" } : entry));
    expect(
      validateBrandFoilDiscovery(clean, wrongRole).violations.some((message) => message.includes("expression=role")),
    ).toBe(true);
  });
  it("does not admit a moved legitimate declaration just because cardinality is unchanged", () => {
    const name = brandFoilRegistry[0].path;
    const original = readFileSync(path.join(canonical, name));
    const declaration = `${lexicalLaw.properties[0]}: ${lexicalLaw.light[0]};`;
    try {
      write(canonical, name, original.toString("utf8").replace(declaration, "") + `\nbutton { ${declaration} }\n`);
      const discovered = discoverBrandFoilSites(canonical);
      expect(discovered.carriers.find((row) => row.path === name).occurrences.length).toBe(
        clean.carriers.find((row) => row.path === name).occurrences.length,
      );
      expect(validateBrandFoilDiscovery(discovered).ok).toBe(false);
    } finally {
      write(canonical, name, original);
    }
  });
  it.each([
    ["scripts/generate-brand-icons.mjs", '["start", "mid", "end"].map', '["start", "mid", "end", "width"].map'],
    [
      "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
      "hexToRgbString(fixture[mode][name]!.candidate)",
      "button.style.background",
    ],
    [
      "scripts/check-structure/brand-mark-representations.test.mjs",
      "fixture.light[name].candidate",
      "button.style.background",
    ],
    ["packages/design-system/src/brand/chase-sets-logo.tsx", 'offset="0.52" stopColor=', 'offset="0.99" stopColor='],
    ["packages/design-system/src/brand/chase-sets-logo.svg", "<style>", "<g><style>"],
  ])("binds lexical expressions to their complete owner: %s", (name, before, after) => {
    const original = readFileSync(path.join(canonical, name));
    const changed = original.toString("utf8").replace(before, after);
    expect(changed).not.toBe(original.toString("utf8"));
    try {
      write(canonical, name, name.endsWith(".svg") ? changed.replace("</style>", "</style></g>") : changed);
      const discovered = discoverBrandFoilSites(canonical);
      const result = validateBrandFoilDiscovery(discovered);
      expect(discovered.carriers.find((carrier) => carrier.path === name).occurrences).toHaveLength(
        clean.carriers.find((carrier) => carrier.path === name).occurrences.length,
      );
      expect(result.ok).toBe(false);
      proofRows.push({ kind: "owner-shape", name, status: result.ok ? 0 : 1, errors: result.violations });
    } finally {
      write(canonical, name, original);
    }
  });
  it("reads NUL bytes, arbitrary validator-directory files, and excludes ignored/untracked outputs", () => {
    const directory = temporaryRepo();
    const signature = lexicalCases().find(([id]) => id === "var")[1];
    const name = "scripts/check-structure/unrelated.mjs";
    write(directory, name, Buffer.from(`before\0${signature}`));
    write(directory, ".gitignore", "dist/\n");
    git(directory, ["add", "--all"]);
    const before = discoverBrandFoilSites(directory);
    write(directory, "dist/generated.mjs", signature);
    write(directory, "ordinary-untracked.mjs", signature);
    expect(discoverBrandFoilSites(directory)).toEqual(before);
    expect(before.nul).toBe(1);
    expect(before.scanned).toBe(before.tracked);
    const child = spawnSync(process.execPath, [path.join(root, validatorPath)], { cwd: directory, encoding: "utf8" });
    proofRows.push({ kind: "nul-standalone", status: child.status, stdout: child.stdout, stderr: child.stderr });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(name);
    expect(child.stderr).toContain("literal");
    expect(child.stdout).toContain('"scanned":2');
    console.log(`NUL standalone exit=${child.status}\n${child.stdout}${child.stderr}`);
  });
  it("accounts for an unreadable tracked path on red", () => {
    const directory = temporaryRepo();
    write(directory, "gone.txt", "ordinary");
    git(directory, ["add", "--all"]);
    rmSync(path.join(directory, "gone.txt"));
    const result = validateBrandFoilDiscovery(discoverBrandFoilSites(directory), []);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatchObject({
      tracked: 1,
      scanned: 0,
      readFailures: 1,
      union: 0,
      allowed: 0,
      violations: 0,
    });
  });
  it.each(["renamed", "nested", "duplicate", "whitespace", "template", "mutable"])(
    "rejects a %s proof fixture owner",
    (kind) => {
      const original = readFileSync(path.join(canonical, proofPath));
      const source = original.toString("utf8");
      const declaration = source.match(/^const aggregateFixture = .*;$/m)[0];
      const replacement =
        kind === "renamed"
          ? declaration.replace("aggregateFixture", "unrelatedFixture")
          : kind === "nested"
            ? `function unrelatedOwner() { ${declaration} }`
            : kind === "whitespace"
              ? declaration.replace(/";$/, ' ";')
              : kind === "template"
                ? declaration.replaceAll('"', "`")
                : kind === "mutable"
                  ? declaration.replace("const ", "let ")
                  : `${declaration}\n${declaration}`;
      try {
        write(canonical, proofPath, source.replace(declaration, replacement));
        const result = validateBrandFoilDiscovery(discoverBrandFoilSites(canonical));
        expect(result.ok).toBe(false);
        expect(
          result.violations.some(
            (message) => message.includes(proofPath) && message.includes("expression=aggregateFixture"),
          ),
        ).toBe(true);
      } finally {
        write(canonical, proofPath, original);
      }
    },
  );
  it.each(["rename", "unexport", "template-expression"])(
    "rejects a logo %s while existing safe hits remain",
    (kind) => {
      const name = requiredCarrierPaths[3];
      const original = readFileSync(path.join(canonical, name));
      const source = original.toString("utf8");
      const declaration = source.match(/export const (\w+) = `/)[0];
      const replacement =
        kind === "rename"
          ? declaration.replace(/const \w+/, "const unrelatedSvg")
          : kind === "unexport"
            ? declaration.replace("export ", "")
            : declaration + "${unrelatedValue}";
      try {
        write(canonical, name, source.replace(declaration, replacement));
        const discovered = discoverBrandFoilSites(canonical);
        expect(discovered.carriers.find((row) => row.path === name).occurrences).toHaveLength(
          clean.carriers.find((row) => row.path === name).occurrences.length,
        );
        expect(validateBrandFoilDiscovery(discovered).ok).toBe(false);
      } finally {
        write(canonical, name, original);
      }
    },
  );
});
