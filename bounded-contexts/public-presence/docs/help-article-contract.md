# Help article contract

Public Presence owns the consumer help corpus under `features/help/domain/articles`. Each article is a locale-suffixed Markdown file named `<slug>.<locale>.md`; English is the first supported corpus and uses `.en.md`. This corpus accepts only buyer and seller audiences and is the sole input to `publicHelpArticles`.

Developer content is intentionally separate under `features/developer-portal/domain/articles`; see [Developer article contract](./developer-article-contract.md). UCP, agent-commerce, and planned-language exemptions apply only to that gated corpus and never weaken consumer help guards.

The build compiler validates every source and generates `features/help/domain/generated/articles.ts`. Public routes import that typed manifest, so request handling never reads or parses Markdown. Run `pnpm --filter @chase-sets/public-presence run compile:help-articles` after editing an article. Public Presence tests fail when the committed manifest is stale, while public-web's production build compiles the corpus before bundling and fails on invalid source.

## Frontmatter

Every article requires:

- `slug`: stable kebab-case URL segment.
- `title`: locale-specific article title.
- `description`: locale-specific summary for cards and metadata.
- `audience`: `buyer`, `seller`, or `developer`.
- `category`: `getting-started`, `buying`, or `selling`.
- `reviewedAt`: ISO calendar date for the last truth review.
- `citedPolicies`: policy keys consumed by the later freshness slice; use `[]` when none are cited.
- `relatedFlows`: flow types consumed by the later deflection slice; use `[]` when none apply.
- `claimCategories`: any public claim families the article covers: `protection`, `fees`, `payouts`, or `shipping`. Claim-bearing articles must have at least one promise entry.
- `promiseTable`: behavioral claims with at least one issue or test reference each.

Example:

```yaml
---
slug: example
title: Example
description: What this article explains.
audience: buyer
category: buying
reviewedAt: "2026-07-12"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: The public route renders the compiled article.
    issues: ["#4352"]
    tests: ["bounded-contexts/public-presence/features/help/ui/help-pages.test.tsx"]
---
```

## Supported Markdown

Article bodies intentionally use a small, safe subset: paragraphs, level-two and level-three headings, unordered or ordered lists, emphasis, strong text, inline code, and links. Raw HTML and level-one headings are rejected. The compiler assigns deterministic heading ids for table-of-contents links.

Root-relative `/help` links must resolve to the hub, a compiled category, or a compiled article. Article-local hash links must resolve to a compiled heading. Relative links are rejected; use a root-relative internal URL, `https://`, or `mailto:` instead.

## Localization decision

Long-form prose stays out of the string catalog. A translated article is a complete peer source such as `example.es.md`, which lets translators revise coherent prose and preserves per-locale review metadata. The localization catalog remains canonical for shared help chrome: audience labels, category labels, navigation, empty/not-found copy, and review labels.

Search is deliberately deferred. The typed manifest and stable article URLs are the seam for a later search index, including the planned semantic-search infrastructure.

## Live policy values

Articles may use `{{policy:<public-value-key>}}` tokens. The compiler accepts only keys in `public-policy-value-whitelist.mjs`; that file is reviewed like a public-data permission and maps every token to one exact policy field or derivation. Adding a policy or field does not expose it automatically.

The article loader resolves tokens from `GET /api/public-presence/policy-values`. Missing and non-whitelisted values fail compilation, tests, or rendering instead of producing blank copy. Supported types format basis points as percentages, money with its currency, and day, hour, and minute counts with units.

The public policy endpoint is not cached; article pages use a five-minute shared-cache lifetime with one minute of stale-while-revalidate. A projected policy revision is therefore visible publicly within six minutes in the worst stale-response case and normally within five. Scheduled active revisions inside the runtime's configurable callout window (30 days by default) render a "Changing on {date}" callout.
