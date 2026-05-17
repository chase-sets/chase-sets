# Panel Interaction Patterns

## Overview

Panel interactions help users navigate, inspect, configure, decide, or complete focused work without losing the structure of the product. The design system owns the pattern names, responsive behavior, accessibility contract, and reusable component API shape. Bounded contexts own workflow behavior, domain language, data loading, validation, and submit outcomes.

Use this decision rule before choosing a component:

- If the interaction helps users go somewhere, use navigation.
- If the interaction helps users inspect, configure, or act on something while staying in context, use a sheet.
- If the interaction blocks the user until a decision is made, use a modal dialog.
- If the interaction is brief, lightweight, and anchored to a trigger, use a popover or menu.
- If the task is complex, long, sequential, or requires focus, use a full-page flow.

Do not use "drawer" as a generic term. The only approved design-system drawer name is `NavigationDrawer`, because that pattern is specifically for navigation. Product, design, and documentation language must use the canonical pattern names below.

## Pattern Taxonomy

| Pattern | Primary UX Purpose | Common Use Cases | Placement | Modality | Dismiss Behavior |
| --- | --- | --- | --- | --- | --- |
| Navigation Drawer | Temporary navigation container for app destinations. | Mobile app navigation, deep IA, workspace/account areas when tabs cannot fit. | Left edge in left-to-right layouts. | Usually modal on mobile and tablet; may be non-modal only when pinned open at larger sizes. | Close button, Escape, outside press when modal, route selection, browser Back on mobile when opened from history state. |
| Sidebar | Persistent navigation or persistent supporting region. | Admin primary nav, marketplace category rail, persistent filters, persistent inspector. | Left for primary navigation and filters; right for summary, inspector, or activity. | Non-modal. | Does not dismiss unless user explicitly collapses or responsive breakpoint hides it. |
| Side Sheet | Contextual side panel for staying on the current page. | Details, filters, edit panels, previews, inspectors, activity/comments, AI assistant, contextual settings. | Right by default; left only when the content modifies left-side navigation or filter scope. | Modal for blocking contextual tasks; non-modal for inspectable support content. | Close button, Escape when modal, outside press when modal, optional route/back-state close. |
| Bottom Sheet | Contextual mobile panel for staying in context. | Mobile filters, contextual actions, pickers, lightweight details, short forms, share options. | Bottom edge, respecting safe areas. | Modal by default; non-modal only for persistent utility sheets that do not cover primary content. | Close button, drag down when safe, Escape or Back, outside press when modal. |
| Modal Dialog | Blocking focused interaction. | Delete confirmation, discard changes, short required decision, urgent permission or recovery prompt. | Centered viewport surface. | Always modal. | Explicit action, close button only when cancellation is valid, Escape only when cancellation is valid. |
| Popover/Menu | Lightweight anchored interaction. | More actions menu, account/workspace switcher, sort selector, compact formatting controls. | Anchored to trigger, collision-aware. | Non-modal by default; menu captures keyboard focus while open. | Item selection, outside press, Escape, trigger toggle, focus loss when appropriate. |
| Full Page | Dedicated focused workflow. | Create report, checkout, onboarding, complex edit, setup, content-heavy detail, multi-step task. | Own route or route segment. | Page modality through navigation, not overlay modality. | Browser navigation, explicit cancel/back, save/continue actions, unsaved-change guard when needed. |

### Navigation Drawer

- Use when: the user needs to move between destinations and the information architecture is deeper than a tab bar or simple menu can hold.
- Do not use when: the content is a form, filter set, item detail, notification feed, or settings inspector. Those are sheets or pages.
- Responsive behavior: desktop should usually promote app-level navigation to a Sidebar; mobile may use a Navigation Drawer only when tabs, bottom navigation, or a compact menu cannot represent the IA.
- Accessibility: label the drawer with the product or navigation scope, expose a close control, trap focus while modal, return focus to the trigger, and keep selected route state available to screen readers.
- Example scenarios: admin section navigation, marketplace account navigation with many destinations, workspace-scoped navigation when switching sections.

