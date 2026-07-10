# Design System Verification Commands

This is the durable command reference for checking the design-system package and its consumer contracts. Shipped-milestone evidence belongs in the closing GitHub issue or pull request, not in this repository file.

## Form-system and consumer checks

Run the focused design-system tests and repository guardrails when changing form primitives, adapters, or migrated consumers:

```powershell
pnpm --filter @chase-sets/design-system run test -- src/__tests__/form-system.test.tsx src/__tests__/design-system-components.test.tsx src/__tests__/design-system-marketplace.test.tsx src/__tests__/design-system-panels-navigation.test.tsx
pnpm --filter @chase-sets/design-system run typecheck
pnpm run check:no-legacy-forms
pnpm run check:no-any
pnpm run test:no-legacy-forms
pnpm run format:check
pnpm run test:form-migration-smoke
pnpm run verify:static
pnpm run verify:typecheck
```

The form contract requires production code to use the exported `Form` primitive or an approved adapter, with native field names, hidden fields, multipart uploads, GET filters, destructive actions, and external submit controls preserved.

## Legacy-pattern inventory and retained evidence

Regenerate and validate the generated legacy-pattern inventory when changing design-system source layout, compatibility adapters, raw controls, or retained representative evidence:

```powershell
pnpm run ops design-system:legacy-inventory --write-ledger
pnpm run test:design-system-legacy-inventory
pnpm run ops design-system:legacy-evidence --write
pnpm run test:design-system-legacy-evidence
pnpm run check:design-system-legacy-evidence
```

The generated outputs are:

- `packages/design-system/DESIGN_SYSTEM_LEGACY_INVENTORY.json`
- `packages/design-system/DESIGN_SYSTEM_LEGACY_VISUAL_ACCESSIBILITY_EVIDENCE.json`

Keep those files generator-owned and run their checks after regeneration. Do not add milestone signoff tables, historical closeout narratives, or one-time evidence ledgers to this command reference.
