import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChaseSetsLogo, chaseSetsLogoSvg } from "../brand/chase-sets-logo";
import { BrandLink } from "../components/actions/navigation";
import { SellerBadge } from "../patterns/app-shells/commerce-atoms";
import { deriveReceiptSourceDigestPaths } from "./ink-foil-candidate-fixture.test";

// Vector-side Ink & Foil guard: the display-type and brand-foil value fence,
// the mark's three-representation parity, its accessibility semantics, and
// the vector half of the closed changed-path set. The changed-path arrays are
// read out of scripts/check-structure/brand-mark-representations.test.mjs by
// slicing its sentinel comments, so this side and the raster side always
// parse the same bytes and can never hold two hand-kept lists.

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
const designSystemSrc = join(root, "packages", "design-system", "src");
const stylesPath = join(designSystemSrc, "styles", "styles.css");
const stylesSource = readFileSync(stylesPath, "utf8");
const fixture = JSON.parse(
  readFileSync(join(designSystemSrc, "theme", "__fixtures__", "ink-foil-candidate-tokens.json"), "utf8"),
) as Record<"light" | "dark", Record<string, { shipped: string; candidate: string }>>;

// The raster-side guard module, resolved from this file's own location.
const representationGuardPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "check-structure",
  "brand-mark-representations.test.mjs",
);
const representationGuardSource = readFileSync(representationGuardPath, "utf8");

function sliceSentinelJson(source: string, name: string): string[] {
  const begin = source.indexOf(`// ${name}:begin`);
  const end = source.indexOf(`// ${name}:end`);
  if (begin === -1 || end === -1 || end <= begin) throw new Error(`sentinel block ${name} not found`);
  const block = source.slice(begin, end);
  const first = block.indexOf("[");
  const last = block.lastIndexOf("]");
  if (first === -1 || last === -1) throw new Error(`sentinel block ${name} carries no JSON array`);
  // The repository formatter writes a trailing comma before the closing
  // bracket; both sides normalise it away identically before parsing.
  return JSON.parse(block.slice(first, last + 1).replace(/,\s*\]$/, "]")) as string[];
}

const combinedCandidatePaths = sliceSentinelJson(representationGuardSource, "combined-candidate-paths");

type GitCommand = (repository: string, args: string[]) => string;
type GitHubEnvironment = Readonly<Record<string, string | undefined>>;
type CandidateBaseAuthority = {
  authority: "pull_request.merge-ref-parent-1" | "merge_group.head-parent" | "refs/remotes/origin/main";
  base: string;
  event: "local" | "pull_request" | "merge_group";
  ref: string;
  head: string;
  tree: string;
  parents: string[];
  witness: { name: "pull_request.base.sha" | "merge_group.base_sha"; sha: string } | null;
};

const lowercaseCommitSha = /^[0-9a-f]{40}$/;
const combinedCandidatePathDigest = "392d09f6dc9159e08216bfe61adaf18d285f263e2a6391f972a1d164a0e1db0e";

const executeGit: GitCommand = (repository, args) =>
  execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function gitText(repository: string, args: string[], git: GitCommand): string {
  return git(repository, args).trim();
}

function requireCommitSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !lowercaseCommitSha.test(value)) {
    throw new Error(`Refusing malformed ${name} ${JSON.stringify(value)}`);
  }
  return value;
}

function parseNulPaths(output: string, source: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error(`Refusing malformed NUL-framed ${source}`);
  const paths = output.slice(0, -1).split("\0");
  if (paths.some((path) => path.length === 0)) throw new Error(`Refusing empty path in ${source}`);
  return paths;
}

function parseUntrackedStatus(output: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error("Refusing malformed NUL-framed git status");
  const records = output.slice(0, -1).split("\0");
  const untracked: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== " ") throw new Error("Refusing malformed git status record");
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) throw new Error("Refusing empty path in git status");
    if (status === "??") untracked.push(path);
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      if (index >= records.length || !records[index]) {
        throw new Error("Refusing malformed rename/copy record in git status");
      }
    }
  }
  return untracked;
}

function pathSetDigest(paths: string[]): string {
  return createHash("sha256")
    .update(`${[...paths].sort().join("\n")}\n`)
    .digest("hex");
}

function evaluateCandidatePathSet(changedPaths: string[]) {
  const changed = new Set(changedPaths);
  const published = new Set(combinedCandidatePaths);
  return {
    missing: combinedCandidatePaths.filter((path) => !changed.has(path)),
    extra: [...changed].filter((path) => !published.has(path)),
  };
}

function requireCandidateOwnership(paths: string[]): "candidate" | "identity-only" {
  const overlap = paths.filter((path) => combinedCandidatePaths.includes(path));
  if (overlap.length === 0) return "identity-only";
  const report = evaluateCandidatePathSet(paths);
  const digest = pathSetDigest(paths);
  if (report.missing.length || report.extra.length || digest !== combinedCandidatePathDigest) {
    throw new Error(
      `Refusing partial Ink & Foil candidate ownership: missing=${JSON.stringify(report.missing)} extra=${JSON.stringify(report.extra)} digest=${digest}`,
    );
  }
  return "candidate";
}

function readHeadTopology(repository: string, git: GitCommand) {
  const head = requireCommitSha(gitText(repository, ["rev-parse", "--verify", "HEAD^{commit}"], git), "HEAD");
  const raw = git(repository, ["cat-file", "-p", "HEAD"]);
  const headerEnd = raw.indexOf("\n\n");
  if (headerEnd === -1) throw new Error("Refusing malformed raw HEAD commit headers");
  const headers = raw.slice(0, headerEnd).split("\n");
  const tree = requireCommitSha(headers.find((line) => line.startsWith("tree "))?.slice(5), "HEAD tree");
  const parents = headers
    .filter((line) => line.startsWith("parent "))
    .map((line, index) => requireCommitSha(line.slice(7), `HEAD parent ${index + 1}`));
  return { head, tree, parents };
}

function commitExists(repository: string, sha: string, git: GitCommand): boolean {
  try {
    return gitText(repository, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], git) === sha;
  } catch {
    return false;
  }
}