### Sidebar

- Use when: a navigation or supporting region should remain visible while the user works.
- Do not use when: the panel interrupts a task, needs explicit dismissal, or contains a temporary contextual workflow.
- Responsive behavior: collapse to bottom navigation, tab bar, compact menu, Navigation Drawer, Bottom Sheet, or Full Page depending on the content purpose.
- Accessibility: keep it in normal document order when persistent, identify navigation regions with `nav` and an accessible label, and avoid focus traps.
- Example scenarios: admin primary navigation, desktop category rail, persistent checkout summary, persistent activity inspector.

### Side Sheet

- Use when: the user should inspect, configure, or act on an object while preserving page context.
- Do not use when: the task is primary navigation, long sequential work, checkout, onboarding, a dense edit flow, or a decision that must block all other work.
- Responsive behavior: desktop uses a right-side sheet; tablet may use a narrower side sheet for read-only or short controls; mobile maps to Bottom Sheet for lightweight content or Full Page for rich content.
- Accessibility: modal side sheets trap focus and lock background scroll; non-modal side sheets do not trap focus and must be reachable in tab order. Both need a title, close affordance when temporary, and focus return when closed.
- Example scenarios: row details, table filters, edit customer short form, AI assistant, activity/comments panel, contextual settings.

### Bottom Sheet

- Use when: a mobile user needs contextual controls or short content without leaving the current page.
- Do not use when: the content has multiple steps, long forms, dense tables, critical legal/payment review, or enough content to require a page title and route.
- Responsive behavior: Bottom Sheets are primarily mobile and small tablet patterns. At desktop sizes, use a Side Sheet, Sidebar, Popover/Menu, or Modal Dialog depending on purpose.
- Accessibility: modal bottom sheets trap focus, announce the title, lock background scroll, respect safe areas, and support Back as close when opened from a route/history state.
- Example scenarios: mobile filters, sort and view controls, share sheet, lightweight item details, compact picker, short edit.

### Modal Dialog

- Use when: the system needs a decision before continuing or the user starts a short focused task that must block background interaction.
- Do not use when: the content is supporting detail, a notification feed, filters, a long form, a multi-step task, or a page-worthy workflow.
- Responsive behavior: mobile dialogs stay compact for short decisions; longer dialog content becomes a Full Page or full-screen dialog-like route.
- Accessibility: dialogs always trap focus, set `role="dialog"` or `role="alertdialog"` as appropriate, include `aria-modal="true"`, return focus on close, and provide clear primary and secondary actions.
- Example scenarios: confirmation before deleting, discard unsaved changes, revoke API key, confirm payout request.

### Popover / Menu

- Use when: the user needs a small anchored choice set or lightweight supporting content.
- Do not use when: the content is scroll-heavy, critical, destructive without confirmation, form-heavy, or likely to collide with the viewport.
- Responsive behavior: if a desktop popover menu has too many items for mobile space, use a Bottom Sheet. If the content becomes complex, use a Full Page.
- Accessibility: trigger must expose expanded state, menus use arrow-key navigation and typeahead where available, and focus returns to the trigger after close.
- Example scenarios: More actions menu, account/workspace switcher, sort selector, share options when only a few targets exist.

### Full-Page Flow

- Use when: the task requires focus, sequence, deep validation, substantial content, or durable URL state.
- Do not use when: the work is a small contextual adjustment that benefits from staying on the source page.
- Responsive behavior: Full Page remains Full Page across breakpoints. Layout density and step navigation adapt, but the route stays dedicated.
- Accessibility: use semantic page headings, logical focus on navigation, browser history, unsaved-change guards, and visible validation summaries.
- Example scenarios: create report, checkout, onboarding, complex customer edit, setup wizard, rich item details.

## Decision Tree

1. Is the user moving to another destination?
   Use Navigation Drawer, Sidebar, tab bar, bottom navigation, or a navigation menu.
