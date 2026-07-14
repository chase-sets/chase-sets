# Developer article contract

Public Presence owns a developer-only article corpus under `features/developer-portal/domain/articles`. Sources reuse the strict Help Article frontmatter and Markdown model, but the compiler requires `audience: developer`, assigns `/developers/<slug>` paths, validates links within that route family, and writes a distinct typed manifest under `features/developer-portal/domain/generated`.

Run `pnpm --filter @chase-sets/public-presence run compile:developer-articles` after editing a Developer Article or an MCP descriptor. The matching check command compares the committed article manifest and MCP catalog with fresh compiler output and fails on drift. Generated files are never edited by hand.

## MCP catalog

The compiler imports the canonical platform-runtime MCP registry and emits every tool's description, availability, service, risk, permission boundary, guardrails, input and output schemas, and expected usage. Available and planned tools remain explicit and separately rendered. Changing a descriptor changes the generated output, so the drift check prevents documentation from silently diverging from the runtime contract.

## Agent-readable surfaces

When the portal readiness gate is enabled, `/developers/manifest.json` serves article metadata, supported MCP protocol versions, the MCP endpoint, and the generated tool catalog. `/llms.txt` serves a compact text index that links to the portal, its articles, and the JSON manifest.

The `CHASE_SETS_M86_DEVELOPER_PORTAL_READY` flag defaults to false in deployment configuration. Every HTML route emits `noindex,nofollow`; text and JSON responses emit the equivalent `X-Robots-Tag`; no developer path is added to a sitemap. Enabling indexing is intentionally outside this contract and requires a separate change after certification.

## Copy-policy boundary

The developer corpus may use accurate UCP, agent-commerce, and planned-capability language while gated. Consumer launch-copy guards continue to evaluate consumer translations and `publicHelpArticles` only. The compilers enforce the audience split so a developer article cannot enter the consumer corpus and a buyer or seller article cannot enter the developer corpus.
