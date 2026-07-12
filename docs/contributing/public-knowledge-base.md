# Public Knowledge Base Change Convention

User-facing route and UI changes must declare their public Help Article impact in the pull request or owning issue body with one line:

```text
KB: /help/buying/order-protection
```

Use `KB: #4355` when the article is tracked but intentionally ships in a separate issue, or `KB: n/a` when the change cannot alter public guidance. A bare omission is not a decision.

`pnpm run check:kb-reference-ratchet` detects changed bounded-context feature UI and public/marketplace routes. It is intentionally warning-only for launch: missing declarations are visible in `verify:static` but do not fail the build. After launch, change the configured `KB_REFERENCE_RATCHET_MODE` to `block` in CI only after the warning backlog is empty; block mode exists and is fixture-tested but is not enabled by this slice.

Help Article frontmatter remains the source of truth for claim evidence, cited policies, and `reviewedAt`. Run `pnpm --filter @chase-sets/public-presence run compile:help-articles` after article changes.
