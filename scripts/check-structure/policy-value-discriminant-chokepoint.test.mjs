import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CORTEN_POLICY_VALUE_RENDERER,
  canonicalPolicyValueDiscriminantAllowlist,
  cortenPolicyValueRendererAllowlist,
  cortenPolicyValueRendererMarkers,
  findCortenPolicyValueRendererViolations,
  findPolicyValueDiscriminantViolations,
  listCortenPolicyValueGuardCandidates,
  listPolicyValueDiscriminantGuardCandidates,
  readPolicyValueDiscriminantGuardSources,
  validatePolicyValueDiscriminantChokepoint,
} from "./policy-value-discriminant-chokepoint.mjs";

const resolveArticlePolicyValuesPath =
  "bounded-contexts/public-presence/features/help/domain/resolve-article-policy-values.ts";
const articleModelPath = "bounded-contexts/public-presence/features/help/domain/article-model.ts";
const policyValueStatePath = "bounded-contexts/public-presence/features/help/domain/policy-value-state.ts";
const articleCatalogPath = "bounded-contexts/public-presence/features/help/domain/article-catalog.ts";
const cortenHelpPath = "deployables/corten-pilot/public/src/help.rs";

function cortenRecord(relativePath) {
  return { relativePath, source: readFileSync(path.join(repoRoot, ...relativePath.split("/")), "utf8") };
}

const cortenBypassProbeSource = `
use crate::help::{Article, Block, Inline};

// A second renderer that flattens the blocks and draws an unresolved value
// without either degraded-state marker.
pub fn fee_digest(article: &Article) -> String {
    let mut out = String::new();
    for block in &article.blocks {
        if let Block::Paragraph { content } = block {
            for inline in content {
                if let Inline::PolicyValue { key } = inline {
                    out.push_str(key);
                }
            }
        }
    }
    out
}
`;

const feeDigestProbeSource = `
import type { HelpArticle } from "../../features/help/domain/article-model";

// Deliberately different syntax from the canonical renderer: no marker
// attribute literals, no unavailable copy, and never even switches on the
// unresolved-value discriminant string — it just flattens whatever the
// article's block content is and stringifies it.
export function renderFeeDigest(article: HelpArticle) {
  return article.blocks
    .flatMap((block) => (block.type === "list" ? block.items.flat() : [block.content]))
    .flat()
    .map((inline) => ("value" in inline ? inline.value : inline.key));
}
`;

const bracketAccessProbeSource = `
import type { HelpArticle } from "../../features/help/domain/article-model";

export function renderFeeDigest(article: HelpArticle) {
  return article["blocks"];
}
`;

const destructureProbeSource = `
import type { HelpArticle } from "../../features/help/domain/article-model";

export function renderFeeDigest({ blocks }: HelpArticle) {
  return blocks;
}
`;

const typeImportProbeSource = `
import type { HelpArticleBlock } from "../../features/help/domain/article-model";

export function renderFeeDigest(blocks: readonly HelpArticleBlock[]) {
  return blocks.length;
}
`;

const literalProbeSource = `
export function isUnresolved(inlineType: string) {
  return inlineType === "policy-value-unavailable";
}
`;

const crossContextProbeSource = `
import { resolvePublicPolicyArticle, findPublicHelpArticleByPath } from "@chase-sets/public-presence/server";

export async function loader(request: Request) {
  const source = findPublicHelpArticleByPath("/press");
  const article = await resolvePublicPolicyArticle(request, source, "/press");
  return article.blocks;
}
`;

const sanctionedSeamSource = `
import { PublicHelpArticlePage } from "@chase-sets/public-presence/web";
import { findPublicHelpArticleByPath, resolvePublicPolicyArticle } from "@chase-sets/public-presence/server";

export async function loader(request: Request) {
  const source = findPublicHelpArticleByPath("/sales-fees");
  const article = await resolvePublicPolicyArticle(request, source, "/sales-fees");
  return { article };
}

export default function Route({ article }) {
  return <PublicHelpArticlePage article={article} related={[]} />;
}
`;