function materializeExactParent(repository: string, authority: CandidateBaseAuthority, git: GitCommand): void {
  if (commitExists(repository, authority.base, git)) return;
  try {
    git(repository, ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", authority.base]);
  } catch {
    // The exact post-fetch object check owns the fail-closed result.
  }
  if (!commitExists(repository, authority.base, git)) {
    throw new Error(`Refusing unavailable ${authority.authority} closure parent ${authority.base}`);
  }
}

function resolveCandidateBaseAuthority(
  repository: string,
  environment: GitHubEnvironment = process.env,
  git: GitCommand = executeGit,
): CandidateBaseAuthority {
  let worktree: string;
  try {
    worktree = gitText(repository, ["rev-parse", "--is-inside-work-tree"], git);
  } catch {
    throw new Error(`Refusing candidate base authority: ${repository} is not a readable Git worktree`);
  }
  if (worktree !== "true") {
    throw new Error(`Refusing candidate base authority: ${repository} is not a Git worktree`);
  }

  const eventName = environment.GITHUB_EVENT_NAME;
  const topology = readHeadTopology(repository, git);
  if (eventName === undefined) {
    let base: string;
    try {
      base = requireCommitSha(
        gitText(repository, ["merge-base", "HEAD", "refs/remotes/origin/main"], git),
        "local merge base",
      );
    } catch {
      throw new Error("Refusing local candidate base authority: refs/remotes/origin/main has no merge base with HEAD");
    }
    return {
      authority: "refs/remotes/origin/main",
      base,
      event: "local",
      ref: "refs/remotes/origin/main",
      ...topology,
      witness: null,
    };
  }
  if (eventName !== "pull_request" && eventName !== "merge_group") {
    throw new Error(`Refusing unhandled GITHUB_EVENT_NAME ${JSON.stringify(eventName)}`);
  }

  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error(`Refusing ${eventName} ref topology: GITHUB_EVENT_PATH is not set`);
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    throw new Error(`Refusing ${eventName} ref topology: GITHUB_EVENT_PATH is unreadable or malformed`);
  }
  const payload = event as {
    number?: unknown;
    merge_group?: { base_sha?: unknown; head_ref?: unknown; head_sha?: unknown };
    pull_request?: { base?: { sha?: unknown }; head?: { sha?: unknown } };
  };
  const environmentHead = requireCommitSha(environment.GITHUB_SHA, "GITHUB_SHA");
  if (environmentHead !== topology.head) {
    throw new Error(`Refusing ${eventName} ref topology: HEAD ${topology.head} != GITHUB_SHA ${environmentHead}`);
  }
  const environmentRef = environment.GITHUB_REF;
  if (typeof environmentRef !== "string" || environmentRef.length === 0) {
    throw new Error(`Refusing ${eventName} ref topology: GITHUB_REF is missing`);
  }

  let resolved: CandidateBaseAuthority;
  if (eventName === "pull_request") {
    const eventNumber = payload.number;
    if (typeof eventNumber !== "number" || !Number.isSafeInteger(eventNumber) || eventNumber <= 0) {
      throw new Error("Refusing pull_request ref topology: event number is malformed");
    }
    const expectedRef = `refs/pull/${eventNumber}/merge`;
    if (environmentRef !== expectedRef) {
      throw new Error(`Refusing pull_request ref topology: GITHUB_REF ${environmentRef} != ${expectedRef}`);
    }
    const headWitness = requireCommitSha(payload.pull_request?.head?.sha, "pull_request.head.sha");
    const baseWitness = requireCommitSha(payload.pull_request?.base?.sha, "pull_request.base.sha");
    if (topology.parents.length !== 2) {
      throw new Error(
        `Refusing pull_request ref topology: expected 2 HEAD parents, received ${topology.parents.length}`,
      );
    }
    if (topology.parents[1] !== headWitness) {
      throw new Error(
        `Refusing pull_request ref topology: HEAD parent 2 ${topology.parents[1]} != pull_request.head.sha ${headWitness}`,
      );
    }
    resolved = {
      authority: "pull_request.merge-ref-parent-1",
      base: topology.parents[0]!,
      event: eventName,
      ref: environmentRef,
      ...topology,
      witness: { name: "pull_request.base.sha", sha: baseWitness },
    };
  } else {
    const groupHead = requireCommitSha(payload.merge_group?.head_sha, "merge_group.head_sha");
    const groupBaseWitness = requireCommitSha(payload.merge_group?.base_sha, "merge_group.base_sha");
    const groupRef = payload.merge_group?.head_ref;
    if (typeof groupRef !== "string" || groupRef.length === 0) {
      throw new Error("Refusing merge_group ref topology: merge_group.head_ref is missing");
    }
    if (environmentRef !== groupRef) {
      throw new Error(`Refusing merge_group ref topology: GITHUB_REF ${environmentRef} != ${groupRef}`);
    }
    if (groupHead !== topology.head) {
      throw new Error(`Refusing merge_group ref topology: HEAD ${topology.head} != merge_group.head_sha ${groupHead}`);
    }
    if (topology.parents.length !== 1) {
      throw new Error(`Refusing merge_group ref topology: expected 1 HEAD parent, received ${topology.parents.length}`);
    }
    resolved = {
      authority: "merge_group.head-parent",
      base: topology.parents[0]!,
      event: eventName,
      ref: environmentRef,
      ...topology,
      witness: { name: "merge_group.base_sha", sha: groupBaseWitness },
    };
  }

  materializeExactParent(repository, resolved, git);
  return resolved;
}

function candidateChangedPaths(
  repository: string,
  environment: GitHubEnvironment = process.env,
  git: GitCommand = executeGit,
): CandidateBaseAuthority & { paths: string[]; ownership: "candidate" | "identity-only" } {
  const resolved = resolveCandidateBaseAuthority(repository, environment, git);
  const diffArgs =
    resolved.event === "local"
      ? ["diff", "--name-only", "-z", resolved.base]
      : ["diff", "--name-only", "-z", resolved.base, "HEAD"];
  const tracked = parseNulPaths(git(repository, diffArgs), "git diff");
  const untracked = parseUntrackedStatus(git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const paths = [...tracked, ...untracked];
  const duplicate = paths.find((path, index) => paths.indexOf(path) !== index);
  if (duplicate) throw new Error(`Refusing duplicate changed path ${JSON.stringify(duplicate)}`);
  return { ...resolved, paths, ownership: requireCandidateOwnership(paths) };
}

// ---------------------------------------------------------------------------
// Stylesheet block model: ordered declaration names per declaration-carrying
// block. The fence binds names and per-block counts, never absolute line
// ranges, because the Fontsource imports shift every range by construction.
// ---------------------------------------------------------------------------

type DeclarationBlock = { names: string[]; values: Map<string, string> };

function parseDeclarationBlocks(css: string): DeclarationBlock[] {
  const stack: { names: string[]; values: Map<string, string> }[] = [];
  const blocks: DeclarationBlock[] = [];
  for (const line of css.split("\n")) {
    const opens = (line.match(/{/g) ?? []).length;
    const closes = (line.match(/}/g) ?? []).length;
    if (opens) stack.push({ names: [], values: new Map() });
    const top = stack[stack.length - 1];
    const declaration = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/);
    if (top && declaration) {
      top.names.push(declaration[1]!);
      if (!top.values.has(declaration[1]!)) top.values.set(declaration[1]!, declaration[2]!);
    }
    for (let k = 0; k < closes; k++) {
      const done = stack.pop();
      if (done && done.names.length) blocks.push(done);
    }
  }
  return blocks;
}

const declarationBlocks = parseDeclarationBlocks(stylesSource);

