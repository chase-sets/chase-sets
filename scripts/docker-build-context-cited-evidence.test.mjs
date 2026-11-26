import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalClaimRegistry } from "../bounded-contexts/public-presence/features/policies/domain/canonical-claims.ts";
import { privacyProductTruthBindings } from "../bounded-contexts/public-presence/features/policies/domain/privacy-policy-product-truth.ts";

// The platform image's build stage compiles the public policies, and that compile reads every
// source a Privacy fact or a settled canonical claim cites (the Privacy fingerprint hashes the
// cited lines). A cited file the build context leaves out fails the image build, which only the
// Compose Boot Smoke and release image jobs would otherwise find.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerignore = readFileSync(path.join(repo, ".dockerignore"), "utf8");

/** A .dockerignore pattern as a regular expression, as BuildKit matches it: `*` and `?` stay
 *  inside one path segment, `**` spans any number of them, and a leading `/` is dropped. */
function patternRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** The rules in a .dockerignore, in order: comments and blank lines dropped. */
function dockerignoreRules(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const exception = line.startsWith("!");
      const pattern = (exception ? line.slice(1) : line).trim().replace(/^\/+/, "").replace(/\/+$/, "");
      return { line, exception, regExp: patternRegExp(pattern) };
    });
}

/** Whether the build context leaves `file` out: the last rule that matches the file or one of
 *  its directories decides, so a later `!` rule brings a file back into an excluded directory. */
function excludedFromBuildContext(rules, file) {
  const segments = file.split("/");
  const candidates = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  let excluded = false;
  for (const rule of rules) {
    if (candidates.some((candidate) => rule.regExp.test(candidate))) excluded = !rule.exception;
  }
  return excluded;
}

const citedPath = (ref) => {
  const match = /^(.+?):\d+(?:-\d+)?$/.exec(ref.trim());
  if (match === null) throw new Error(`not a path:line reference: ${ref}`);
  return match[1];
};

const citedPaths = [
  ...new Set(
    [
      ...privacyProductTruthBindings.flatMap((binding) => binding.evidenceRefs),
      ...Object.values(canonicalClaimRegistry).flatMap((claim) => claim.productTruthRefs),
    ].map(citedPath),
  ),
].sort();

const pilotPrefix = "deployables/corten-pilot/";

describe("the platform image's build context", () => {
  const rules = dockerignoreRules(dockerignore);

  it("carries every source the public policy compile reads", () => {
    expect(citedPaths.length).toBeGreaterThan(0);
    expect(citedPaths.filter((file) => excludedFromBuildContext(rules, file))).toEqual([]);
  });

  it("brings back only the Corten pilot files a policy cites", () => {
    const reincluded = rules
      .filter((rule) => rule.exception && rule.line.slice(1).startsWith(pilotPrefix))
      .map((rule) => rule.line.slice(1));
    expect(reincluded).toEqual(citedPaths.filter((file) => file.startsWith(pilotPrefix)));
    expect(excludedFromBuildContext(rules, `${pilotPrefix}marketplace/src/api.rs`)).toBe(true);
    expect(excludedFromBuildContext(rules, `${pilotPrefix}Cargo.toml`)).toBe(true);
  });

  it("fails when a cited file's exception is dropped", () => {
    const [cited] = citedPaths.filter((file) => file.startsWith(pilotPrefix));
    const without = dockerignore.replace(`!${cited}\n`, "");
    expect(without).not.toBe(dockerignore);
    expect(citedPaths.filter((file) => excludedFromBuildContext(dockerignoreRules(without), file))).toEqual([cited]);
  });

  it("matches as BuildKit does", () => {
    const sample = dockerignoreRules("**/node_modules\n/artifacts\n*.log\ndocs\n!docs/keep.md\nsrc/*.tmp\n");
    expect(excludedFromBuildContext(sample, "packages/a/node_modules/x/index.js")).toBe(true);
    expect(excludedFromBuildContext(sample, "node_modules/x/index.js")).toBe(true);
    expect(excludedFromBuildContext(sample, "artifacts/report.json")).toBe(true);
    expect(excludedFromBuildContext(sample, "build.log")).toBe(true);
    expect(excludedFromBuildContext(sample, "logs/build.log")).toBe(false);
    expect(excludedFromBuildContext(sample, "docs/guide.md")).toBe(true);
    expect(excludedFromBuildContext(sample, "docs/keep.md")).toBe(false);
    expect(excludedFromBuildContext(sample, "src/a.tmp")).toBe(true);
    expect(excludedFromBuildContext(sample, "src/deep/a.tmp")).toBe(false);
    expect(excludedFromBuildContext(sample, "bounded-contexts/a.ts")).toBe(false);
  });
});