2. Is the content always useful while the user works?
   Use Sidebar for persistent navigation/support or an inline page region for ordinary content.
3. Does the user need current-page context while inspecting or configuring something?
   Use Side Sheet on desktop/tablet or Bottom Sheet on mobile for lightweight content.
4. Must the user make a blocking decision before continuing?
   Use Modal Dialog.
5. Is the interaction anchored, brief, and lightweight?
   Use Popover/Menu. On mobile, promote to Bottom Sheet if anchoring or space is weak.
6. Is the task long, complex, sequential, content-heavy, or high stakes?
   Use Full Page.

When patterns overlap, prefer the pattern that protects task comprehension:

- Filters: Side Sheet or persistent Sidebar on desktop; Bottom Sheet on mobile.
- Rich details: Side Sheet only for quick inspection; Full Page when content must be read, shared, indexed, or linked.
- Edit forms: Side Sheet for short forms; Full Page for complex edits, multiple sections, or cross-field validation.
- Destructive actions: Modal Dialog after the initiating surface, not a sheet footer alone.
- Settings: Side Sheet for contextual settings; Full Page for account, billing, notification, security, or setup settings with many sections.

## Desktop Guidance

Use desktop width to preserve context without turning the screen into a stack of competing panels.

| Need | Recommended Pattern | Placement | Notes |
| --- | --- | --- | --- |
| App-level navigation | Sidebar or Navigation Drawer | Left | Prefer persistent Sidebar for admin and dense workspaces. Temporary Navigation Drawer is acceptable for compact desktop shells or secondary IA. |
| Details, previews, inspectors | Side Sheet or persistent Sidebar | Right | Non-modal when the page remains usable; modal when the sheet owns a focused edit or decision. |
| Filters | Sidebar, Side Sheet, or inline FilterBar | Left for persistent filters, right for temporary filter editing | Search and table filters should summarize active filters outside the sheet. |
| Short edit panel | Side Sheet | Right | Use when the user benefits from seeing the source record. Move to Full Page when the form is long or multi-section. |
| Blocking confirmation | Modal Dialog | Center | Use `AlertDialog` for destructive or irreversible choices. |
| Lightweight actions | Popover/Menu | Anchored | Keep it short and collision-aware. |
| Complex creation/editing | Full Page | Dedicated route | Use for reports, checkout, setup, onboarding, and multi-step flows. |

### Placement

- Left placement is for navigation and browse/filter scope.
- Right placement is for object details, activity, comments, AI assistant, edit panels, previews, summaries, and inspectors.
- Center placement is reserved for modal dialogs.
- Bottom placement is not a desktop default except for transient toasts and mobile-width responsive previews.

### Modal vs Non-Modal Side Sheets

- Modal Side Sheet: use for short focused edits or contextual tasks where background interaction would corrupt the task. It traps focus, shows a scrim, locks background scroll, and closes with explicit controls.
- Non-Modal Side Sheet: use for inspectors, activity panels, AI help, and read-only supporting content. It does not trap focus or lock page scroll. It may resize or reserve layout width.
- If the sheet changes a record and unsaved changes exist, closing requires a discard confirmation or an inline save/discard footer.

### Persistent vs Temporary Panels

- Persistent panels are part of layout. They reserve width, scroll independently only when necessary, and do not use a scrim.
- Temporary panels overlay or slide over content. They should be one at a time, titled, dismissible, and tied to a trigger or route state.
- Avoid stacked panels. If a panel needs another panel, replace the content in place, navigate to Full Page, or open one Modal Dialog for a blocking confirmation.

### Scroll And Width

- A modal Side Sheet locks the page behind it and owns its internal scroll region.
- A non-modal Side Sheet may allow page scroll, but its header and primary footer should remain visible when it contains actions.
- Side Sheets should not shrink the main content below usable table, form, or card widths. At narrow desktop or tablet widths, overlay the sheet instead of squeezing the page.
- Persistent Sidebars reserve layout width only at breakpoints where the remaining content keeps its minimum usable width.

