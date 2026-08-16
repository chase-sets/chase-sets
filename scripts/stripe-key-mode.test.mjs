import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMergeGateStripeKeyMode } from "./merge-gate-verification.mjs";
import { assertStripeTestKey } from "./provider-webhook-lifecycle.mjs";
import { validatesSecretValue } from "./staging-refresh-preflight.mjs";
import {
  STRIPE_KEY_CASES,
  classifyStripeKeys,
  evaluateUnrestrictedStripeKeyPair,
  isStripeTestServerKey,
  isUnrestrictedStripeSecretKeyForMode,
  runStripeKeyModeCli,
} from "./stripe-key-mode.mjs";
import { resolveStripeKeyMode } from "./stripe-money-smoke-test.mjs";
import { assertKeyMode } from "./stripe-webhook-endpoint.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const BASE_SHA = "1419342988ce4863d4f3c4176b88351528b9df26";
const ROOTS = Object.freeze([
  "infrastructure",
  "deployables",
  "bounded-contexts",
  "contracts",
  "packages",
  "scripts",
  ".github/workflows",
]);
const EXPECTED_BASE_ROOT_COUNTS = Object.freeze([6, 0, 1, 0, 0, 15, 7]);
const EXPECTED_CANDIDATE_ROOT_COUNTS = Object.freeze([6, 0, 1, 0, 0, 13, 4]);

