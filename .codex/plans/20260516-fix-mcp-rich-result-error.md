# Fix MCP Rich Result Error

## Intent

Restore ChatGPT connector marketplace searches after the rich-content merge caused UCP MCP catalog tools to fail with `ExceptionGroup: unhandled errors in a TaskGroup`.

## Worktree

- Path: `.codex/worktrees/20260516-fix-mcp-rich-result-error`
- Branch: `codex/fix-mcp-rich-result-error`
- Base: `origin/main` at `8aeb49d2 Add rich marketplace MCP results (#148)`
- Setup blockers: none known

## Evidence

- Discovery owns Search Result, Result Set, buyer-visible item detail, and projected marketplace availability for browse/search.
- Marketplace owns Listing and Offer facts, but not catalog search presentation.
- `contracts/ucp` owns protocol constants, tool descriptors, and UCP MCP resource declarations.
- `infrastructure/platform-runtime/ucp.ts` owns UCP MCP JSON-RPC transport envelopes and ChatGPT-facing tool/resource result packaging.
- The rich-content merge added `structuredContent`, UI resource metadata, and a second tool result content item with `type: "json"`.
- MCP tool result content blocks are strict client-facing protocol data. Machine-readable objects should remain in `structuredContent`; `content` should carry supported conversational content such as text.

## Working Diagnosis

The failing connector is likely rejecting the non-standard `content` block:

```json
{ "type": "json", "json": { "...": "..." } }
```

Because the bridge reports the error as an async `ExceptionGroup`, the application endpoint may still return HTTP 200 while the client-side MCP parser fails while consuming tool results. The fix should keep the rich marketplace payload in `structuredContent` and `_meta`, while returning only supported text content blocks from UCP MCP tools.

## Plan

- Remove UCP MCP `type: "json"` content blocks from tool results.
- Keep `structuredContent` unchanged so marketplace products, prices, availability, images, and action hints remain available to clients and the UI component.
- Keep `_meta.ui.resourceUri` and `_meta["openai/outputTemplate"]` unchanged for rich component rendering.
- Add a focused regression assertion that UCP MCP catalog tool calls return only supported text content while preserving `structuredContent`.
- Update platform API UCP MCP mounting coverage if it encodes the previous content shape.

## Validation

- [x] Run focused UCP MCP runtime tests.
- [x] Run Discovery UCP catalog tests if handler shape is touched.
- [x] Run platform API tests covering UCP MCP mounting.
- [x] Run structure/typecheck checks that are practical for the touched packages.
- [x] Run `git diff --check`.

## Outcome

UCP MCP tool results now keep machine-readable marketplace envelopes in `structuredContent` and return only a supported text content block in `content`. UI resource metadata remains attached for ChatGPT Apps rendering through `_meta.ui.resourceUri` and `_meta["openai/outputTemplate"]`.

## Goal Completion Criteria

- ChatGPT-facing UCP MCP search results no longer include unsupported JSON content blocks.
- Rich structured marketplace data and UI resource metadata remain present.
- Focused tests pass and the branch is ready for review/merge.