### Keyboard, Screen Reader, And Escape

- Open focus lands on the sheet title or first meaningful control.
- Escape closes modal sheets unless the task has blocking unsaved changes; then Escape opens or focuses the discard decision.
- Escape in non-modal sheets should close only when focus is inside the sheet and the sheet is temporary.
- Screen readers must hear a meaningful title, not "Panel" or "Drawer".
- Close controls use an accessible name that includes the surface purpose, such as `Close filters` or `Close customer details`.

### Overlay / Scrim Usage

- Use a scrim for modal Side Sheets and Modal Dialogs.
- Do not use a scrim for persistent Sidebars or non-modal support panels.
- Scrim press may close only when dismissal is safe and equivalent to Cancel.

## Mobile Guidance

Mobile surfaces must preserve thumb reach, route clarity, and content comprehension. Do not compress desktop complexity into a cramped sheet.

| Need | Recommended Pattern | Notes |
| --- | --- | --- |
| Contextual actions or controls | Bottom Sheet | Use compact or medium height; keep actions reachable. |
| Filters | Bottom Sheet | Show active filters as chips outside the sheet and provide clear all plus show results. |
| Lightweight details | Bottom Sheet | Use when the source list remains useful behind the sheet. |
| Rich details | Full Page | Use when content is long, shareable, or route-worthy. |
| Short form | Bottom Sheet | Limit to a few fields and one primary action. |
| Complex form or multi-step workflow | Full Page | Use browser/app Back, save/discard, and validation summary. |
| Navigation | Tabs, bottom navigation, compact menu, or Navigation Drawer | Use Navigation Drawer only when IA depth cannot fit better mobile navigation. |
| Blocking decision | Modal Dialog | Keep it short. Use Full Page for long legal, payment, or setup decisions. |
| Anchored options | Popover/Menu or Bottom Sheet | Use Bottom Sheet when the menu would collide or exceed available space. |

### Bottom Sheet Heights

- Compact: content height up to about 25% of the viewport. Use for 3-5 actions, sort choices, share targets, or a short picker.
- Medium: 40-60% of the viewport. Use for filters, lightweight details, or a short form.
- Expanded: 75-90% of the viewport. Use only when users still benefit from staying on the source page.
- Full-height: use sparingly. If full-height is the default state or the content needs a page title, promote to Full Page.

### Gestures And Back Behavior

- Drag-to-dismiss is allowed only when dismissal is safe, reversible, and does not lose unsaved work.
- Swipe gestures must not conflict with horizontal carousels, tables, or maps inside the sheet.
- Mobile Back closes the topmost modal sheet when it was opened through route/history state; otherwise it follows the app shell's standard close behavior.
- Back from a Full Page follows browser/app history and should not silently discard data.

### Safe Areas, Keyboard, And Ergonomics

- Bottom Sheets respect `env(safe-area-inset-bottom)` and keep primary actions above the home indicator.
- Inputs avoid the on-screen keyboard; the active field and validation text stay visible.
- Primary actions sit in a sticky footer for medium, expanded, and full-height sheets.
- Touch targets are at least 44px. Destructive actions need separation from primary save/apply actions.
- Close or collapse controls stay reachable at the top edge and have accessible names.

### Scroll Locking And Nested Scrolling

- Modal Bottom Sheets lock background scroll.
- Sheet body may scroll, but avoid nested scroll containers. If nested scrolling is unavoidable, headers and footers stay stable and the inner region has clear boundaries.
- Page content behind a sheet must not shift when the sheet opens.

### When To Promote A Bottom Sheet

Use Full Page instead of Bottom Sheet when any of these are true:

- The form has more than one section, cross-field validation, conditional branching, file upload, payment/security data, or unsaved draft recovery.
- The content is long enough that the user starts at expanded or full-height every time.
- The workflow has steps, checkpoints, route-worthy sharing, breadcrumbs, or durable browser history.
- The user must compare, read, or edit dense data.
- The task is high stakes: checkout, payouts, account security, tax, identity, or irreversible marketplace commitment.

