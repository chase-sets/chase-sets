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
- Form screens should use `Field`, `FormSection`, and field controls rather than direct inputs.
- Panel interactions must use the canonical pattern taxonomy from [Panel Interaction Patterns](./PANEL_INTERACTIONS.md): `NavigationDrawer`, `Sidebar`, `SideSheet`, `BottomSheet`, `ModalDialog`, `Popover`/`Menu`, and `FullPage`. The package does not expose generic drawer or legacy dropdown aliases.
- Overlays should use design-system Dialog, Sheet, Popover, Tooltip, Menu, and AlertDialog primitives instead of route-local overlay CSS.
- Advanced, optional, risky, or low-frequency choices should use `ProgressiveDisclosure` or `ProgressiveDisclosureGroup` rather than app-local show/hide controls.
- Data-heavy admin screens should use `DataTable`, `DetailPanel`, `FilterBar`, `BulkActionBar`, and `MetricStrip`.
- `BulkActionBar` should keep the selected-count fact visible, place the most likely safe action in `primaryActions`, place supporting actions such as clearing selection in `secondaryActions`, and move advanced, rare, or risky choices into `overflowActions`.
- `DetailPanel` applies default vertical spacing between direct child content blocks.

## Progressive Disclosure

Progressive disclosure is the package-wide default for advanced use cases. Keep required decision facts and the current primary action visible, then disclose supporting controls or deeper explanation through the exported disclosure primitives.

Use [Progressive Disclosure](./PROGRESSIVE_DISCLOSURE.md) for the full component contract, accessibility rules, and first-flow recommendations.

## Panel Interactions

Use [Panel Interaction Patterns](./PANEL_INTERACTIONS.md) to choose between navigation drawers, persistent sidebars, side sheets, bottom sheets, modal dialogs, popovers/menus, and full-page flows across desktop, tablet, mobile, and small mobile breakpoints.

The core rule is:

- Navigation helps users go somewhere.
- Sheets help users inspect, configure, or act while staying in context.
- Modal dialogs block until a decision is made.
- Popovers and menus are brief, lightweight, and anchored.
- Full pages are for complex, long, sequential, or focus-heavy tasks.

## Responsive Defaults

- Mobile-first behavior is the default for every component.
- Layout and shell primitives span the viewport by default and preserve responsive horizontal gutters.
- Width-capped layouts are opt-in through optional `width` props on layout and shell wrappers.
- Marketplace navigation uses bottom navigation on smaller screens.
- Admin navigation uses bottom navigation on smaller screens and persistent side navigation at larger breakpoints.
- `DataTable` defaults to stacked cards on mobile.

## Marketplace Direction

Marketplace-specific conversion rules, signal hierarchy, component coverage, and roadmap live in [Marketplace Design System Direction](./MARKETPLACE_SYSTEM.md). Keep this README focused on package-wide design-system contracts.

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
