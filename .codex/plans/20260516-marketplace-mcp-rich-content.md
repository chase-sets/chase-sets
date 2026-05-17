# Marketplace MCP Rich Content

## Intent

Return richer ChatGPT connector content from the marketplace UCP MCP surface so catalog search and product lookup can render structured marketplace results and advertise an MCP Apps UI template instead of leaving ChatGPT to summarize JSON as plain text.

## Worktree

- Path: `.codex/worktrees/20260516-marketplace-mcp-rich-content`
- Branch: `codex/marketplace-mcp-rich-content`
- Sandbox id: `90070045`
- Dependency setup status: complete (`pnpm run deps:install`; `pnpm run sandbox:doctor`)
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Discovery owns Search Result, Result Set, filters, buyer-visible item detail, and projected market signals.
- Marketplace owns Listing and Offer facts before an order exists, but does not own browse/search presentation.
- `contracts/ucp` owns UCP tool metadata and protocol constants.
- `infrastructure/platform-runtime/ucp.ts` owns UCP MCP transport envelopes and ChatGPT-facing component/resource plumbing.

## Resolved Decisions

- Add rich MCP result shape at the UCP MCP transport boundary using `structuredContent`, concise `content`, and `_meta`.
- Advertise a reusable marketplace search-result UI template from UCP MCP tool descriptors with `_meta.ui.resourceUri` and the OpenAI compatibility alias `_meta["openai/outputTemplate"]`.
- Keep result payload enrichment in Discovery UCP support because it maps Discovery-owned Search Results and item-detail projections to UCP products.
- Do not move Listing availability rules into the MCP runtime; use Discovery's existing `market_summary` and item-detail listing projections.

## Implementation Checklist

- [x] Add UCP MCP UI resource constants and contract tests.
- [x] Teach `/ucp/mcp` to list/read the registered HTML template resource and advertise it on catalog tools.
- [x] Wrap UCP MCP handler results as rich tool results while preserving JSON content compatibility.
- [x] Enrich Discovery UCP products with marketplace cards, availability copy, price display data, image selection, and action hints in `extensions.chase_sets`.
- [x] Update focused tests for Discovery UCP mapping, UCP MCP runtime behavior, and platform API mounting.

## Documentation To Promote

- None expected unless the MCP Apps component contract becomes a public integration guarantee beyond UCP runtime tests.

## Goal Completion Criteria

- Focused UCP, Discovery UCP, and platform API tests pass.
- Typecheck passes for touched packages or a narrower package-level typecheck is reported with any blocker.
- Plan file remains with the implementation branch.