### Desktop Side Sheet Mapping

- Desktop Side Sheet for filters -> mobile Bottom Sheet.
- Desktop Side Sheet for lightweight item details -> mobile Bottom Sheet.
- Desktop Side Sheet for rich item details -> mobile Full Page.
- Desktop Side Sheet for short edit form -> mobile Bottom Sheet.
- Desktop Side Sheet for complex edit form -> mobile Full Page.
- Desktop Side Sheet for activity/comments -> mobile Bottom Sheet if compact, Full Page if conversation-heavy.
- Desktop Side Sheet for AI assistant/help -> mobile Bottom Sheet for quick help, Full Page for chat history or multi-turn work.

## Responsive Behavior

Canonical breakpoints:

- Large desktop: `>= 1280px`
- Desktop: `1024px - 1279px`
- Tablet: `768px - 1023px`
- Mobile: `390px - 767px`
- Small mobile: `< 390px`

| Desktop Pattern | Large Desktop | Desktop | Tablet | Mobile | Small Mobile |
| --- | --- | --- | --- | --- | --- |
| Navigation Drawer | Prefer Sidebar unless temporary IA is needed. | Temporary Navigation Drawer or Sidebar based on width. | Modal Navigation Drawer if IA is deep. | Navigation Drawer, tab bar, or bottom navigation depending on IA depth. | Prefer bottom navigation or compact menu; Navigation Drawer only for deep IA. |
| Sidebar / persistent navigation | Persistent left nav or support rail. | Persistent if content remains usable. | Collapse to Navigation Drawer, tabs, or Bottom Sheet by purpose. | Usually bottom navigation, tabs, or compact menu. | Bottom navigation or single menu button. |
| Side Sheet for filters | Persistent FilterRail or Side Sheet. | Side Sheet or FilterRail. | Modal Side Sheet or Bottom Sheet. | Bottom Sheet. | Bottom Sheet with compact groups and sticky apply. |
| Side Sheet for item details | Right non-modal or modal sheet. | Right sheet. | Modal sheet if content is short. | Bottom Sheet for lightweight details; Full Page for rich details. | Full Page more often; Bottom Sheet only for compact summaries. |
| Side Sheet for edit form | Right modal sheet for short edits. | Right modal sheet or Full Page. | Bottom Sheet for very short forms; Full Page otherwise. | Bottom Sheet for short forms; Full Page for complex forms. | Full Page unless the form is very short. |
| Modal Dialog | Center dialog. | Center dialog. | Center or near-full dialog for short decisions. | Dialog for short decisions; full-screen route for longer decisions. | Keep dialog terse or promote to Full Page. |
| Popover/Menu | Anchored popover/menu. | Anchored popover/menu. | Anchored if space allows; otherwise Bottom Sheet. | Bottom Sheet when options exceed available space. | Bottom Sheet or Full Page for long lists. |
| Full Page | Dedicated route. | Dedicated route. | Dedicated route. | Dedicated route. | Dedicated route. |

Breakpoint behavior must be declared in component props or wrapper pattern docs. Do not let each consuming route invent its own responsive mapping for the same interaction.

## Accessibility Requirements

All patterns:

- Provide meaningful accessible names. Names should describe the task: `Filters`, `Customer details`, `Delete report`, `Workspace switcher`.
- Return focus to the trigger after close unless navigation moves focus to a new page heading.
- Preserve visible focus states through design-system focus tokens.
- Respect `ChaseRoot` reduced-motion policy. Motion must not be required to understand state changes.
- Keep touch targets at least 44px on mobile and tablet.
- Support safe areas on mobile overlays.
- Do not rely on color alone for status, selected state, warnings, or destructive risk.

Modal surfaces:

- Trap focus while open.
- Lock background scroll.
- Use a scrim unless the component is a full-screen route.
- Announce title and description.
- Close with Escape only when cancellation is safe.
- Restore focus to the opener or move focus to the next logical location after a completed action.