// Ordered declaration-name lists of the six declaration-carrying blocks,
// generated with the frozen count-derivation model and committed here.
const committedBlockDeclarationNames: string[][] = [
  [
    "--background",
    "--foreground",
    "--card",
    "--card-foreground",
    "--popover",
    "--popover-foreground",
    "--primary",
    "--primary-foreground",
    "--primary-hover",
    "--primary-active",
    "--primary-soft",
    "--overlay",
    "--secondary",
    "--secondary-foreground",
    "--muted",
    "--muted-foreground",
    "--accent",
    "--accent-foreground",
    "--border",
    "--border-strong",
    "--input",
    "--ring",
    "--success",
    "--success-soft",
    "--success-hover",
    "--success-active",
    "--success-contrast",
    "--warning",
    "--warning-soft",
    "--warning-hover",
    "--warning-active",
    "--warning-contrast",
    "--danger",
    "--danger-soft",
    "--danger-hover",
    "--danger-active",
    "--danger-contrast",
    "--destructive",
    "--destructive-foreground",
    "--info",
    "--info-soft",
    "--info-hover",
    "--info-active",
    "--info-contrast",
    "--trust",
    "--trust-soft",
    "--deal",
    "--deal-soft",
    "--rating",
    "--rating-soft",
    "--surface-2",
    "--surface-3",
    "--elevated",
    "--disabled-bg",
    "--disabled-text",
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--text-disabled",
    "--chase-logo-start",
    "--chase-logo-mid",
    "--chase-logo-end",
    "--page-spotlight-a",
    "--page-spotlight-b",
    "--surface-line",
    "--surface-depth",
    "--shadow-sm",
    "--shadow-md",
    "--shadow-lg",
    "--shadow-overlay",
    "--display-font",
    "--body-font",
    "--mono-font",
    "--radius",
    "--radius-lg",
    "--radius-xl",
    "--radius-full",
    "--border-width-0",
    "--border-width-sm",
    "--border-width-md",
    "--border-width-lg",
    "--opacity-disabled",
    "--opacity-overlay",
    "--space-unit",
    "--space-0",
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-5",
    "--space-6",
    "--space-7",
    "--space-8",
    "--space-9",
    "--space-10",
    "--space-11",
    "--space-12",
    "--motion-base",
    "--motion-fast",
    "--motion-slow",
    "--motion-ease",
    "--control-sm-height",
    "--control-md-height",
    "--control-lg-height",
    "--control-sm-px",
    "--control-md-px",
    "--control-lg-px",
    "--control-sm-py",
    "--control-md-py",
    "--control-lg-py",
    "--control-sm-icon-size",
    "--control-md-icon-size",
    "--control-lg-icon-size",
    "--control-compact-sm-height",
    "--control-compact-md-height",
    "--control-compact-lg-height",
    "--control-compact-sm-px",
    "--control-compact-md-px",
    "--control-compact-lg-px",
    "--control-compound-inset",
    "--control-py",
    "--control-px",
    "--z-sticky",
    "--z-dropdown",
    "--z-popover",
    "--z-drawer",
    "--z-modal",
    "--z-toast",
  ],
  [
    "--dark-background",
    "--dark-foreground",
    "--dark-card",
    "--dark-card-foreground",
    "--dark-popover",
    "--dark-popover-foreground",
    "--dark-primary",
    "--dark-primary-foreground",
    "--dark-primary-hover",
    "--dark-primary-active",
    "--dark-primary-soft",
    "--dark-overlay",
    "--dark-secondary",
    "--dark-secondary-foreground",
    "--dark-muted",
    "--dark-muted-foreground",
    "--dark-accent",
    "--dark-accent-foreground",
    "--dark-border",
    "--dark-border-strong",
    "--dark-input",
    "--dark-ring",
    "--dark-success",
    "--dark-success-soft",
    "--dark-success-hover",
    "--dark-success-active",
    "--dark-success-contrast",
    "--dark-warning",
    "--dark-warning-soft",
    "--dark-warning-hover",
    "--dark-warning-active",
    "--dark-warning-contrast",
    "--dark-danger",
    "--dark-danger-soft",
    "--dark-danger-hover",
    "--dark-danger-active",
    "--dark-danger-contrast",
    "--dark-destructive",
    "--dark-destructive-foreground",
    "--dark-info",
    "--dark-info-soft",
    "--dark-info-hover",
    "--dark-info-active",
    "--dark-info-contrast",
    "--dark-trust",
    "--dark-trust-soft",
    "--dark-deal",
    "--dark-deal-soft",
    "--dark-rating",
    "--dark-rating-soft",
    "--dark-surface-2",
    "--dark-surface-3",
    "--dark-elevated",
    "--dark-disabled-bg",
    "--dark-disabled-text",
    "--dark-text-primary",
    "--dark-text-secondary",
    "--dark-text-muted",
    "--dark-text-disabled",
    "--dark-chase-logo-start",
    "--dark-chase-logo-mid",
    "--dark-chase-logo-end",
    "--dark-page-spotlight-a",
    "--dark-page-spotlight-b",
    "--dark-surface-line",
    "--dark-surface-depth",
    "--dark-shadow-sm",
    "--dark-shadow-md",
    "--dark-shadow-lg",
    "--dark-shadow-overlay",
  ],
  [
    "--background",
    "--foreground",
    "--card",
    "--card-foreground",
    "--popover",
    "--popover-foreground",
    "--primary",
    "--primary-foreground",
    "--primary-hover",
    "--primary-active",
    "--primary-soft",
    "--overlay",
    "--secondary",
    "--secondary-foreground",
    "--muted",
    "--muted-foreground",
    "--accent",
    "--accent-foreground",
    "--border",
    "--border-strong",
    "--input",
    "--ring",
    "--success",
    "--success-soft",
    "--success-hover",
    "--success-active",
    "--success-contrast",
    "--warning",
    "--warning-soft",
    "--warning-hover",
    "--warning-active",
    "--warning-contrast",
    "--danger",
    "--danger-soft",
    "--danger-hover",
    "--danger-active",
    "--danger-contrast",
    "--destructive",
    "--destructive-foreground",
    "--info",
    "--info-soft",
    "--info-hover",
    "--info-active",
    "--info-contrast",
    "--trust",
    "--trust-soft",
    "--deal",
    "--deal-soft",
    "--rating",
    "--rating-soft",
    "--surface-2",
    "--surface-3",
    "--elevated",
    "--disabled-bg",
    "--disabled-text",
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--text-disabled",
    "--chase-logo-start",
    "--chase-logo-mid",
    "--chase-logo-end",
    "--page-spotlight-a",
    "--page-spotlight-b",
    "--surface-line",
    "--surface-depth",
    "--shadow-sm",
    "--shadow-md",
    "--shadow-lg",
    "--shadow-overlay",
  ],
  [
    "--background",
    "--foreground",
    "--card",
    "--card-foreground",
    "--popover",
    "--popover-foreground",
    "--primary",
    "--primary-foreground",
    "--primary-hover",
    "--primary-active",
    "--primary-soft",
    "--overlay",
    "--secondary",
    "--secondary-foreground",
    "--muted",
    "--muted-foreground",
    "--accent",
    "--accent-foreground",
    "--border",
    "--border-strong",
    "--input",
    "--ring",
    "--success",
    "--success-soft",
    "--success-hover",
    "--success-active",
    "--success-contrast",
    "--warning",
    "--warning-soft",
    "--warning-hover",
    "--warning-active",
    "--warning-contrast",
    "--danger",
    "--danger-soft",
    "--danger-hover",
    "--danger-active",
    "--danger-contrast",
    "--destructive",
    "--destructive-foreground",
    "--info",
    "--info-soft",
    "--info-hover",
    "--info-active",
    "--info-contrast",
    "--trust",
    "--trust-soft",
    "--deal",
    "--deal-soft",
    "--rating",
    "--rating-soft",
    "--surface-2",
    "--surface-3",
    "--elevated",
    "--disabled-bg",
    "--disabled-text",
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--text-disabled",
    "--chase-logo-start",
    "--chase-logo-mid",
    "--chase-logo-end",
    "--page-spotlight-a",
    "--page-spotlight-b",
    "--surface-line",
    "--surface-depth",
    "--shadow-sm",
    "--shadow-md",
    "--shadow-lg",
    "--shadow-overlay",
  ],
  [
    "--color-background",
    "--color-surface",
    "--color-surface-2",
    "--color-surface-3",
    "--color-elevated-surface",
    "--color-border",
    "--color-muted-border",
    "--color-text-primary",
    "--color-text-secondary",
    "--color-text-tertiary",
    "--color-text-disabled",
    "--color-text-inverse",
    "--color-brand-primary",
    "--color-brand-secondary",
    "--color-primary",
    "--color-primary-soft",
    "--color-overlay",
    "--color-accent",
    "--color-accent-2",
    "--color-accent-soft",
    "--color-accent-contrast",
    "--color-success",
    "--color-success-soft",
    "--color-success-hover",
    "--color-success-active",
    "--color-success-contrast",
    "--color-warning",
    "--color-warning-soft",
    "--color-warning-hover",
    "--color-warning-active",
    "--color-warning-contrast",
    "--color-danger",
    "--color-danger-soft",
    "--color-danger-hover",
    "--color-danger-active",
    "--color-danger-contrast",
    "--color-info",
    "--color-info-soft",
    "--color-info-hover",
    "--color-info-active",
    "--color-info-contrast",
    "--color-trust",
    "--color-trust-soft",
    "--color-deal",
    "--color-deal-soft",
    "--color-rating",
    "--color-rating-soft",
    "--color-focus-ring",
    "--color-accent-hover",
    "--color-accent-active",
    "--font-display",
    "--font-heading",
    "--font-body",
    "--font-mono",
    "--font-size-3xs",
    "--font-size-2xs",
    "--font-size-xs",
    "--font-size-sm",
    "--font-size-base",
    "--font-size-lg",
    "--font-size-xl",
    "--font-size-2xl",
    "--font-size-3xl",
    "--font-size-4xl",
    "--font-size-5xl",
    "--line-height-3xs",
    "--line-height-2xs",
    "--line-height-xs",
    "--line-height-sm",
    "--line-height-base",
    "--line-height-lg",
    "--line-height-xl",
    "--line-height-2xl",
    "--line-height-3xl",
    "--line-height-4xl",
    "--line-height-5xl",
    "--line-height-none",
    "--line-height-tight",
    "--line-height-snug",
    "--line-height-normal",
    "--line-height-relaxed",
    "--line-height-display",
    "--line-height-hero",
    "--line-height-badge",
    "--letter-spacing-none",
    "--letter-spacing-normal",
    "--letter-spacing-wide",
    "--letter-spacing-label",
    "--radius-sm",
    "--radius-md",
  ],
  [
    "--control-sm-height",
    "--control-md-height",
    "--control-lg-height",
    "--control-sm-px",
    "--control-md-px",
    "--control-lg-px",
    "--control-sm-py",
    "--control-md-py",
    "--control-lg-py",
    "--control-sm-icon-size",
    "--control-md-icon-size",
    "--control-lg-icon-size",
    "--control-py",
    "--control-px",
  ],
];

