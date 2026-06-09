# Chase Sets Design System

## Purpose

The Chase Sets design system is the canonical UI layer for all React web applications in this repository family.

Marketplace and admin applications should compose screens from exported design-system components only.

Application code should not introduce:

- raw layout HTML outside the app mount root
- app-owned CSS files
- one-off utility classes

## Foundations

- React component package: `packages/design-system/`
- Styling system: Tailwind CSS v4
- Primitive behavior layer: Base UI Shadcn-compatible primitives
- Theme model: Chase Sets marketplace theme with light, dark, and system semantic tokens
- Typography: IBM Plex Sans with tabular numerals for price, rating, quantity, fee, and total displays
- Motion runtime: Motion for React, configured centrally through `ChaseRoot`

## Composition Rules

- `ChaseRoot` must wrap every application root.
- Application entrypoints must import `@chase-sets/design-system/styles.css` exactly once.
- `ChaseRoot` owns reduced-motion policy through `reducedMotion="user" | "always" | "never"` and all component motion should flow through that root contract.
- Layout should be built from primitives such as `Page`, `Grid`, `Stack`, `SplitPane`, `Surface`, and shell components.
- Do not nest cards or elevated surfaces. One nested child level is allowed only through `Inset`, which renders as a recessed cutout for metrics, fields, tables, and grouped controls. `Inset` must not contain another `Inset`, `Card`, `Surface`, or `DetailPanel`.
- Read-only detail rows inside a card-like parent must stay visually flat. Use `KeyValueList`'s default plain rows or unframed row dividers; do not wrap static key/value rows in another rounded bordered frame that reads like a nested card.
- Form screens should use `Field`, `FormSection`, and field controls rather than direct inputs.
- Panel interactions must use the canonical pattern taxonomy from [Panel Interaction Patterns](./PANEL_INTERACTIONS.md): `NavigationDrawer`, `Sidebar`, `SideSheet`, `BottomSheet`, `ModalDialog`, `Popover`/`Menu`, and `FullPage`. The package does not expose generic drawer or legacy dropdown aliases.
- Overlays should use design-system Dialog, Sheet, Popover, Tooltip, Menu, and AlertDialog primitives instead of route-local overlay CSS.
- Advanced, optional, risky, or low-frequency choices should use `ProgressiveDisclosure` or `ProgressiveDisclosureGroup` rather than app-local show/hide controls.
- Optional structured reference detail should use `ReferenceInfoTrigger` and `ReferenceInfoDialog`: linked text with a trailing `info` icon opening a focused reference-detail dialog/sheet. Do not use Tooltip, raw Popover, or local Dialog clones for reference-data facts, marketplace terms, payout calculations, matching rules, registration timing, stale-state recovery, or policy context.
- Data-heavy admin screens should use `DataTable`, `DetailPanel`, `FilterBar`, `BulkActionSurface`, `BulkActionBar`, `BulkActionPanel`, and `MetricStrip`.
- Dense admin areas with one primary workflow and supporting detours should use [Section Navigation](./SECTION_NAVIGATION.md) for desktop left-side menu groups and the approved grouped mobile selector.
- Dense admin rebuilds should use [Dense Admin Workbench Pattern](./DENSE_ADMIN_WORKBENCH.md) and its `DenseAdminWorkbenchProof` artifact to validate grouped navigation, dense tables, selected-record commands, contextual evidence sheets, and blocked/denied/degraded states before app adoption.
- Each list action slot should wrap bulk actions in one `BulkActionSurface` and render at most one `BulkActionBar`. Combine selected-scope and matching-scope work into that one bar instead of stacking bottom action bars.
- `BulkActionBar` should keep the selected-count fact visible, place the most likely safe action or configuration trigger in `primaryActions`, place supporting actions such as clearing selection in `secondaryActions`, and move advanced, rare, risky, or large action sets into `BulkActionPanel` or `overflowActions`.
- `DetailPanel` applies default vertical spacing between direct child content blocks.

## Forms