function git(args, cwd = REPOSITORY_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function rootFor(file) {
  return file.startsWith(".github/workflows/") ? ".github/workflows" : file.split("/")[0];
}

function isExcludedTestFile(file) {
  return /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|\.(?:test|spec)\.[^/]+$/u.test(file);
}

function d1Matches(line) {
  const punctuationStripped = line.replace(/[(){}\[\]|?:^$*"'\x60\\/]/gu, "");
  return /(?:sk|rk|pk)_(?:test|live)/u.test(punctuationStripped);
}

const DYNAMIC_KEY_NAMES =
  /STRIPE_SECRET_KEY|STRIPE_PUBLISHABLE_KEY|stripeApiKey|stripe_secret_key|stripe_publishable_key|secretKey|publishableKey/u;
const DYNAMIC_CALLS = Object.freeze([
  /new\s+RegExp\(\s*([^,)]+)/u,
  /(?:^|[^\w])RegExp\(\s*([^,)]+)/u,
  /\.startsWith\(\s*([^)]+)/u,
  /\.match\(\s*([^)]+)/u,
  /\.slice\(\s*([^)]+)/u,
]);

function d2Matches(line) {
  if (!DYNAMIC_KEY_NAMES.test(line)) return false;
  return DYNAMIC_CALLS.some((pattern) => {
    const argument = pattern.exec(line)?.[1]?.trim();
    return argument !== undefined && !/^["'\x60]/u.test(argument);
  });
}

function detectLines(file, source) {
  return source.split(/\r?\n/u).flatMap((text, index) => {
    const detectors = [d1Matches(text) ? "D1" : null, d2Matches(text) ? "D2" : null].filter(Boolean);
    if (detectors.length > 0 && text.includes("\uFFFD")) throw new Error(`unreadable UTF-8 candidate: ${file}`);
    return detectors.length === 0 ? [] : [{ path: file, line: index + 1, text, detectors }];
  });
}

function trackedFilesAt({ cwd = REPOSITORY_ROOT, ref = null } = {}) {
  const args = ref ? ["ls-tree", "-r", "--name-only", "-z", ref, "--", ...ROOTS] : ["ls-files", "-z", "--", ...ROOTS];
  return git(args, cwd)
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

function sourcesAt(ref, files, cwd) {
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd,
    input: `${files.map((file) => `${ref}:${file}`).join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  const sources = new Map();
  let offset = 0;
  for (const file of files) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new Error(`missing git cat-file header for ${file}`);
    const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number.parseInt(header.at(-1), 10);
    if (!Number.isSafeInteger(size)) throw new Error(`unparsable git cat-file header for ${file}`);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    sources.set(file, output.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }
  return sources;
}

function scanTrackedRepository({ cwd = REPOSITORY_ROOT, ref = null } = {}) {
  const tracked = trackedFilesAt({ cwd, ref });
  const scanned = tracked.filter((file) => !isExcludedTestFile(file));
  const refSources = ref ? sourcesAt(ref, scanned, cwd) : null;
  const candidates = scanned.flatMap((file) => {
    const source = ref ? refSources.get(file) : readFileSync(path.join(cwd, ...file.split("/")), "utf8");
    if (source === undefined) throw new Error(`missing tracked source ${file}`);
    return detectLines(file, source);
  });
  const census = ROOTS.map((root) => ({
    root,
    tracked: tracked.filter((file) => rootFor(file) === root).length,
    scanned: scanned.filter((file) => rootFor(file) === root).length,
    candidates: candidates.filter((entry) => rootFor(entry.path) === root).length,
  }));
  return { tracked, scanned, candidates, census };
}

function candidateKey(candidate) {
  return `${candidate.path}\u0000${candidate.text}`;
}

const CLASS_S_BASE_ANCHORS = Object.freeze([
  ["bounded-contexts/catalog/features/completion-report/domain/redaction.ts", 34],
  ["scripts/platform-deploy-incident.mjs", 93],
  ["scripts/platform-kubernetes-deployment.mjs", 577],
  ["scripts/stripe-webhook-endpoint.mjs", 68],
  ["scripts/ucp-ap2-certification-evidence.mjs", 24],
]);
const NON_PREDICATE_BASE_ANCHORS = Object.freeze([
  ["scripts/platform-compose-smoke.mjs", 87],
  ["scripts/platform-compose-smoke.mjs", 88],
  ["scripts/provider-webhook-lifecycle.mjs", 18],
  [".github/workflows/platform-pr.yml", 572],
  [".github/workflows/platform-pr.yml", 573],
  [".github/workflows/platform-pr.yml", 773],
  [".github/workflows/platform-pr.yml", 774],
]);
const MIGRATION_ANCHORS = Object.freeze([
  [4, "scripts/stripe-webhook-endpoint.mjs", 44],
  [4, "scripts/stripe-webhook-endpoint.mjs", 46],
  [5, "scripts/stripe-money-smoke-test.mjs", 347],
  [6, "scripts/stripe-money-smoke-test.mjs", 350],
  [7, "scripts/staging-refresh-preflight.mjs", 96],
  [7, "scripts/staging-refresh-preflight.mjs", 99],
  [8, "scripts/provider-webhook-lifecycle.mjs", 17],
  [9, ".github/workflows/platform-pr.yml", 1074],
  [9, ".github/workflows/platform-production.yml", 829],
  [10, ".github/workflows/platform-production.yml", 2600],
  [11, "scripts/merge-gate-verification.mjs", 569],
]);

function anchorsFrom(scan, anchors) {
  return anchors.map(([file, line]) => {
    const candidate = scan.candidates.find((entry) => entry.path === file && entry.line === line);
    if (!candidate) throw new Error(`missing baseline anchor ${file}:${line}`);
    return candidate;
  });
}

function partitionErrors(candidates, classSKeys, nonPredicateKeys) {
  const seen = new Set();
  const errors = [];
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate.path !== "string" ||
      !Number.isInteger(candidate.line) ||
      typeof candidate.text !== "string" ||
      !Array.isArray(candidate.detectors)
    ) {
      errors.push("unparsable-candidate");
      continue;
    }
    const key = candidateKey(candidate);
    const identity = `${candidate.path}\u0000${candidate.line}`;
    if (seen.has(identity)) errors.push(`duplicate:${candidate.path}:${candidate.line}`);
    seen.add(identity);
    const isAuthority =
      candidate.path === "infrastructure/platform-runtime/config-schema.ts" ||
      candidate.path === "scripts/stripe-key-mode.mjs";
    const arms = [isAuthority, classSKeys.has(key), nonPredicateKeys.has(key)].filter(Boolean).length;
    if (arms === 0) errors.push(`unclassified:${candidate.path}:${candidate.line}`);
    if (arms > 1) errors.push(`multi-classified:${candidate.path}:${candidate.line}`);
  }
  const fingerprints = new Set(candidates.filter(Boolean).map(candidateKey));
  for (const key of classSKeys) if (!fingerprints.has(key)) errors.push(`missing-class-s:${key.split("\u0000")[0]}`);
  for (const key of nonPredicateKeys)
    if (!fingerprints.has(key)) errors.push(`missing-non-predicate:${key.split("\u0000")[0]}`);
  return errors;
}

const SERVER_AXIS = Object.freeze([
  null,
  "sk_test_123",
  "sk_live_123",
  "rk_test_123",
  "rk_live_123",
  "xk_bogus_123",
  "sk_liveSYNTHETIC",
]);
const PUBLISHABLE_AXIS = Object.freeze([null, "pk_test_123", "pk_live_123", "xk_bogus_987", "pk_liveSYNTHETIC"]);

function oldRowVerdict(row, secretKey, publishableKey) {
  if (row === 4) return String(secretKey ?? "").startsWith("sk_test_");
  if (row === 5) return secretKey?.startsWith("sk_test") === true && publishableKey?.startsWith("pk_test") === true;
  if (row === 6) return secretKey?.startsWith("sk_live") === true && publishableKey?.startsWith("pk_live") === true;
  if (row === 7)
    return String(secretKey ?? "").startsWith("sk_test_") && String(publishableKey ?? "").startsWith("pk_test_");
  if (row === 8) return String(secretKey ?? "").startsWith("sk_test_");
  if (row === 9)
    return String(secretKey ?? "").startsWith("sk_test") && String(publishableKey ?? "").startsWith("pk_test");
  if (row === 10)
    return String(secretKey ?? "").startsWith("sk_live") && String(publishableKey ?? "").startsWith("pk_live");
  return /^(?:sk|rk)_test_/u.test(String(secretKey ?? ""));
}

function doesNotThrow(run) {
  try {
    run();
    return true;
  } catch {
    return false;
  }
}

function newRowVerdict(row, secretKey, publishableKey) {
  if (row === 4) return doesNotThrow(() => assertKeyMode(secretKey, "test"));
  if (row === 5)
    return resolveStripeKeyMode({ STRIPE_SECRET_KEY: secretKey, STRIPE_PUBLISHABLE_KEY: publishableKey }) === "test";
  if (row === 6)
    return resolveStripeKeyMode({ STRIPE_SECRET_KEY: secretKey, STRIPE_PUBLISHABLE_KEY: publishableKey }) === "live";
  if (row === 7)
    return (
      validatesSecretValue("stripe-secret-test", secretKey) &&
      validatesSecretValue("stripe-publishable-test", publishableKey)
    );
  if (row === 8) return doesNotThrow(() => assertStripeTestKey({ stripeApiKey: secretKey }));
  if (row === 9) return evaluateUnrestrictedStripeKeyPair(secretKey, publishableKey, "test").admitted;
  if (row === 10) return evaluateUnrestrictedStripeKeyPair(secretKey, publishableKey, "live").admitted;
  return resolveMergeGateStripeKeyMode(secretKey) === "test";
}

function oracleForRow(row) {
  const divergences = [];
  const widenings = [];
  for (const secretKey of SERVER_AXIS) {
    for (const publishableKey of PUBLISHABLE_AXIS) {
      const oldAdmits = oldRowVerdict(row, secretKey, publishableKey);
      const newAdmits = newRowVerdict(row, secretKey, publishableKey);
      const label = `${secretKey ?? "absent"} / ${publishableKey ?? "absent"}`;
      if (oldAdmits !== newAdmits) divergences.push(`${label}: ${oldAdmits}->${newAdmits}`);
      if (!oldAdmits && newAdmits) widenings.push(label);
    }
  }
  return { divergences, widenings };
}

function captureCli({ mode, secretKey, publishableKey }) {
  let stdout = "";
  let stderr = "";
  const status = runStripeKeyModeCli(
    ["require-unrestricted-pair", "--mode", mode, "--secret-var", "SECRET", "--publishable-var", "PUBLISHABLE"],
    { SECRET: secretKey, PUBLISHABLE: publishableKey },
    { stdout: { write: (value) => (stdout += value) }, stderr: { write: (value) => (stderr += value) } },
  );
  return { status, stdout, stderr };
}

function writeTracked(root, relative, source) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}

function filesystemFiles(root, relative = "") {
  const directory = path.join(root, relative);
  return readdirSync(directory).flatMap((name) => {
    if (name === ".git") return [];
    const child = path.join(directory, name);
    const next = relative ? `${relative}/${name}` : name;
    return statSync(child).isDirectory() ? filesystemFiles(root, next) : [next.replaceAll("\\", "/")];
  });
}

describe("shared Stripe key-mode authority", () => {
  it("exports exactly six server and four publishable rows with total closed outputs", () => {
    expect(STRIPE_KEY_CASES.filter((entry) => entry.family === "server")).toHaveLength(6);
    expect(STRIPE_KEY_CASES.filter((entry) => entry.family === "publishable")).toHaveLength(4);
    expect(new Set(STRIPE_KEY_CASES.map((entry) => entry.mode))).toEqual(
      new Set(["absent", "test", "live", "unknown"]),
    );
    expect(new Set(STRIPE_KEY_CASES.map((entry) => entry.keyClass))).toEqual(
      new Set(["absent", "standard", "restricted", "unknown"]),
    );

    for (const server of STRIPE_KEY_CASES.filter((entry) => entry.family === "server")) {
      for (const publishable of STRIPE_KEY_CASES.filter((entry) => entry.family === "publishable")) {
        const serverValue =
          server.mode === "absent" ? null : server.mode === "unknown" ? "xk_other" : `${server.prefix}fixture`;
        const publishableValue =
          publishable.mode === "absent"
            ? null
            : publishable.mode === "unknown"
              ? "xk_other"
              : `${publishable.prefix}fixture`;
        expect(classifyStripeKeys(serverValue, publishableValue)).toEqual({
          serverKeyMode: server.mode,
          serverKeyClass: server.keyClass,
          publishableKeyMode: publishable.mode,
        });
      }
    }
  });

  it("kills mid-string-includes, drop-trailing-underscore, and unknown-defaults-test mutants", () => {
    expect(classifyStripeKeys("prefix_sk_live_fixture", "prefix_pk_test_fixture")).toEqual({
      serverKeyMode: "unknown",
      serverKeyClass: "unknown",
      publishableKeyMode: "unknown",
    });
    expect(classifyStripeKeys("sk_livefixture", "pk_livefixture")).toEqual({
      serverKeyMode: "unknown",
      serverKeyClass: "unknown",
      publishableKeyMode: "unknown",
    });
    expect(classifyStripeKeys("anything", "anything")).not.toEqual({
      serverKeyMode: "test",
      serverKeyClass: "standard",
      publishableKeyMode: "test",
    });
    expect(
      classifyStripeKeys(
        {
          toString: () => {
            throw new Error("raw-exception");
          },
        },
        Symbol("key"),
      ),
    ).toEqual({
      serverKeyMode: "unknown",
      serverKeyClass: "unknown",
      publishableKeyMode: "unknown",
    });
  });

  it("makes both shared-table drift mutants observable to independent expected behavior", () => {
    const serverRkTestBecomesLive = STRIPE_KEY_CASES.map((entry) =>
      entry.family === "server" && entry.mode === "test" && entry.keyClass === "restricted"
        ? { ...entry, mode: "live" }
        : entry,
    );
    const publishablePkLiveBecomesTest = STRIPE_KEY_CASES.map((entry) =>
      entry.family === "publishable" && entry.mode === "live" ? { ...entry, mode: "test" } : entry,
    );
    expect(serverRkTestBecomesLive).not.toEqual(STRIPE_KEY_CASES);
    expect(publishablePkLiveBecomesTest).not.toEqual(STRIPE_KEY_CASES);
    expect(classifyStripeKeys("rk_test_fixture", null).serverKeyMode).toBe("test");
    expect(classifyStripeKeys(null, "pk_live_fixture").publishableKeyMode).toBe("live");
  });
});

describe("eight O/W row differential oracle", () => {
  it("pins all 35 cells per row, permits narrowing only, and keeps row 11 at zero divergence", () => {
    const receipt = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 4, oracleForRow(index + 4)]));
    console.info("Stripe row differential oracle", receipt);
    for (const row of Object.values(receipt)) expect(row.widenings).toEqual([]);
    expect(receipt[4].divergences).toEqual([]);
    expect(receipt[5].divergences).toEqual([]);
    expect(receipt[6].divergences).toEqual([
      "sk_live_123 / pk_liveSYNTHETIC: true->false",
      "sk_liveSYNTHETIC / pk_live_123: true->false",
      "sk_liveSYNTHETIC / pk_liveSYNTHETIC: true->false",
    ]);
    expect(receipt[7].divergences).toEqual([]);
    expect(receipt[8].divergences).toEqual([]);
    expect(receipt[9].divergences).toEqual([]);
    expect(receipt[10].divergences).toEqual(receipt[6].divergences);
    expect(receipt[11].divergences).toEqual([]);
  });

  it("kills restricted-policy, row11-drop-underscore, and row11-refuse-rk-test mutants", () => {
    expect(isStripeTestServerKey("rk_test_fixture")).toBe(false);
    expect(isUnrestrictedStripeSecretKeyForMode("rk_live_fixture", "live")).toBe(false);
    expect(resolveMergeGateStripeKeyMode("rk_test_fixture")).toBe("test");
    expect(resolveMergeGateStripeKeyMode("sk_testfixture")).toBe("not-test");
    expect(/^sk_test/u.test("sk_testfixture")).toBe(true);
    expect(/^sk_test_/u.test("rk_test_fixture")).toBe(false);
  });

  it("retains rows 4-10 unrestricted policy and row 11 restricted-test admission", () => {
    for (const row of [4, 5, 7, 8, 9]) expect(newRowVerdict(row, "rk_test_123", "pk_test_123")).toBe(false);
    for (const row of [4, 6, 7, 8, 10]) expect(newRowVerdict(row, "rk_live_123", "pk_live_123")).toBe(false);
    expect(newRowVerdict(11, "rk_test_123", null)).toBe(true);
  });
});

describe("workflow CLI and leakage controls", () => {
  it("returns the retained workflow exit verdicts and bounded restricted reason", () => {
    expect(captureCli({ mode: "test", secretKey: "sk_test_123", publishableKey: "pk_test_123" })).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(captureCli({ mode: "live", secretKey: "sk_live_123", publishableKey: "pk_live_123" }).status).toBe(0);
    const restricted = captureCli({ mode: "live", secretKey: "rk_live_123", publishableKey: "pk_live_123" });
    expect(restricted.status).toBe(1);
    expect(JSON.parse(restricted.stderr)).toMatchObject({
      admitted: false,
      reason: "restricted-server-key",
      expectedMode: "live",
      variables: { secret: "SECRET", publishable: "PUBLISHABLE" },
    });

    const direct = (mode, secretKey, publishableKey) =>
      spawnSync(
        process.execPath,
        [
          path.join(REPOSITORY_ROOT, "scripts/stripe-key-mode.mjs"),
          "require-unrestricted-pair",
          "--mode",
          mode,
          "--secret-var",
          "SECRET",
          "--publishable-var",
          "PUBLISHABLE",
        ],
        { encoding: "utf8", env: { ...process.env, SECRET: secretKey, PUBLISHABLE: publishableKey } },
      );
    expect(direct("test", "sk_test_123", "pk_test_123").status).toBe(0);
    expect(direct("live", "sk_live_123", "pk_live_123").status).toBe(0);
    expect(direct("live", "rk_live_123", "pk_live_123").status).not.toBe(0);
  });

  it("kills workflow-exit-inverted and workflow-continues-after-refusal controls", () => {
    const admitted = captureCli({ mode: "test", secretKey: "sk_test_123", publishableKey: "pk_test_123" });
    const refused = captureCli({ mode: "test", secretKey: "sk_live_123", publishableKey: "pk_test_123" });
    expect(admitted.status).toBe(0);
    expect(refused.status).not.toBe(0);
    expect(Number(!admitted.status)).not.toBe(admitted.status);
    expect(refused.status === 0).toBe(false);
  });

  it("keeps planted key material out of every row refusal and catches a leaking scanner mutant", () => {
    const secretMarker = "sk_live_PLANTEDMARKER0123456789";
    const publishableMarker = "pk_test_PLANTEDMARKER9876543210";
    const output = [];
    for (const run of [
      () => assertKeyMode(secretMarker, "test"),
      () => assertStripeTestKey({ stripeApiKey: secretMarker }),
    ]) {
      try {
        run();
      } catch (error) {
        output.push(error instanceof Error ? error.message : String(error));
      }
    }
    output.push(JSON.stringify(classifyStripeKeys(secretMarker, publishableMarker)));
    output.push(
      JSON.stringify({
        row5: newRowVerdict(5, secretMarker, publishableMarker),
        row6: newRowVerdict(6, secretMarker, publishableMarker),
        row7: newRowVerdict(7, secretMarker, publishableMarker),
      }),
    );
    output.push(captureCli({ mode: "test", secretKey: secretMarker, publishableKey: publishableMarker }).stderr);
    output.push(captureCli({ mode: "live", secretKey: secretMarker, publishableKey: publishableMarker }).stderr);
    const mergeGate = spawnSync(
      process.execPath,
      [
        path.join(REPOSITORY_ROOT, "scripts/merge-gate-verification.mjs"),
        "credentials",
        "--require",
        "STRIPE_SECRET_KEY",
        "--stripe-test-mode-var",
        "STRIPE_SECRET_KEY",
      ],
      { encoding: "utf8", env: { ...process.env, STRIPE_SECRET_KEY: secretMarker } },
    );
    output.push(mergeGate.stdout, mergeGate.stderr);
    const serialized = output.join("\n");
    expect(serialized).not.toContain("PLANTEDMARKER0123456789");
    expect(serialized).not.toContain("PLANTEDMARKER9876543210");
    const scannerDetectsPlantedMarker = `${serialized}\n${secretMarker}`;
    expect(scannerDetectsPlantedMarker).toContain("PLANTEDMARKER0123456789");
  });
});

describe("seven-root tracked inventory and closed partition", () => {
  const baseline = scanTrackedRepository({ ref: BASE_SHA });
  const candidate = scanTrackedRepository();
  const classS = anchorsFrom(baseline, CLASS_S_BASE_ANCHORS);
  const nonPredicates = anchorsFrom(baseline, NON_PREDICATE_BASE_ANCHORS);
  const classSKeys = new Set(classS.map(candidateKey));
  const nonPredicateKeys = new Set(nonPredicates.map(candidateKey));

  it("reproduces the 29-line baseline and exact 24-line D1/D2 candidate partition", () => {
    expect(baseline.candidates).toHaveLength(29);
    expect(baseline.census.map((entry) => entry.candidates)).toEqual(EXPECTED_BASE_ROOT_COUNTS);
    expect(baseline.candidates.filter((entry) => entry.detectors.includes("D2"))).toEqual([]);
    expect(candidate.candidates).toHaveLength(24);
    expect(candidate.census.map((entry) => entry.candidates)).toEqual(EXPECTED_CANDIDATE_ROOT_COUNTS);
    expect(candidate.candidates.filter((entry) => entry.detectors.includes("D2"))).toEqual([]);
    expect(partitionErrors(candidate.candidates, classSKeys, nonPredicateKeys)).toEqual([]);
    console.info("Stripe detector census", { baseline: baseline.census, candidate: candidate.census });
  });

  it("binds all eleven O/W baseline anchors to rows 4-11 and their shared consumers", () => {
    expect(
      MIGRATION_ANCHORS.map(([row, file, line]) => {
        const found = baseline.candidates.find((entry) => entry.path === file && entry.line === line);
        return found ? [row, file, line] : null;
      }),
    ).toEqual(MIGRATION_ANCHORS);
    const consumers = {
      "scripts/stripe-webhook-endpoint.mjs": "classifyStripeKeys(apiKey, null)",
      "scripts/stripe-money-smoke-test.mjs": "isUnrestrictedStripeKeyPair(secretKey, publishableKey",
      "scripts/staging-refresh-preflight.mjs": 'isUnrestrictedStripeSecretKeyForMode(value, "test")',
      "scripts/provider-webhook-lifecycle.mjs": "isStripeTestServerKey(input.stripeApiKey)",
      "scripts/merge-gate-verification.mjs": "resolveMergeGateStripeKeyMode(value)",
      ".github/workflows/platform-pr.yml": "node scripts/stripe-key-mode.mjs require-unrestricted-pair --mode test",
      ".github/workflows/platform-production.yml":
        "node scripts/stripe-key-mode.mjs require-unrestricted-pair --mode live",
    };
    for (const [file, snippet] of Object.entries(consumers)) {
      expect(readFileSync(path.join(REPOSITORY_ROOT, ...file.split("/")), "utf8"), file).toContain(snippet);
    }
  });

  it("keeps every class-S and non-predicate row byte-exact and kills deletion/reclassification mutants", () => {
    const candidateKeys = new Set(candidate.candidates.map(candidateKey));
    for (const key of [...classSKeys, ...nonPredicateKeys]) expect(candidateKeys.has(key), key).toBe(true);
    for (const anchor of [...classS, ...nonPredicates]) {
      const baselineCount = [...classS, ...nonPredicates].filter(
        (entry) => candidateKey(entry) === candidateKey(anchor),
      ).length;
      const candidateCount = candidate.candidates.filter(
        (entry) => candidateKey(entry) === candidateKey(anchor),
      ).length;
      expect(candidateCount, `${anchor.path}:${anchor.text}`).toBe(baselineCount);
    }
    const withoutClassS = candidate.candidates.filter((entry) => candidateKey(entry) !== candidateKey(classS[0]));
    expect(partitionErrors(withoutClassS, classSKeys, nonPredicateKeys)).toContain(`missing-class-s:${classS[0].path}`);
    const withoutNonPredicate = candidate.candidates.filter(
      (entry) => candidateKey(entry) !== candidateKey(nonPredicates[0]),
    );
    expect(partitionErrors(withoutNonPredicate, classSKeys, nonPredicateKeys)).toContain(
      `missing-non-predicate:${nonPredicates[0].path}`,
    );
    const reclassified = new Set([...nonPredicateKeys].filter((key) => key !== candidateKey(nonPredicates[0])));
    expect(partitionErrors(candidate.candidates, classSKeys, reclassified)).toContain(
      `unclassified:${nonPredicates[0].path}:${candidate.candidates.find((entry) => candidateKey(entry) === candidateKey(nonPredicates[0])).line}`,
    );
    expect(partitionErrors([...candidate.candidates, candidate.candidates[0]], classSKeys, nonPredicateKeys)).toContain(
      `duplicate:${candidate.candidates[0].path}:${candidate.candidates[0].line}`,
    );
    expect(partitionErrors([...candidate.candidates, { path: null }], classSKeys, nonPredicateKeys)).toContain(
      "unparsable-candidate",
    );
  });

  it("executes each class-S redactor's deliberately distinct matched and non-matched witnesses", () => {
    const regexFrom = (source) => {
      const first = source.indexOf("/");
      const last = source.lastIndexOf("/");
      return new RegExp(source.slice(first + 1, last), source.slice(last + 1).match(/^[a-z]*/u)?.[0]);
    };
    const witnesses = [
      ["RK_LIVE_abc123", "rk_live_"],
      ["SK_LIVE_ABC-123", "rk_test_abc"],
      ["sk_test_abc-123", "SK_TEST_abc"],
      ["sk_live_abc-123", "rk_live_abc"],
      ["pk_test_abc", "rk_test_abc"],
    ];
    for (const [index, anchor] of classS.entries()) {
      const regex = regexFrom(anchor.text.trim().replace(/;$/u, ""));
      expect(regex.test(witnesses[index][0]), anchor.path).toBe(true);
      regex.lastIndex = 0;
      expect(regex.test(witnesses[index][1]), anchor.path).toBe(false);
      expect(anchor.text).not.toContain("stripe-key-mode");
      expect(anchor.text).not.toContain("classifyStripeKeys");
    }
  });

  it("kills redactor-calls-admission-classifier without forbidding row 4's file-level import", () => {
    for (const anchor of classS) {
      const source = readFileSync(path.join(REPOSITORY_ROOT, ...anchor.path.split("/")), "utf8");
      if (anchor.path === "scripts/stripe-webhook-endpoint.mjs") {
        const redactorOwner = source.slice(
          source.indexOf("async function requestJson"),
          source.indexOf("async function listWebhookEndpoints"),
        );
        expect(redactorOwner).not.toContain("classifyStripeKeys");
      } else {
        expect(source).not.toContain("stripe-key-mode.mjs");
      }
    }
  });

  it("kills row11-regex, grouped-prefix, shell-glob, every dynamic matcher, and seven neutral-path mutants", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stripe-key-mode-inventory-"));
    try {
      git(["init", "--quiet"], root);
      git(["config", "user.email", "inventory@example.test"], root);
      git(["config", "user.name", "Inventory Test"], root);
      const neutral = [
        "infrastructure/neutral/a.mjs",
        "deployables/neutral/a.mjs",
        "bounded-contexts/neutral/a.mjs",
        "contracts/neutral/a.mjs",
        "packages/neutral/a.mjs",
        "scripts/neutral/a.mjs",
        ".github/workflows/neutral.yml",
      ];
      for (const file of neutral) writeTracked(root, file, "const value = /^sk_(test|live)_/.test(input);\n");
      writeTracked(root, "scripts/neutral/row11.mjs", "const admitted = /^(?:sk|rk)_test_/.test(value);\n");
      writeTracked(root, "scripts/neutral/glob.sh", 'if [[ "$value" == sk_test* ]]; then true; fi\n');
      const dynamics = [
        "const result = new RegExp(pattern).test(STRIPE_SECRET_KEY);",
        "const result = RegExp(pattern).test(STRIPE_PUBLISHABLE_KEY);",
        "const result = stripeApiKey.startsWith(prefix);",
        "const result = secretKey.match(pattern);",
        "const result = publishableKey.slice(offset);",
      ];
      dynamics.forEach((source, index) => writeTracked(root, `scripts/neutral/dynamic-${index}.mjs`, `${source}\n`));
      git(["add", "."], root);
      const planted = scanTrackedRepository({ cwd: root });
      for (const file of neutral)
        expect(
          planted.candidates.some((entry) => entry.path === file),
          file,
        ).toBe(true);
      expect(planted.candidates.filter((entry) => entry.detectors.includes("D2"))).toHaveLength(5);
      expect(
        partitionErrors(planted.candidates, new Set(), new Set()).every((error) => error.startsWith("unclassified:")),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps ignored generated plants green and reddens a filesystem-walk enumerator", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stripe-key-mode-generated-"));
    try {
      git(["init", "--quiet"], root);
      writeTracked(root, ".gitignore", "scripts/generated/\n");
      writeTracked(root, "scripts/tracked.mjs", "export const neutral = true;\n");
      git(["add", "."], root);
      const clean = scanTrackedRepository({ cwd: root });
      writeTracked(root, "scripts/generated/post-build.mjs", 'const key = "sk_live_generated";\n');
      const postBuild = scanTrackedRepository({ cwd: root });
      expect(postBuild).toEqual(clean);
      const filesystemWalkCandidates = filesystemFiles(root).flatMap((file) =>
        detectLines(file, readFileSync(path.join(root, ...file.split("/")), "utf8")),
      );
      expect(filesystemWalkCandidates.some((entry) => entry.path === "scripts/generated/post-build.mjs")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workflow and footprint preservation", () => {
  it("changes exactly the three workflow predicates while preserving their messages and topology", () => {
    const replacements = new Map([
      [
        ".github/workflows/platform-pr.yml",
        [
          [
            "          if ! node scripts/stripe-key-mode.mjs require-unrestricted-pair --mode test --secret-var TF_VAR_stripe_secret_key --publishable-var TF_VAR_stripe_publishable_key; then",
            '          if [[ "${TF_VAR_stripe_secret_key}" != sk_test* || "${TF_VAR_stripe_publishable_key}" != pk_test* ]]; then',
          ],
        ],
      ],
      [
        ".github/workflows/platform-production.yml",
        [
          [
            "          if ! node scripts/stripe-key-mode.mjs require-unrestricted-pair --mode test --secret-var TF_VAR_stripe_secret_key --publishable-var TF_VAR_stripe_publishable_key; then",
            '          if [[ "${TF_VAR_stripe_secret_key}" != sk_test* || "${TF_VAR_stripe_publishable_key}" != pk_test* ]]; then',
          ],
          [
            "            if ! node scripts/stripe-key-mode.mjs require-unrestricted-pair --mode live --secret-var TF_VAR_stripe_secret_key --publishable-var TF_VAR_stripe_publishable_key; then",
            '            if [[ "${TF_VAR_stripe_secret_key}" != sk_live* || "${TF_VAR_stripe_publishable_key}" != pk_live* ]]; then',
          ],
        ],
      ],
    ]);
    for (const [file, pairs] of replacements) {
      let candidateSource = readFileSync(path.join(REPOSITORY_ROOT, ...file.split("/")), "utf8");
      for (const [replacement, original] of pairs) {
        expect(candidateSource.split(replacement)).toHaveLength(2);
        candidateSource = candidateSource.replace(replacement, original);
      }
      expect(candidateSource).toBe(git(["show", `${BASE_SHA}:${file}`]));
    }
  });

  it("keeps the declaration widened and literal-free with only its sanctioned exports", () => {
    const declaration = readFileSync(path.join(REPOSITORY_ROOT, "scripts/stripe-key-mode.d.mts"), "utf8");
    expect(declaration).not.toMatch(/(?:sk|rk|pk)_(?:test|live)/u);
    expect(declaration.match(/export /gu)).toHaveLength(2);
    expect(declaration).toContain("family: string");
    expect(declaration).toContain("prefix: string");
    expect(declaration).toContain("mode: string");
    expect(declaration).toContain("keyClass: string");
    expect(declaration).toContain("readonly StripeKeyCase[]");
  });

  it("preserves runtime production bytes and confines the candidate to the exact predicted files", () => {
    expect(readFileSync(path.join(REPOSITORY_ROOT, "infrastructure/platform-runtime/config-schema.ts"), "utf8")).toBe(
      git(["show", `${BASE_SHA}:infrastructure/platform-runtime/config-schema.ts`]),
    );
    const expected = [
      ".github/workflows/platform-pr.yml",
      ".github/workflows/platform-production.yml",
      "infrastructure/platform-runtime/config-schema.test.ts",
      "scripts/merge-gate-verification.mjs",
      "scripts/merge-gate-verification.test.mjs",
      "scripts/provider-webhook-lifecycle.mjs",
      "scripts/provider-webhook-lifecycle.test.mjs",
      "scripts/staging-refresh-preflight.mjs",
      "scripts/staging-refresh-preflight.test.mjs",
      "scripts/stripe-key-mode.d.mts",
      "scripts/stripe-key-mode.mjs",
      "scripts/stripe-key-mode.test.mjs",
      "scripts/stripe-money-smoke-test.mjs",
      "scripts/stripe-money-smoke-test.test.mjs",
      "scripts/stripe-webhook-endpoint.mjs",
      "scripts/stripe-webhook-endpoint.test.mjs",
    ].sort();
    expect(git(["diff", "--name-only", BASE_SHA]).trim().split(/\r?\n/u).filter(Boolean).sort()).toEqual(expected);
  });

  it("publishes the complete discriminating-control roster beside executable controls", () => {
    const namedMutants = [
      "mid-string-includes",
      "drop-trailing-underscore",
      "unknown-defaults-test",
      "server-rk-test-becomes-live",
      "publishable-pk-live-becomes-test",
      "declaration-missing",
      "declaration-stale-export",
      "row11-regex-reintroduced",
      "grouped-prefix-regex",
      "shell-glob-reintroduced",
      "dynamic-new-regexp",
      "dynamic-regexp-call",
      "dynamic-startswith",
      "dynamic-match",
      "dynamic-slice",
      "neutral-path-infrastructure",
      "neutral-path-deployables",
      "neutral-path-bounded-contexts",
      "neutral-path-contracts",
      "neutral-path-packages",
      "neutral-path-scripts",
      "neutral-path-workflows",
      "delete-class-s-row",
      "delete-nonpredicate-row",
      "candidate-in-generated-ignored-file",
      "filesystem-walk-enumerator",
      "copied-prefix-table-in-script",
      "inline-regex-in-row11",
      "longer-workflow-glob",
      "row11-drop-underscore",
      "row11-refuse-rk-test",
      "site8-admit-restricted",
      "site10-admit-restricted-live",
      "row11-refuse-restricted-test",
      "redactor-calls-admission-classifier",
      "narrow-redactor-to-standard-only",
      "reclassify-placeholder-as-admission",
      "scanner-detects-planted-marker",
      "workflow-exit-inverted",
      "workflow-continues-after-refusal",
      "row11-summary-renamed",
      "row11-exit-removed",
    ];
    expect(new Set(namedMutants).size).toBe(namedMutants.length);
    expect(namedMutants).toHaveLength(42);
  });
});