Pattern-specific roles:

- Modal Dialog: `role="dialog"` with `aria-modal="true"`; use alert dialog semantics for urgent or destructive confirmations.
- Modal Side Sheet: dialog semantics with `aria-modal="true"` because it blocks background interaction.
- Non-modal Side Sheet: complementary or region semantics with an accessible label; no focus trap and no `aria-modal`.
- Modal Bottom Sheet: dialog semantics with `aria-modal="true"` and mobile Back support.
- Non-modal Bottom Sheet: region semantics, no focus trap, and persistent affordance to collapse or dismiss.
- Popover/Menu: use the primitive's popover or menu roles; menus support arrow keys, Escape, typeahead where available, and disabled item semantics.
- Navigation Drawer and Sidebar: `nav` landmark with an accessible label when they contain destinations.

Browser history and Back:

- Opening a modal sheet from a route-worthy state may push a history entry so Back closes it.
- Do not push history for transient popovers or small menus.
- Full Page flows use ordinary browser history and guard unsaved changes.

## Component API Recommendations

Canonical design-system names:

- `NavigationDrawer`: navigation container.
- `Sidebar`: persistent navigation or persistent supporting region.
- `SideSheet`: contextual side panel.
- `BottomSheet`: contextual mobile panel.
- `ModalDialog`: blocking focused interaction.
- `Popover` and `Menu`: lightweight anchored interaction.
- `FullPage`: dedicated focused workflow wrapper or route template.

The package exposes only canonical pattern wrappers for the taxonomy. It does not export a generic `Drawer`, deprecated drawer aliases, or duplicate dropdown menu aliases. Product code must import the canonical wrapper that matches the user interaction.

Marketplace-specific wrappers:

- `MarketplaceFilterBottomSheet`: mobile search and table filters with result context and sticky apply actions.
- `CommerceSheet`: contextual marketplace commerce inspection or action; desktop Side Sheet and mobile Bottom Sheet.
- `MarketplaceActionSheet`: marketplace action groups that should stay in context; desktop Side Sheet and mobile Bottom Sheet.
- `ResponsiveEditSheet`: short contextual edit forms; desktop Side Sheet and mobile full-height Bottom Sheet by default.
- `NotificationCenterSheet`: notification feed/settings; desktop Side Sheet and mobile Bottom Sheet.
- `ResponsiveActionMenu`: desktop anchored `Menu` that promotes to mobile Bottom Sheet when the action list is too long for touch-friendly anchoring.
- `ActivitySheet`, `CommentsSheet`, `AssistantSheet`, and `HelpSheet`: named support panels for non-primary supporting content; desktop right Side Sheet and mobile Bottom Sheet.

Recommended prop shape:

| Prop | Applies To | Requirement |
| --- | --- | --- |
| `open`, `defaultOpen`, `onOpenChange` | Temporary panels and overlays | Controlled and uncontrolled support. |
| `title` | Sheets, dialogs, pages | Required and rendered as accessible name. |
| `description` | Sheets, dialogs | Optional visible or screen-reader description. |
| `modal` | SideSheet, BottomSheet | Required boolean or variant with documented defaults. |
| `placement` | SideSheet | `right` default; `left` only for navigation-adjacent or filter-scope panels. |
| `height` | BottomSheet | `compact`, `medium`, `expanded`, `full`; `full` should warn toward Full Page. |
| `dismissible` | Sheets, dialogs | False only when an explicit required decision is present. |
| `closeLabel` | Temporary panels and overlays | Required when close control appears. |
| `initialFocusRef` | Modal surfaces | Use for first safe focus target when the default is not enough. |
| `returnFocusRef` | Modal surfaces | Use when the trigger unmounts or focus should return elsewhere. |
| `footer` | Sheets, dialogs | Sticky for actions when content can scroll. |
| `onBeforeClose` | Forms in sheets/pages | Handles unsaved changes and discard confirmation. |
| `responsiveBehavior` | Pattern wrappers | Declares desktop/tablet/mobile mapping for route-level consistency. |