Production forms must use the exported `Form` primitive or an approved design-system adapter. Application code must not render lowercase JSX/HTML `<form>` directly, and route modules must not import framework `Form` directly outside an approved adapter boundary. The complete primitive acceptance checklist lives in [Form Acceptance Matrix](./FORM_TEST_MATRIX.md), and the milestone traceability artifact lives in [Form System Milestone 10 Audit](./FORM_SYSTEM_AUDIT.md).

Use `Form` for native-post, GET filter, multipart upload, destructive action, sign-out, checkout, and external-submit flows:

```tsx
import { Button, Form, TextInput } from "@chase-sets/design-system";

export function ListingForm() {
  return (
    <Form id="listing-form" action="/account/listings" method="post" encType="multipart/form-data">
      <TextInput label="Listing name" name="listing_name" required />
      <input type="hidden" name="intent" value="publish" />
      <Button type="submit">Publish listing</Button>
    </Form>
  );
}
```

The primitive preserves native form behavior for `id`, `method`, `action`, `encType`, `target`, `ref`, hidden fields, external controls using the `form` attribute, `FormData`, and browser submission. Use `disabled`, `submitting`, `status`, and `validationSummaryId` to expose form-level state consistently while field adapters and higher-level patterns adopt the shared context.

Use `ValidationSummary`, `useFormState`, and `normalizeFormErrors` for controlled client forms that need dirty/touched state, validation timing, server error mapping, status text, counters, and form-level messages:

```tsx
import { Button, Form, TextInput, ValidationSummary, useFormState } from "@chase-sets/design-system";

export function ContactForm() {
  const form = useFormState(
    { email: "", name: "" },
    {
      validate: (values) => ({
        email: values.email.includes("@") ? undefined : "Enter a valid email.",
        _form: values.name.trim() ? undefined : "Add a contact name.",
      }),
    },
  );

  return (
    <Form
      id="contact-form"
      validationSummaryId="contact-errors"
      onSubmit={(event) => {
        event.preventDefault();
        form.submitAttempted();
      }}
    >
      <ValidationSummary
        id="contact-errors"
        errors={[
          ...Object.entries(form.errors.fieldErrors).flatMap(([fieldId, messages]) =>
            (messages ?? []).map((message) => ({ fieldId, fieldName: fieldId, message })),
          ),
          ...form.errors.formErrors.map((message) => ({ message })),
        ]}
      />
      <TextInput id="email" label="Email" description="Used for receipts." {...form.fieldProps("email")} />
      <TextInput id="name" label="Name" counter={`${form.values.name.length} characters`} {...form.fieldProps("name")} />
      <Button type="submit">Save</Button>
    </Form>
  );
}
```

Field controls should keep helper text visible when errors are present. Controls that expose `description`, `error`, `status`, or `counter` compose those IDs into `aria-describedby` in that order so validation summaries, async status, and character counts remain predictable.

`useFormState` supports synchronous validation through `validate()`/`submitAttempted()` and asynchronous validation through `validateAsync()`/`submitAttemptedAsync()`. Async validation exposes `validating`, suppresses stale results after field edits or reset, maps rejected validators into form-level errors, and clears stale field/form errors when the user edits. Use `reset()` after successful saves to clear dirty/touched/submitted metadata, and use `setSubmitting()` to coordinate long-running save state with `Form submitting`.

`ValidationSummary` links focus the invalid field target. If the target is a grouped control such as a fieldset, focus delegates to the first focusable control inside the group.

For React Router route actions, import `RouterForm` from `@chase-sets/design-system/react-router` instead of importing `Form` from `react-router` directly:

```tsx
import { RouterForm } from "@chase-sets/design-system/react-router";

export function CheckoutActionForm() {
  return <RouterForm method="post" action="/checkout/start" />;
}
```

The router adapter is a separate optional subpath so the core design-system entrypoint stays framework-neutral. `pnpm run check:no-legacy-forms` runs the final blocking guardrail: production code may not render lowercase `<form>` directly or import/use framework `Form` directly outside the approved design-system adapter. The historical migration baseline lives in `scripts/no-legacy-forms.baseline.json` and should remain empty.

Migration cleanup checklist:

