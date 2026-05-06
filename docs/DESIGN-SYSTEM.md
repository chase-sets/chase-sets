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

## Marketplace System Rules

Marketplace UI follows this hierarchy: Trust -> Clarity -> Speed -> Comparison -> Polish -> Delight.

- Listing cards must show price, seller name, seller trust, availability, fulfillment, and one dominant primary action.
- Save, compare, and watchlist actions are secondary affordances.
- Checkout must make subtotal, shipping, fees, tax, discounts, wallet credit, final total, secure payment, policy, and support paths visible before commitment.
- Search and filtering must show selected state, counts when available, clear-all, and reversible recovery paths.
- Trust signals must use text and semantic icons, not color alone.
- Brand expression belongs in hero, category, story, onboarding, featured collection, and confirmation moments. Transactional screens stay task-first.

Avoid decorative gradients, glow-heavy surfaces, video backgrounds, ambient animation, sparse cards that hide decision facts, hidden pricing, and competing CTAs in marketplace flows.

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

## Motion

- Use `Reveal`, `Stagger`, and `ViewTransition` for consumer-authored motion.
- Do not import `motion/react` directly from applications.
- Keep motion additive and restrained: emphasize route changes, overlays, navigation state, cards, and workflow transitions rather than ambient animation.
- All motion must degrade cleanly under reduced-motion mode.