const advancedNames = [
  "--display-font",
  "--font-display",
  "--font-heading",
  "--chase-logo-start",
  "--chase-logo-mid",
  "--chase-logo-end",
] as const;

describe("Ink & Foil display type and brand foil values", () => {
  it("resolves each of the six advanced names to the fixture candidate in its owning block", () => {
    const lightBlock = declarationBlocks[0]!;
    const darkLiteralBlock = declarationBlocks[1]!;
    const aliasBlock = declarationBlocks[4]!;

    const anchors: Array<[string, string | undefined, string]> = [
      [
        "light --chase-logo-start",
        lightBlock.values.get("--chase-logo-start"),
        fixture.light["--chase-logo-start"]!.candidate,
      ],
      [
        "light --chase-logo-mid",
        lightBlock.values.get("--chase-logo-mid"),
        fixture.light["--chase-logo-mid"]!.candidate,
      ],
      [
        "light --chase-logo-end",
        lightBlock.values.get("--chase-logo-end"),
        fixture.light["--chase-logo-end"]!.candidate,
      ],
      ["light --display-font", lightBlock.values.get("--display-font"), fixture.light["--display-font"]!.candidate],
      [
        "dark --dark-chase-logo-start",
        darkLiteralBlock.values.get("--dark-chase-logo-start"),
        fixture.dark["--chase-logo-start"]!.candidate,
      ],
      [
        "dark --dark-chase-logo-mid",
        darkLiteralBlock.values.get("--dark-chase-logo-mid"),
        fixture.dark["--chase-logo-mid"]!.candidate,
      ],
      [
        "dark --dark-chase-logo-end",
        darkLiteralBlock.values.get("--dark-chase-logo-end"),
        fixture.dark["--chase-logo-end"]!.candidate,
      ],
      ["alias --font-display", aliasBlock.values.get("--font-display"), fixture.light["--font-display"]!.candidate],
      ["alias --font-heading", aliasBlock.values.get("--font-heading"), fixture.light["--font-heading"]!.candidate],
    ];
    const mismatches = anchors
      .filter(([, actual, expected]) => actual !== expected)
      .map(
        ([label, actual, expected]) =>
          `${label}: styles.css resolves ${String(actual)}, fixture candidate is ${expected}`,
      );
    expect(mismatches, "advanced anchors out of transcription").toEqual([]);

    // No dark alias exists for the three font names, so their dark resolution
    // is the light literal and the fixture keys light and dark identically.
    expect(fixture.dark["--display-font"]!.candidate).toBe(fixture.light["--display-font"]!.candidate);
    expect(fixture.dark["--font-display"]!.candidate).toBe(fixture.light["--font-display"]!.candidate);
    expect(fixture.dark["--font-heading"]!.candidate).toBe(fixture.light["--font-heading"]!.candidate);
  });

  it("keeps the stylesheet values-only: six blocks, ordered declaration names, per-block counts", () => {
    expect(declarationBlocks.length).toBe(6);
    const counts = declarationBlocks.map((block) => block.names.length);
    expect(counts).toEqual([128, 70, 70, 70, 90, 14]);
    for (let i = 0; i < 6; i++) {
      expect(declarationBlocks[i]!.names, `declaration set changed in block ${i + 1}`).toEqual(
        committedBlockDeclarationNames[i]!,
      );
    }
  });

  it("imports all three Fontsource families at identical per-weight latin entrypoints backed by declared dependencies", () => {
    const imports = [...stylesSource.matchAll(/^@import "(@fontsource\/[\w-]+)\/([\w.-]+)";$/gm)].map((match) => ({
      pkg: match[1]!,
      entry: match[2]!,
    }));
    const byPackage = new Map<string, string[]>();
    for (const entry of imports) {
      byPackage.set(entry.pkg, [...(byPackage.get(entry.pkg) ?? []), entry.entry]);
    }
    expect([...byPackage.keys()].sort()).toEqual([
      "@fontsource/ibm-plex-mono",
      "@fontsource/ibm-plex-sans",
      "@fontsource/space-grotesk",
    ]);
    for (const [pkg, entries] of byPackage) {
      expect(entries, `${pkg} weight entrypoints`).toEqual([
        "latin-400.css",
        "latin-500.css",
        "latin-600.css",
        "latin-700.css",
      ]);
    }
    const packageJson = JSON.parse(readFileSync(join(root, "packages", "design-system", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const pkg of byPackage.keys()) {
      expect(packageJson.dependencies[pkg], `${pkg} must be a declared dependency`).toBeDefined();
    }
  });

  it("keeps tokens.ts in agreement with the stylesheet for all four font roles", () => {
    const tokensSource = readFileSync(join(designSystemSrc, "theme", "tokens.ts"), "utf8");
    const role = (name: string) => {
      const match = tokensSource.match(new RegExp(`${name}: '(var\\([^']+\\))',`));
      if (!match) throw new Error(`typography.${name} not found in tokens.ts`);
      return match[1]!;
    };
    expect(role("display")).toBe(
      'var(--display-font, "Space Grotesk", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif)',
    );
    expect(role("heading")).toBe('var(--font-heading, "Space Grotesk")');
    // body and mono do not move; --body-font is the only font name a Stripe
    // factory consumes and it must stay at its pre-change bytes.
    expect(role("body")).toBe('var(--body-font, "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif)');
    expect(role("mono")).toBe('var(--mono-font, "IBM Plex Mono", ui-monospace, monospace)');
    const lightBlock = declarationBlocks[0]!;
    expect(lightBlock.values.get("--body-font")).toBe('"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif');
    expect(lightBlock.values.get("--mono-font")).toBe('"IBM Plex Mono", ui-monospace, monospace');
    // The tokens.ts fallbacks restate the stylesheet values character for
    // character.
    expect(role("display")).toContain(lightBlock.values.get("--display-font")!);
  });

  it("derives each display/heading name's consumer set and keeps all three outside the Stripe factory", () => {
    const gitGrepFiles = (pattern: string): string[] => {
      try {
        return execFileSync(
          "git",
          [
            "-C",
            root,
            "grep",
            "--untracked",
            "-lE",
            pattern,
            "--",
            "packages",
            "bounded-contexts",
            "deployables",
            "contracts",
          ],
          { encoding: "utf8" },
        )
          .split("\n")
          .filter(Boolean)
          .map((file) => file.replaceAll("\\", "/"))
          .sort();
      } catch {
        return [];
      }
    };

    const displayFontRules = [...stylesSource.matchAll(/^\s*font-family:\s*var\(--display-font\);\s*$/gm)];
    expect(displayFontRules.length).toBe(1);
    expect(stylesSource).toMatch(/\.ds-display,\s*\n\s*\.ds-label \{\s*\n\s*font-family: var\(--display-font\);/);

    const consumers = {
      "--display-font": gitGrepFiles("\\b(ds-display|ds-label)\\b"),
      "--font-display": gitGrepFiles("\\bfont-display\\b"),
      "--font-heading": gitGrepFiles("\\bfont-heading\\b"),
    };
    console.log(`derived consumer sets:\n${JSON.stringify(consumers, null, 2)}`);

    const committedConsumers: Record<string, string[]> = {
      "--display-font": [
        "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
        "packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts",
        "packages/design-system/src/components/actions/navigation-header.tsx",
        "packages/design-system/src/styles/styles.css",
      ],
      "--font-display": [
        "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
        "packages/design-system/src/__tests__/ink-foil-candidate-fixture.test.ts",
        "packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts",
        "packages/design-system/src/patterns/app-shells/marketing.tsx",
        "packages/design-system/src/patterns/app-shells/page-layouts.tsx",
        "packages/design-system/src/primitives/typography.tsx",
        "packages/design-system/src/styles/styles.css",
        "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
        "packages/design-system/src/theme/tokens.ts",
      ],
      "--font-heading": [
        "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
        "packages/design-system/src/__tests__/design-system-components.test.tsx",
        "packages/design-system/src/__tests__/ink-foil-candidate-fixture.test.ts",
        "packages/design-system/src/__tests__/ink-foil-type-and-foil.test.ts",
        "packages/design-system/src/components/actions/account-menu-surfaces.tsx",
        "packages/design-system/src/components/data-display/actor-identity-cue.tsx",
        "packages/design-system/src/components/data-display/card.tsx",
        "packages/design-system/src/components/data-display/comparison-list.tsx",
        "packages/design-system/src/components/data-display/stat.tsx",
        "packages/design-system/src/components/feedback/alert-dialog.tsx",
        "packages/design-system/src/components/feedback/dialog.tsx",
        "packages/design-system/src/components/forms/fieldset.tsx",
        "packages/design-system/src/patterns/app-shells/facets.tsx",
        "packages/design-system/src/patterns/app-shells/marketing.tsx",
        "packages/design-system/src/patterns/app-shells/page-layouts.tsx",
        "packages/design-system/src/patterns/app-shells/product-cards.tsx",
        "packages/design-system/src/patterns/app-shells/product-detail.tsx",
        "packages/design-system/src/patterns/dense-admin-workbench.tsx",
        "packages/design-system/src/primitives/typography.tsx",
        "packages/design-system/src/styles/styles.css",
        "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
        "packages/design-system/src/theme/tokens.ts",
      ],
    };

    for (const name of ["--display-font", "--font-display", "--font-heading"] as const) {
      expect(consumers[name].length, `${name} must have at least one consumer`).toBeGreaterThan(0);
      expect(consumers[name], `derived consumer set for ${name}`).toEqual(committedConsumers[name]);
    }

    const appearanceSource = readFileSync(join(designSystemSrc, "theme", "stripe-appearance.ts"), "utf8");
    for (const name of advancedNames) {
      expect(appearanceSource.includes(name), `${name} must not appear in stripe-appearance.ts`).toBe(false);
    }
  });
});

describe("brand mark sources and parity", () => {
  const rawAssetPath = join(designSystemSrc, "brand", "chase-sets-logo.svg");
  const rawAsset = readFileSync(rawAssetPath, "utf8");

  function parseStyleDeclarations(svg: string, blockPattern: RegExp): Map<string, string> {
    const block = svg.match(blockPattern);
    if (!block) throw new Error(`style block ${blockPattern} not found`);
    const values = new Map<string, string>();
    for (const declaration of block[1]!.matchAll(/(--chase-logo-[\w-]+):\s*([^;]+);/g)) {
      values.set(declaration[1]!, declaration[2]!.trim());
    }
    return values;
  }

  it("declares the fixture foil candidates positively, by name, in the raw asset", () => {
    const lightValues = parseStyleDeclarations(rawAsset, /:root \{([^}]+)\}/);
    const darkValues = parseStyleDeclarations(rawAsset, /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]+)\}/);
    for (const stop of ["start", "mid", "end"] as const) {
      expect(lightValues.get(`--chase-logo-${stop}`), `light --chase-logo-${stop}`).toBe(
        fixture.light[`--chase-logo-${stop}`]!.candidate,
      );
      expect(darkValues.get(`--chase-logo-${stop}`), `dark --chase-logo-${stop}`).toBe(
        fixture.dark[`--chase-logo-${stop}`]!.candidate,
      );
    }
    console.log(
      `raw asset foil declarations: light ${JSON.stringify([...lightValues])} dark ${JSON.stringify([...darkValues])}`,
    );

    const stops = [...rawAsset.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"\/>/g)].map((match) => ({
      offset: match[1]!,
      color: match[2]!,
    }));
    expect(stops).toEqual([
      { offset: "0", color: "var(--chase-logo-start)" },
      { offset: "0.52", color: "var(--chase-logo-mid)" },
      { offset: "1", color: "var(--chase-logo-end)" },
    ]);
  });

  it("keeps the exported string, the raw asset, and the rendered markup in geometric and gradient parity", () => {
    // The exported string is the raw asset byte-for-byte (the file adds one
    // trailing newline), so the representation no test renders cannot drift.
    expect(`${chaseSetsLogoSvg}\n`).toBe(rawAsset);

    const markup = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "auto" }));
    const attr = (source: string, name: string): string[] =>
      [...source.matchAll(new RegExp(`(?<![-\\w])${name}="([^"]+)"`, "g"))].map((match) => match[1]!);

    expect(attr(markup, "viewBox")).toEqual(attr(rawAsset, "viewBox"));
    const markupPaths = attr(markup, "d");
    const assetPaths = attr(rawAsset, "d");
    expect(markupPaths.length).toBe(2);
    expect(markupPaths).toEqual(assetPaths);
    for (const name of ["gradientUnits", "x1", "y1", "x2", "y2"]) {
      expect(attr(markup, name), `gradient ${name}`).toEqual(attr(rawAsset, name));
    }
    expect(attr(markup, "offset")).toEqual(attr(rawAsset, "offset"));
    console.log(
      `parity tuple: viewBox ${attr(rawAsset, "viewBox")[0]}, paths ${assetPaths.length}, gradient ${attr(rawAsset, "x1")[0]},${attr(rawAsset, "y1")[0]} -> ${attr(rawAsset, "x2")[0]},${attr(rawAsset, "y2")[0]}, offsets ${attr(rawAsset, "offset")!.join("/")}`,
    );
  });

  it("renders every colorMode's stops from the fixture, never from a transcription", () => {
    const stopColors = (markup: string): string[] =>
      [...markup.matchAll(/stop-color="([^"]+)"/g)].map((match) => match[1]!);

    const light = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "light" }));
    expect(stopColors(light)).toEqual(
      ["start", "mid", "end"].map((s) => fixture.light[`--chase-logo-${s}`]!.candidate),
    );

    const dark = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "dark" }));
    expect(stopColors(dark)).toEqual(["start", "mid", "end"].map((s) => fixture.dark[`--chase-logo-${s}`]!.candidate));

    const auto = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "auto" }));
    expect(stopColors(auto)).toEqual(
      ["start", "mid", "end"].map((s) => `var(--chase-logo-${s}, ${fixture.light[`--chase-logo-${s}`]!.candidate})`),
    );
  });

  it("carries the forced-colors fallback in all three representations with the rendered gradient id bound", () => {
    const forcedRule = /@media \(forced-colors: active\)/;
    expect(rawAsset).toMatch(forcedRule);
    expect(rawAsset).toMatch(/@media \(forced-colors: active\) \{\s*#logoGradient stop \{\s*stop-color: CanvasText;/);
    expect(chaseSetsLogoSvg).toMatch(
      /@media \(forced-colors: active\) \{\s*#logoGradient stop \{\s*stop-color: CanvasText;/,
    );

    const markup = renderToString(createElement(ChaseSetsLogo, { decorative: true, colorMode: "auto" }));
    const styleRule = markup.match(
      /@media \(forced-colors: active\) \{ #([\w:-]+) stop \{ stop-color: CanvasText; \} \}/,
    );
    expect(styleRule, "React component must carry an id-scoped forced-colors style child").not.toBeNull();
    const gradientId = markup.match(/<linearGradient id="([^"]+)"/);
    expect(gradientId).not.toBeNull();
    expect(styleRule![1], "forced-colors rule must bind the rendered useId-derived gradient id").toBe(gradientId![1]);
  });
});

describe("logo semantics and caller accessibility", () => {
  it("keeps the decorative mode hidden and the non-decorative mode named, with focus suppressed in both", () => {
    const decorative = renderToString(createElement(ChaseSetsLogo, { decorative: true }));
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain("role=");
    expect(decorative).not.toContain("aria-label=");
    expect(decorative).toContain('focusable="false"');

    const named = renderToString(createElement(ChaseSetsLogo, {}));
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Chase Sets"');
    expect(named).toContain('focusable="false"');

    const titled = renderToString(createElement(ChaseSetsLogo, { title: "Chase Sets logo" }));
    expect(titled).toContain('aria-label="Chase Sets logo"');
  });

  it("gives BrandLink exactly its label as accessible name, contributed by the link and never by the mark", () => {
    const markup = renderToString(createElement(BrandLink, { label: "Chase Sets" }));
    expect(markup).toContain('aria-label="Chase Sets"');
    // The mark inside is decorative: hidden from the tree and nameless.
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
  });

  it("keeps SellerBadge's generic container nameless while its verified state reads name-then-Verified", () => {
    const markup = renderToString(createElement(SellerBadge, { name: "Alpha Seller", verified: true }));
    const container = markup.match(/^<div ([^>]*)>/);
    expect(container).not.toBeNull();
    expect(container![1]).not.toContain("role=");
    expect(container![1]).not.toContain("aria-label");
    expect(markup.split("Alpha Seller").length - 1).toBe(1);
    expect(markup).toContain("Verified");
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("closed-set closure from the vector side", () => {
  it("parses the same thirty-three paths out of the raster-side sentinel block", () => {
    console.log(
      `combinedCandidatePaths as parsed on the vector side:\n${JSON.stringify(combinedCandidatePaths, null, 2)}`,
    );
    expect(combinedCandidatePaths.length).toBe(33);
    expect(new Set(combinedCandidatePaths).size).toBe(33);
    expect(combinedCandidatePaths).toContain("packages/design-system/src/styles/styles.css");
    expect(combinedCandidatePaths).toContain("infrastructure/playwright-evidence/responsive-evidence-manifest.json");
  });

  it("resolves hosted closure from raw ref topology and refuses stale projections", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ink-foil-ref-topology-"));
    try {
      const sourceRoot = join(workspace, "origin");
      const cloneRoot = join(workspace, "shallow");
      mkdirSync(sourceRoot);
      const run = (args: string[]) => gitText(sourceRoot, args, executeGit);
      const write = (path: string, value: string) => {
        const absolute = join(sourceRoot, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, value);
      };
      const commit = (message: string) => {
        executeGit(sourceRoot, ["add", "."]);
        executeGit(sourceRoot, ["commit", "--quiet", "-m", message]);
        return run(["rev-parse", "HEAD"]);
      };
      const pullRequestEnvironment = (eventPath: string, head: string, number: number): GitHubEnvironment => ({
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF: "refs/pull/" + number + "/merge",
        GITHUB_SHA: head,
      });
      const writePullRequestEvent = (path: string, number: number, base: string, head: string) =>
        writeFileSync(path, JSON.stringify({ number, pull_request: { base: { sha: base }, head: { sha: head } } }));
      const writeMergeGroupEvent = (path: string, base: string, head: string, ref: string) =>
        writeFileSync(path, JSON.stringify({ merge_group: { base_sha: base, head_ref: ref, head_sha: head } }));

      executeGit(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
      executeGit(sourceRoot, ["config", "user.name", "ref-topology-control"]);
      executeGit(sourceRoot, ["config", "user.email", "ref-topology-control@invalid"]);
      executeGit(sourceRoot, ["config", "commit.gpgsign", "false"]);
      executeGit(sourceRoot, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
      write("shared.txt", "shared\n");
      const staleEventBase = commit("shared ancestor");

      executeGit(sourceRoot, ["switch", "--quiet", "-c", "candidate"]);
      combinedCandidatePaths.forEach((path, index) => write(path, "candidate-" + index + "\n"));
      const candidateHead = commit("candidate change");

      executeGit(sourceRoot, ["switch", "--quiet", "main"]);
      write("main-only-one.txt", "main one\n");
      write("main-only-two.txt", "main two\n");
      const currentBase = commit("current base");
      executeGit(sourceRoot, ["switch", "--quiet", "-c", "pull-merge"]);
      executeGit(sourceRoot, ["merge", "--quiet", "--no-ff", "candidate", "-m", "synthetic pull request merge ref"]);
      const pullMergeHead = run(["rev-parse", "HEAD"]);
      executeGit(sourceRoot, ["update-ref", "refs/remotes/origin/main", currentBase]);

      const local = candidateChangedPaths(sourceRoot, {});
      expect(local.authority).toBe("refs/remotes/origin/main");
      expect(local.base).toBe(currentBase);
      expect(local.ownership).toBe("candidate");
      expect(local.paths.length).toBe(33);
      expect(pathSetDigest(local.paths)).toBe(combinedCandidatePathDigest);

      const sourceUrl = "file:///" + sourceRoot.replace(/\\/g, "/").replace(/^\/+/, "");
      executeGit(workspace, [
        "clone",
        "--quiet",
        "--depth=1",
        "--single-branch",
        "--branch",
        "pull-merge",
        sourceUrl,
        cloneRoot,
      ]);
      expect(gitText(cloneRoot, ["rev-parse", "--is-shallow-repository"], executeGit)).toBe("true");
      expect(commitExists(cloneRoot, currentBase, executeGit)).toBe(false);

      const pullRequestEventPath = join(workspace, "pull-request-event.json");
      writePullRequestEvent(pullRequestEventPath, 6781, staleEventBase, candidateHead);
      const pullCalls: string[][] = [];
      const recordingGit: GitCommand = (repository, args) => {
        pullCalls.push(args);
        return executeGit(repository, args);
      };
      const pullRequest = candidateChangedPaths(
        cloneRoot,
        pullRequestEnvironment(pullRequestEventPath, pullMergeHead, 6781),
        recordingGit,
      );
      expect(pullRequest.authority).toBe("pull_request.merge-ref-parent-1");
      expect(pullRequest.base).toBe(currentBase);
      expect(pullRequest.parents).toEqual([currentBase, candidateHead]);
      expect(pullRequest.witness).toEqual({ name: "pull_request.base.sha", sha: staleEventBase });
      expect(pullRequest.ownership).toBe("candidate");
      expect(pullRequest.paths.length).toBe(33);
      expect(pathSetDigest(pullRequest.paths)).toBe(combinedCandidatePathDigest);
      expect(pullCalls.filter((args) => args[0] === "fetch")).toEqual([
        ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", currentBase],
      ]);
      expect(pullCalls.some((args) => args[0] === "merge-base")).toBe(false);
      expect(pullCalls.some((args) => args.includes("refs/remotes/origin/main"))).toBe(false);

      const staleDirection = parseNulPaths(
        executeGit(sourceRoot, ["diff", "--name-only", "-z", staleEventBase, pullMergeHead]),
        "stale event-base control",
      );
      expect(staleDirection.length).toBe(35);
      expect(staleDirection).toEqual(expect.arrayContaining(["main-only-one.txt", "main-only-two.txt"]));
      console.log(
        "C1 depth-1 pull_request: event=pull_request ref=" +
          pullRequest.ref +
          " head=" +
          pullRequest.head +
          " parents=" +
          pullRequest.parents.join(",") +
          " closure-base=" +
          pullRequest.base +
          " witness=" +
          pullRequest.witness?.sha +
          " changed=" +
          pullRequest.paths.length +
          " digest=" +
          pathSetDigest(pullRequest.paths) +
          " stale-direction=" +
          staleDirection.length,
      );

      executeGit(sourceRoot, ["switch", "--quiet", "candidate"]);
      executeGit(sourceRoot, ["merge", "--quiet", "--no-ff", "main", "-m", "normal main synchronization"]);
      const synchronizedCandidateHead = run(["rev-parse", "HEAD"]);
      executeGit(sourceRoot, ["switch", "--quiet", "main"]);
      write("main-after-sync.txt", "later disjoint main advance\n");
      const laterBase = commit("later disjoint main advance");
      executeGit(sourceRoot, ["switch", "--quiet", "-c", "pull-merge-synchronized"]);
      executeGit(sourceRoot, [
        "merge",
        "--quiet",
        "--no-ff",
        "candidate",
        "-m",
        "synthetic merge ref after synchronization",
      ]);
      const synchronizedMergeHead = run(["rev-parse", "HEAD"]);
      const synchronizedEventPath = join(workspace, "pull-request-synchronized-event.json");
      writePullRequestEvent(synchronizedEventPath, 6782, currentBase, synchronizedCandidateHead);
      const synchronized = candidateChangedPaths(
        sourceRoot,
        pullRequestEnvironment(synchronizedEventPath, synchronizedMergeHead, 6782),
      );
      expect(synchronized.base).toBe(laterBase);
      expect(synchronized.paths.length).toBe(33);
      expect(pathSetDigest(synchronized.paths)).toBe(combinedCandidatePathDigest);
      expect(synchronized.paths).not.toContain("main-after-sync.txt");
      console.log(
        "C2 synchronized candidate plus later disjoint main advance: changed=33 digest=" +
          pathSetDigest(synchronized.paths),
      );

      executeGit(sourceRoot, ["switch", "--quiet", "-c", "group-candidate", "main"]);
      executeGit(sourceRoot, ["checkout", candidateHead, "--", ...combinedCandidatePaths]);
      const groupCandidateHead = commit("squash candidate");
      const candidateGroupRef = "refs/heads/gh-readonly-queue/main/pr-6781-candidate";
      const candidateGroupEventPath = join(workspace, "merge-group-candidate-event.json");
      writeMergeGroupEvent(candidateGroupEventPath, staleEventBase, groupCandidateHead, candidateGroupRef);
      const groupCandidate = candidateChangedPaths(sourceRoot, {
        GITHUB_EVENT_NAME: "merge_group",
        GITHUB_EVENT_PATH: candidateGroupEventPath,
        GITHUB_REF: candidateGroupRef,
        GITHUB_SHA: groupCandidateHead,
      });
      expect(groupCandidate.authority).toBe("merge_group.head-parent");
      expect(groupCandidate.base).toBe(laterBase);
      expect(groupCandidate.parents).toEqual([laterBase]);
      expect(groupCandidate.ownership).toBe("candidate");
      expect(groupCandidate.paths.length).toBe(33);

      executeGit(sourceRoot, ["switch", "--quiet", "-c", "group-later-disjoint"]);
      write("later-queue-only.txt", "later queue entry\n");
      const disjointHead = commit("later disjoint queue entry");
      const disjointRef = "refs/heads/gh-readonly-queue/main/pr-7000-disjoint";
      const disjointEventPath = join(workspace, "merge-group-disjoint-event.json");
      writeMergeGroupEvent(disjointEventPath, staleEventBase, disjointHead, disjointRef);
      const disjoint = candidateChangedPaths(sourceRoot, {
        GITHUB_EVENT_NAME: "merge_group",
        GITHUB_EVENT_PATH: disjointEventPath,
        GITHUB_REF: disjointRef,
        GITHUB_SHA: disjointHead,
      });
      expect(disjoint.paths).toEqual(["later-queue-only.txt"]);
      expect(disjoint.ownership).toBe("identity-only");

      executeGit(sourceRoot, ["switch", "--quiet", "-c", "group-later-overlap", groupCandidateHead]);
      write(combinedCandidatePaths[0]!, "overlapping later queue entry\n");
      const overlapHead = commit("later overlapping queue entry");
      const overlapRef = "refs/heads/gh-readonly-queue/main/pr-7001-overlap";
      const overlapEventPath = join(workspace, "merge-group-overlap-event.json");
      writeMergeGroupEvent(overlapEventPath, staleEventBase, overlapHead, overlapRef);
      expect(() =>
        candidateChangedPaths(sourceRoot, {
          GITHUB_EVENT_NAME: "merge_group",
          GITHUB_EVENT_PATH: overlapEventPath,
          GITHUB_REF: overlapRef,
          GITHUB_SHA: overlapHead,
        }),
      ).toThrow(/Refusing partial Ink & Foil candidate ownership/);
      const overlapReport = evaluateCandidatePathSet([combinedCandidatePaths[0]!]);
      expect(overlapReport.missing.length).toBe(32);
      console.log("C3 ALLGREEN/SQUASH queue: candidate=33 later-disjoint=identity-only later-overlap-missing=32");

      const malformedEventPath = join(workspace, "malformed-event.json");
      writeFileSync(malformedEventPath, "not json");
      expect(() => resolveCandidateBaseAuthority(sourceRoot, { GITHUB_EVENT_NAME: "pull_request" })).toThrow(
        /GITHUB_EVENT_PATH is not set/,
      );
      expect(() =>
        resolveCandidateBaseAuthority(sourceRoot, {
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: malformedEventPath,
        }),
      ).toThrow(/unreadable or malformed/);
      expect(() =>
        resolveCandidateBaseAuthority(sourceRoot, {
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: pullRequestEventPath,
          GITHUB_REF: "refs/pull/6781/merge",
        }),
      ).toThrow(/malformed GITHUB_SHA/);
      expect(() => resolveCandidateBaseAuthority(sourceRoot, { GITHUB_EVENT_NAME: "push" })).toThrow(
        'Refusing unhandled GITHUB_EVENT_NAME "push"',
      );
      expect(() => resolveCandidateBaseAuthority(sourceRoot, { GITHUB_EVENT_NAME: "" })).toThrow(
        'Refusing unhandled GITHUB_EVENT_NAME ""',
      );

      executeGit(sourceRoot, ["switch", "--quiet", "--detach", candidateHead]);
      const oneParentEventPath = join(workspace, "pull-request-one-parent-event.json");
      writePullRequestEvent(oneParentEventPath, 6783, staleEventBase, candidateHead);
      expect(() =>
        resolveCandidateBaseAuthority(sourceRoot, pullRequestEnvironment(oneParentEventPath, candidateHead, 6783)),
      ).toThrow(/expected 2 HEAD parents, received 1/);
      expect(() =>
        resolveCandidateBaseAuthority(sourceRoot, {
          ...pullRequestEnvironment(oneParentEventPath, candidateHead, 6783),
          GITHUB_REF: "refs/pull/9999/merge",
        }),
      ).toThrow(/GITHUB_REF/);

      executeGit(sourceRoot, ["switch", "--quiet", "--detach", pullMergeHead]);
      const twoParentGroupRef = "refs/heads/gh-readonly-queue/main/pr-6781-two-parent";
      const twoParentGroupEventPath = join(workspace, "merge-group-two-parent-event.json");
      writeMergeGroupEvent(twoParentGroupEventPath, staleEventBase, pullMergeHead, twoParentGroupRef);
      expect(() =>
        resolveCandidateBaseAuthority(sourceRoot, {
          GITHUB_EVENT_NAME: "merge_group",
          GITHUB_EVENT_PATH: twoParentGroupEventPath,
          GITHUB_REF: twoParentGroupRef,
          GITHUB_SHA: pullMergeHead,
        }),
      ).toThrow(/expected 1 HEAD parent, received 2/);
      expect(() =>
        resolveCandidateBaseAuthority(sourceRoot, {
          GITHUB_EVENT_NAME: "merge_group",
          GITHUB_EVENT_PATH: twoParentGroupEventPath,
          GITHUB_REF: twoParentGroupRef + "-wrong",
          GITHUB_SHA: pullMergeHead,
        }),
      ).toThrow(/GITHUB_REF/);
      console.log("C4 missing/malformed event, ref, head and 1/2-parent cardinality: refused");

      const unavailableHead = "a".repeat(40);
      const unavailableParent = "b".repeat(40);
      const unavailablePullHead = "c".repeat(40);
      const unavailableTree = "d".repeat(40);
      const unavailableWitness = "e".repeat(40);
      const unavailableEventPath = join(workspace, "unavailable-parent-event.json");
      writePullRequestEvent(unavailableEventPath, 6784, unavailableWitness, unavailablePullHead);
      const unavailableCalls: string[][] = [];
      const unavailableGit: GitCommand = (_repository, args) => {
        unavailableCalls.push(args);
        if (args.join(" ") === "rev-parse --is-inside-work-tree") return "true\n";
        if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return unavailableHead + "\n";
        if (args.join(" ") === "cat-file -p HEAD") {
          return (
            "tree " +
            unavailableTree +
            "\nparent " +
            unavailableParent +
            "\nparent " +
            unavailablePullHead +
            "\nauthor Synthetic <synthetic@invalid> 0 +0000\ncommitter Synthetic <synthetic@invalid> 0 +0000\n\nfixture\n"
          );
        }
        if (args[0] === "rev-parse" && args.includes(unavailableParent + "^{commit}")) {
          throw new Error("missing");
        }
        if (args[0] === "fetch") throw new Error("unavailable");
        throw new Error("unexpected synthetic git call: " + args.join(" "));
      };
      expect(() =>
        resolveCandidateBaseAuthority(
          workspace,
          pullRequestEnvironment(unavailableEventPath, unavailableHead, 6784),
          unavailableGit,
        ),
      ).toThrow("Refusing unavailable pull_request.merge-ref-parent-1 closure parent " + unavailableParent);
      expect(unavailableCalls.filter((args) => args[0] === "fetch")).toEqual([
        ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", unavailableParent],
      ]);
      console.log("C5 unavailable parent: refused after one exact lowercase-SHA depth-1 no-tags fetch");

      expect(() => parseNulPaths("quoted path\n", "synthetic diff")).toThrow(/NUL-framed/);
      expect(() => parseUntrackedStatus("?? path without terminator")).toThrow(/NUL-framed/);
      expect(() => resolveCandidateBaseAuthority(join(workspace, "not-a-worktree"), {})).toThrow(
        /not a readable Git worktree/,
      );
      console.log("C6 malformed NUL framing and repository root: refused");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves spaces in NUL-framed rename and untracked paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ink-foil-nul-paths-"));
    try {
      executeGit(workspace, ["init", "--quiet", "--initial-branch=main"]);
      executeGit(workspace, ["config", "user.name", "nul-path-control"]);
      executeGit(workspace, ["config", "user.email", "nul-path-control@invalid"]);
      executeGit(workspace, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(workspace, "old name.txt"), "tracked\n");
      executeGit(workspace, ["add", "."]);
      executeGit(workspace, ["commit", "--quiet", "-m", "tracked path"]);
      const base = gitText(workspace, ["rev-parse", "HEAD"], executeGit);
      executeGit(workspace, ["update-ref", "refs/remotes/origin/main", base]);
      executeGit(workspace, ["mv", "old name.txt", "new name.txt"]);
      writeFileSync(join(workspace, "untracked name.txt"), "untracked\n");

      const resolved = candidateChangedPaths(workspace, {});
      expect(resolved.ownership).toBe("identity-only");
      expect(resolved.paths).toContain("new name.txt");
      expect(resolved.paths).toContain("untracked name.txt");
      expect(resolved.paths.some((path) => path.includes('"'))).toBe(false);
      console.log("C7 NUL paths with spaces: " + JSON.stringify(resolved.paths));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("takes a changed-path set as an explicit argument and reports missing and extra paths by name", () => {
    // Synthetic controls, passed directly -- never read from an ambient
    // changed-files variable.
    const omitted = evaluateCandidatePathSet(combinedCandidatePaths.filter((p) => p !== "pnpm-lock.yaml"));
    expect(omitted.missing).toEqual(["pnpm-lock.yaml"]);
    const added = evaluateCandidatePathSet([...combinedCandidatePaths, "packages/design-system/src/scratch.ts"]);
    expect(added.extra).toEqual(["packages/design-system/src/scratch.ts"]);
    expect(() => requireCandidateOwnership([combinedCandidatePaths[0]!])).toThrow(
      /Refusing partial Ink & Foil candidate ownership/,
    );

    // The real candidate set, when one is in flight. Hosted authority comes
    // only from the checked-out ref's raw topology; event-base fields are
    // witnesses. The fully qualified remote-tracking fallback is local-only.
    const resolved = candidateChangedPaths(root);
    const changed = resolved.paths;
    console.log(
      `ink-foil/ref-topology/v2 event=${resolved.event} ref=${resolved.ref} head=${resolved.head} tree=${resolved.tree} parents=${resolved.parents.join(",")} closure-base=${resolved.base} witness=${resolved.witness?.name ?? "none"}:${resolved.witness?.sha ?? "none"} ownership=${resolved.ownership}`,
    );
    console.log(`real changed-path set on the vector side (${changed.length}):\n${JSON.stringify(changed, null, 2)}`);
    if (changed.some((p) => combinedCandidatePaths.includes(p))) {
      const report = evaluateCandidatePathSet(changed);
      expect(report.missing, "paths the candidate is missing").toEqual([]);
      expect(report.extra, "paths outside the published thirty-three").toEqual([]);
      expect(resolved.ownership).toBe("candidate");
      expect(pathSetDigest(changed)).toBe(combinedCandidatePathDigest);
    } else {
      const identity = evaluateCandidatePathSet(combinedCandidatePaths);
      expect(identity.missing).toEqual([]);
      expect(identity.extra).toEqual([]);
      expect(resolved.ownership).toBe("identity-only");
    }
  });

  it("derives the receipt-source digest paths from both probe specs and proves the candidate touches none", () => {
    const probeSpecs = [
      "deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts",
      "deployables/marketplace/e2e/payout-connect-appearance.uat.spec.ts",
    ];
    const derived = new Set<string>();
    for (const spec of probeSpecs) {
      for (const path of deriveReceiptSourceDigestPaths(readFileSync(join(root, spec), "utf8"))) {
        derived.add(path);
      }
    }
    console.log(`derived receiptSourceDigestPaths union:\n${JSON.stringify([...derived].sort(), null, 2)}`);
    expect(derived.size).toBe(5);
    const intersection = [...derived].filter((path) => combinedCandidatePaths.includes(path));
    expect(intersection, "digest-bound paths inside the candidate").toEqual([]);
  });

  it("keeps the fixtures directory at exactly its four committed files", () => {
    const entries = readdirSync(join(designSystemSrc, "theme", "__fixtures__")).sort();
    expect(entries).toEqual([
      "ink-foil-candidate-tokens.json",
      "ink-foil-candidate-tokens.schema.json",
      "stripe-appearance-acceptance-receipt.schema.json",
      "stripe-connect-discovery.schema.json",
    ]);
  });
});