describe("policy-value discriminant chokepoint guard", () => {
  it("scans the real repository clean, deriving the corpus from Git-tracked files rather than known route roots", async () => {
    const result = await validatePolicyValueDiscriminantChokepoint({ repoRoot });

    expect(result.violations).toEqual([]);
    expect(result.guardedFiles).toEqual(
      expect.arrayContaining([
        resolveArticlePolicyValuesPath,
        articleModelPath,
        policyValueStatePath,
        articleCatalogPath,
      ]),
    );
    expect(result.cortenGuardedFiles).toEqual(expect.arrayContaining([CORTEN_POLICY_VALUE_RENDERER, cortenHelpPath]));
    // Proves an arbitrary tracked production path far outside public-presence
    // is in scope, not only the public-presence/help route roots.
    expect(result.guardedFiles.some((file) => file.startsWith("bounded-contexts/catalog/"))).toBe(true);
    expect(result.guardedFiles.some((file) => file.startsWith("infrastructure/"))).toBe(true);
  });

  it("derives its candidate list from git ls-files, not a directory walk", () => {
    const candidates = listPolicyValueDiscriminantGuardCandidates(repoRoot);
    expect(candidates).toContain(resolveArticlePolicyValuesPath);
    expect(candidates).toContain(articleCatalogPath);
    const cortenCandidates = listCortenPolicyValueGuardCandidates(repoRoot);
    expect(cortenCandidates).toContain(CORTEN_POLICY_VALUE_RENDERER);
    expect(cortenCandidates).not.toContain("deployables/corten-pilot/public/src/tests.rs");
  });

  it("keeps the Corten canonical renderer and its model clean, emitting both degraded-state markers", () => {
    const records = cortenPolicyValueRendererAllowlist.map((entry) => cortenRecord(entry.file));
    const renderer = records.find((record) => record.relativePath === CORTEN_POLICY_VALUE_RENDERER);

    expect(findCortenPolicyValueRendererViolations(records).violations).toEqual([]);
    for (const marker of cortenPolicyValueRendererMarkers) {
      expect(renderer.source).toContain(marker);
    }
  });

  it("flags a Corten module outside the allowlist that reads article blocks and PolicyValue inlines", () => {
    const probePath = "deployables/corten-pilot/public/src/fee_digest.rs";
    const records = [
      ...cortenPolicyValueRendererAllowlist.map((entry) => cortenRecord(entry.file)),
      { relativePath: probePath, source: cortenBypassProbeSource },
    ];
    const result = findCortenPolicyValueRendererViolations(records);

    expect(result.violations).toEqual([
      expect.stringContaining(`${probePath}:11: matches Inline::PolicyValue`),
      expect.stringContaining(`${probePath}:8: reads an article's .blocks`),
    ]);
  });

  it("flags the Corten canonical renderer when it stops emitting either marker", () => {
    for (const marker of cortenPolicyValueRendererMarkers) {
      const records = cortenPolicyValueRendererAllowlist.map((entry) => cortenRecord(entry.file));
      const renderer = records.find((record) => record.relativePath === CORTEN_POLICY_VALUE_RENDERER);
      renderer.source = renderer.source.replaceAll(marker, "data-removed=");
      const result = findCortenPolicyValueRendererViolations(records);

      expect(result.violations).toEqual([expect.stringContaining(`no longer emits ${marker}`)]);
    }
  });

  it("fails closed when an allowlisted Corten module is missing", () => {
    const result = findCortenPolicyValueRendererViolations([cortenRecord(cortenHelpPath)]);

    expect(result.violations).toEqual([
      expect.stringContaining(`${CORTEN_POLICY_VALUE_RENDERER}: allowlisted Corten policy-value module is not tracked`),
    ]);
  });

  it("ignores Corten test modules and method calls named blocks", () => {
    const result = findCortenPolicyValueRendererViolations([
      ...cortenPolicyValueRendererAllowlist.map((entry) => cortenRecord(entry.file)),
      { relativePath: "deployables/corten-pilot/public/src/tests.rs", source: "for block in &article.blocks {}" },
      {
        relativePath: "deployables/corten-pilot/marketplace/src/listing_recovery.rs",
        source: "assert!(conflict.blocks());",
      },
    ]);

    expect(result.violations).toEqual([]);
    expect(result.guardedFiles).not.toContain("deployables/corten-pilot/public/src/tests.rs");
  });

  it("flags a sibling renderer that reads article.blocks directly, using none of the canonical tokens or copy", () => {
    const probePath = "bounded-contexts/public-presence/routes/marketplace/fee-digest-probe.tsx";
    const result = findPolicyValueDiscriminantViolations([{ relativePath: probePath, source: feeDigestProbeSource }]);

    expect(result.violations).toEqual([expect.stringContaining(`${probePath}:`)]);
    expect(result.violations[0]).toContain(".blocks");
    expect(feeDigestProbeSource).not.toContain("CompiledArticleBody");
    expect(feeDigestProbeSource).not.toContain("InlineContent");
    expect(feeDigestProbeSource).not.toContain("data-policy-value");
    expect(feeDigestProbeSource).not.toContain("policy-value-unavailable");
  });

  it("flags bracket-notation access to blocks", () => {
    const probePath = "bounded-contexts/public-presence/routes/marketplace/bracket-probe.tsx";
    const result = findPolicyValueDiscriminantViolations([
      { relativePath: probePath, source: bracketAccessProbeSource },
    ]);

    expect(result.violations).toEqual([expect.stringContaining(`${probePath}:`)]);
  });

  it("flags destructured access to blocks", () => {
    const probePath = "bounded-contexts/public-presence/routes/marketplace/destructure-probe.tsx";
    const result = findPolicyValueDiscriminantViolations([{ relativePath: probePath, source: destructureProbeSource }]);

    expect(result.violations).toEqual([expect.stringContaining(`${probePath}:`)]);
  });

  it("flags a production module that imports the HelpArticleBlock type without ever touching .blocks by name", () => {
    const probePath = "bounded-contexts/public-presence/routes/marketplace/type-import-probe.tsx";
    const result = findPolicyValueDiscriminantViolations([{ relativePath: probePath, source: typeImportProbeSource }]);

    expect(result.violations).toEqual([expect.stringContaining(`${probePath}:`)]);
    expect(result.violations[0]).toContain("HelpArticleBlock");
  });

  it("flags a bare comparison against the policy-value-unavailable literal", () => {
    const probePath = "bounded-contexts/public-presence/routes/marketplace/literal-probe.ts";
    const result = findPolicyValueDiscriminantViolations([{ relativePath: probePath, source: literalProbeSource }]);

    expect(result.violations).toEqual([expect.stringContaining(`${probePath}:`)]);
  });

  it("flags a cross-context consumer that resolves through the sanctioned /server seam but then reads .blocks itself", () => {
    const probePath = "bounded-contexts/commercial-terms/routes/public/fee-digest-cross-context-probe.tsx";
    const result = findPolicyValueDiscriminantViolations([
      { relativePath: probePath, source: crossContextProbeSource },
    ]);

    expect(result.violations).toEqual([expect.stringContaining(`${probePath}:`)]);
  });

  it("does not flag a cross-context consumer that resolves through /server and renders only through the sanctioned /web seam", () => {
    const probePath = "bounded-contexts/commercial-terms/routes/public/sanctioned-seam-probe.tsx";
    const result = findPolicyValueDiscriminantViolations([{ relativePath: probePath, source: sanctionedSeamSource }]);

    expect(result.violations).toEqual([]);
    expect(result.guardedFiles).toEqual([probePath]);
  });

  it("does not flag the canonical allowlisted files even though they contain every signal", async () => {
    const sources = await readPolicyValueDiscriminantGuardSources({ repoRoot });
    const canonicalFiles = new Set(canonicalPolicyValueDiscriminantAllowlist.map((entry) => entry.file));
    const canonicalRecords = sources.filter((record) => canonicalFiles.has(record.relativePath));

    expect(canonicalRecords).toHaveLength(canonicalPolicyValueDiscriminantAllowlist.length);
    expect(findPolicyValueDiscriminantViolations(canonicalRecords).violations).toEqual([]);
  });

  it("fails closed when a tracked production file cannot be read", () => {
    const probePath = "bounded-contexts/public-presence/routes/marketplace/unreadable-probe.tsx";
    const result = findPolicyValueDiscriminantViolations([
      { relativePath: probePath, readError: "simulated permission failure" },
    ]);

    expect(result.violations).toEqual([expect.stringContaining(`${probePath}: simulated permission failure`)]);
  });

  it("ignores test files even when they exercise the discriminant through the real loader", () => {
    const testPath = "bounded-contexts/public-presence/tests/help-route.test.tsx";
    const result = findPolicyValueDiscriminantViolations([
      {
        relativePath: testPath,
        source: 'expect(x).toContain(\'"type":"policy-value-unavailable"\'); const { blocks } = article;',
      },
    ]);

    expect(result.guardedFiles).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("justifies every canonical allowlist entry with a non-empty reason", () => {
    for (const entry of canonicalPolicyValueDiscriminantAllowlist) {
      expect(typeof entry.reason).toBe("string");
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});