- Replace production lowercase `<form>` with `Form` and direct `react-router` `Form` imports with `RouterForm`.
- Preserve `method`, `action`, `encType`, `target`, refs, hidden fields, external submit controls, and submitted field names.
- Remove obsolete route-local wrappers, duplicated parsing helpers, temporary compatibility shims, and baseline entries.
- Run `pnpm run check:no-legacy-forms` before completion; final mode must pass with an empty baseline.

## Progressive Disclosure

Progressive disclosure is the package-wide default for advanced use cases. Keep required decision facts and the current primary action visible, then disclose supporting controls or deeper explanation through the exported disclosure primitives.

Use [Progressive Disclosure](./PROGRESSIVE_DISCLOSURE.md) for the full component contract, accessibility rules, and first-flow recommendations.

## Checkout Primitives

Use [Checkout Primitives](./CHECKOUT_PRIMITIVES.md) for Shopify-simple buy and sell checkout shells, summaries, sticky actions, saved-info rows, readiness prompts, recovery states, and confirmation panels. Checkout business rules remain in the Checkout bounded context; the design-system primitives should receive only customer-safe facts.

## Panel Interactions

Use [Panel Interaction Patterns](./PANEL_INTERACTIONS.md) to choose between navigation drawers, persistent sidebars, side sheets, bottom sheets, modal dialogs, popovers/menus, and full-page flows across desktop, tablet, mobile, and small mobile breakpoints.

The core rule is:

- Navigation helps users go somewhere.
- Sheets help users inspect, configure, or act while staying in context.
- Modal dialogs block until a decision is made.
- Popovers and menus are brief, lightweight, and anchored.
- Full pages are for complex, long, sequential, or focus-heavy tasks.

## Operational Workflows

Use [Operational Workflow Patterns](./OPERATIONAL_WORKFLOWS.md) for task-focused account workstations such as shipment packing. These patterns cover `WorkstationLayout`, task progress, scan-first inputs, quantity-aware line items, operational locks, sticky task footers, and copyable references. Operational banners explain workflow control and must stay separate from marketplace trust or conversion banners.

Use [Dense Admin Workbench Pattern](./DENSE_ADMIN_WORKBENCH.md) for rebuilt admin control planes where a primary operational path needs supporting detours, dense review queues, selected-record actions, evidence side sheets, and fail-closed blocker states.

## Responsive Defaults

- Mobile-first behavior is the default for every component.
- Layout and shell primitives span the viewport by default and preserve responsive horizontal gutters.
- Width-capped layouts are opt-in through optional `width` props on layout and shell wrappers.
- Marketplace navigation uses bottom navigation on smaller screens.
- Admin navigation uses bottom navigation on smaller screens and persistent side navigation at larger breakpoints.
- `DataTable` defaults to stacked cards on mobile.

## Marketplace Direction

Marketplace-specific conversion rules, signal hierarchy, component coverage, and roadmap live in [Marketplace Design System Direction](./MARKETPLACE_SYSTEM.md). Keep this README focused on package-wide design-system contracts.

## Marketing Expression

Marketing pages use the same design system as the applications. They may use design-system-owned marketing patterns such as image heroes, proof bands, product previews, pricing/economics callouts, comparison blocks, and signup modules, but they must not introduce a separate flashy visual system or page-local styling overrides.

Marketing expression should make the first viewport persuasive through real product, economics, or trust signals while keeping typography, color tokens, spacing, motion, forms, and accessibility inside the canonical component contracts.

## Boundaries

The design system owns:

- tokens
- layout primitives
- styling
- interaction primitives
- app shells
- reusable marketplace/admin patterns
- shared motion primitives and transition presets

The design system does not own:

- business workflows
- API clients
- state management
- data fetching
- domain rules

## Validation

Use the real marketplace and admin applications as the default visual validation surfaces, and use `npm run test:design-system` for component-level regression checks.

Use `packages/design-system/src/` as the canonical component inventory. Avoid maintaining hand-written component lists that can drift from exports.

## Motion

- Use `Reveal`, `Stagger`, and `ViewTransition` for consumer-authored motion.
- Do not import `motion/react` directly from applications.
- Keep motion additive and restrained: emphasize route changes, overlays, navigation state, cards, and workflow transitions rather than ambient animation.
- All motion must degrade cleanly under reduced-motion mode.