Implementation rules:

- Component wrappers own layout, motion, focus behavior, scrim, scroll locking, safe-area padding, sticky header/footer, and responsive placement.
- Bounded contexts pass titles, descriptions, actions, validation state, loading state, empty state, and domain content.
- Do not create route-local overlay CSS or custom panel widths. Add missing variants to the design system.
- Avoid component names such as `GenericDrawer`, `PanelDrawer`, `CustomModal`, or `MobileModal`. Add a canonical wrapper or use the existing canonical one.
- For More actions, share options, and grouped contextual commands, use `ResponsiveActionMenu` before building a route-local menu. Keep desktop anchored unless the action set becomes too dense; mobile promotes to Bottom Sheet when the item count exceeds the documented threshold.
- For activity, comments, assistant, or help panels, use the named support wrapper. If the content becomes threaded, long, or route-worthy, promote the mobile experience to Full Page instead of increasing the Bottom Sheet indefinitely.
- Do not reintroduce compatibility aliases such as `FilterDrawer`, `CommerceDrawer`, `NotificationCenterDrawer`, `MarketplaceFilterDrawer`, `MarketplaceMobileFilterDrawer`, `MarketplaceUiFilterBottomSheet`, or `DropdownMenu`.

## Do / Don't Examples

| Do | Don't |
| --- | --- |
| Use Sidebar for persistent admin navigation. | Use Side Sheet for primary app navigation. |
| Use Side Sheet for desktop row details. | Use Navigation Drawer for row details. |
| Use Bottom Sheet for mobile table filters. | Use a full-screen Navigation Drawer for filters. |
| Use Modal Dialog for delete confirmation. | Use a non-modal sheet footer as the only destructive confirmation. |
| Use Popover/Menu for five More actions items. | Put a dense, scroll-heavy workflow in a popover. |
| Use Full Page for create report. | Put multi-step report creation in a Bottom Sheet. |
| Use Full Page for mobile complex edit. | Force a long edit form into an expanded Bottom Sheet. |
| Use one temporary surface at a time. | Stack Navigation Drawer over sheet over dialog without approval. |

Misuse prevention rules:

- Do not use Navigation Drawers for forms, filters, or item details.
- Do not use Side Sheets for primary navigation.
- Do not use Bottom Sheets for long, complex workflows.
- Do not use Modal Dialogs for non-blocking supporting content.
- Do not use Popovers for dense, scroll-heavy, or critical workflows.
- Do not stack multiple Navigation Drawers, sheets, or modals unless explicitly approved by design-system governance.
- Do not create multiple names for the same interaction pattern.

## Example Scenarios

