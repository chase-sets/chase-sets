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
- Internal showcase: `deployables/design-system-showcase/`
- Styling system: Tailwind CSS v4
- Primitive behavior layer: Radix UI
- Theme model: one Chase Sets brand theme with semantic tokens and CSS variable overrides

## Composition Rules

- `ChaseRoot` must wrap every application root.
- Application entrypoints must import `@chase-sets/design-system/styles.css` exactly once.
- Layout should be built from primitives such as `Page`, `Grid`, `Stack`, `SplitPane`, `Surface`, and shell components.
- Form screens should use `Field`, `FormSection`, and field controls rather than direct inputs.
- Overlays should use `Dialog`, `Drawer`, `Popover`, `Tooltip`, `Menu`, and `AlertDialog`.
- Data-heavy admin screens should use `DataTable`, `DetailPanel`, `FilterBar`, `BulkActionBar`, and `MetricStrip`.
- `DetailPanel` applies default vertical spacing between direct child content blocks.

## Responsive Defaults

- Mobile-first behavior is the default for every component.
- Layout and shell primitives span the viewport by default and preserve responsive horizontal gutters.
- Width-capped layouts are opt-in through optional `width` props on layout and shell wrappers.
- Marketplace navigation uses bottom navigation on smaller screens.
- Admin navigation uses bottom navigation on smaller screens and persistent side navigation at larger breakpoints.
- `DataTable` defaults to stacked cards on mobile.

## Boundaries

The design system owns:

- tokens
- layout primitives
- styling
- interaction primitives
- app shells
- reusable marketplace/admin patterns

The design system does not own:

- business workflows
- API clients
- state management
- data fetching
- domain rules

## Validation

Use the showcase application as the default visual validation surface and `npm run test:design-system` for component-level regression checks.