| Scenario | Desktop Recommendation | Mobile Recommendation | Tradeoff |
| --- | --- | --- | --- |
| Main app navigation | Sidebar for admin; top/bottom nav for marketplace; temporary Navigation Drawer only for dense IA. | Bottom navigation, tabs, compact menu, or Navigation Drawer for deep IA. | Persistent nav speeds desktop work; mobile needs thumb reach and less chrome. |
| Account or workspace switcher | Popover/Menu anchored to account control. | Bottom Sheet if more than a few accounts or workspace metadata is needed. | Anchored desktop switchers are fast; mobile needs room for touch targets. |
| Table filters | Persistent Sidebar or Side Sheet with active-filter summary. | Bottom Sheet with grouped filters, clear all, and show results. | Desktop can preserve result context; mobile needs a focused filter surface. |
| Row details | Non-modal Side Sheet for quick inspection; Full Page for rich records. | Bottom Sheet for lightweight summary; Full Page for rich details. | Sheets keep list context, pages support reading and deep links. |
| Edit customer | Side Sheet for short edits; Full Page for multi-section or permission-heavy edits. | Bottom Sheet for 1-3 simple fields; Full Page for complex edit. | Short edits benefit from context; complex validation needs a page. |
| Create report | Full Page flow with stepper or sections. | Full Page flow. | Report creation is sequential and often needs validation, preview, and save state. |
| Confirmation before deleting | Modal Dialog or AlertDialog. | Modal Dialog if short; Full Page only for unusually detailed consequences. | Blocking confirmation prevents accidental irreversible action. |
| Share options | Popover/Menu for a short list. | Bottom Sheet for touch-friendly share targets. | Mobile share choices need more spacing and platform-like behavior. |
| More actions menu | `ResponsiveActionMenu` rendered as an anchored Menu. | `ResponsiveActionMenu` rendered as a Bottom Sheet when options exceed available space. | Keep common desktop actions fast; promote when mobile space is tight. |
| Mobile filter experience | Side Sheet or FilterRail on desktop source route. | Bottom Sheet. | Filters are contextual controls, not navigation. |
| Mobile edit form | Side Sheet on desktop for short form. | Bottom Sheet for short form; Full Page for complex form. | Avoid expanded sheets becoming poor pages. |
| Mobile item details | Side Sheet or Full Page based on detail richness. | Bottom Sheet for summary; Full Page for full detail. | Lightweight details can preserve list context; rich content needs a route. |
| AI assistant/help panel | `AssistantSheet` or `HelpSheet` as non-modal right Side Sheet. | Bottom Sheet for quick help; Full Page for conversation history or complex tasking. | Non-modal assistance should not block core work unless the user starts a focused flow. |
| Activity/comments panel | `ActivitySheet` or `CommentsSheet`, or persistent Sidebar for active records. | Bottom Sheet for short activity; Full Page for long threaded conversation. | Comments often need reading depth on mobile. |

## Governance Rules

- The design system is the canonical source for pattern names, responsive mapping, accessibility requirements, motion, scrim behavior, and component API shape.
- Bounded contexts own the reason a surface opens, the data inside it, validation, commands, events, read models, and workflow outcomes.
- Deployables compose route shells and must not introduce custom panel primitives.
- New overlay or panel variants require design-system review when they add a new name, breakpoint behavior, focus behavior, scroll model, or stacking model.
- Bounded-context routes must import the named wrapper that matches the interaction; they must not compose low-level `Drawer`, `BottomSheet`, or `SideSheet` directly when a marketplace wrapper exists for the scenario.
- A pull request that adds a panel must identify the chosen pattern in its description or code comments when the choice is not obvious.
- Stacked temporary surfaces require explicit design-system approval. The default alternatives are replace-in-place, Full Page, or one Modal Dialog for a blocking confirmation.
- Any surface that reaches full-height on mobile by default must be reviewed as a Full Page candidate.
- Pattern names in docs, issues, tests, route names, and component wrappers must match this taxonomy.

## QA Checklist

Use this checklist for every new or changed panel interaction:

- Pattern choice follows the decision rule.
- Canonical name is used; "drawer" is not used generically.
- Desktop, tablet, mobile, and small-mobile behavior is declared.
- Navigation surfaces contain only destinations.
- Sheets contain contextual inspection, controls, or short actions.
- Modal dialogs block only when a decision is required.
- Popovers/menus are anchored, brief, and not scroll-heavy.
- Full Page is used for long, complex, sequential, content-heavy, or high-stakes work.
- Surface has a meaningful title and accessible name.
- Focus moves into modal surfaces and returns on close.
- Non-modal surfaces do not trap focus or lock unrelated content.
- Escape and Back behavior is defined and tested.
- Scroll locking, internal scroll, sticky header/footer, and page-width impact are verified.
- Mobile safe areas, keyboard avoidance, and 44px touch targets are verified.
- Reduced motion keeps state changes understandable.
- Loading, empty, error, validation, and unsaved-change states are designed.
- Close, cancel, apply, save, delete, and secondary actions are placed consistently.
- Active filters, selected objects, or pending changes are summarized outside temporary surfaces when users need that state after closing.
- No stacked Navigation Drawer, sheet, or modal patterns are introduced without approval.
