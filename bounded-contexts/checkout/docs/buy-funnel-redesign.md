# Buy Funnel Redesign — Elegant Minimalist Checkout

Canonical design source of truth for redesigning the entire buy funnel (cart →
checkout start → checkout steps → confirmation) into a beautiful, elegant,
minimalist experience.

This is the foundation spec for milestone #33. Every other redesign issue
consumes it. It is the authority on design language, price communication, action
hierarchy, status messaging, and per-surface layout. It also defines the exact
`@chase-sets/design-system` (DS) primitive work that the two downstream DS issues
implement: **#1852** (canonical `QuantityStepper`, suppress native number
spinners) and **#1853** (single-deferred-total totals, sticky bar / secure
indicator, line-item image placeholder, action-hierarchy helpers).

## Non-negotiable constraints

- **DS primitives only. No custom overrides.** Every surface is composed from
  exported DS primitives. No bespoke Tailwind classes, no inline geometry, no
  `style` props in the bounded context. If a surface needs something a primitive
  cannot express, that becomes a line in [DS primitive gap list](#6-ds-primitive-gap-list) —
  it does not become a one-off override.
- **Tokens, never raw values.** All spacing, type, color, elevation, radius, and
  motion reference tokens from `packages/design-system/src/theme/tokens.ts`.
- **Cart/readiness solves fulfillment; checkout never does.** Checkout summarizes
  a ready plan and collects contact/delivery/shipping/payment. It must not ask the
  customer to solve fulfillment assignment (carried forward from
  `checkout-visual-targets.md`).
- **No side effects before valid confirmation.** Recovery and pre-payment surfaces
  show no-side-effect facts; "no payment until checkout" / "not charged yet" stays
  honest.

---

## 1. Design language

The marketplace theme is dark-first navy surfaces, restrained borders,
marketplace-blue primary actions, teal trust cues, amber attention, and red only
for blocking states. The redesign tightens rhythm and restraint; it does not
introduce a new palette.

### Spacing rhythm

Spacing is the `SpaceToken` scale (`spacing[0..12]` → `--space-0 … --space-12`).
One vertical rhythm, three tiers — do not improvise intermediate gaps.

| Role                                    | Token        | Used via                              |
| --------------------------------------- | ------------ | ------------------------------------- |
| Intra-group (label ↔ value, icon ↔ text) | `spacing[1]`–`spacing[2]` | `Stack gap={1\|2}`, `Inline gap={2}`  |
| Within a card / form section            | `spacing[3]` | `Stack gap={3}`                       |
| Between cards / page sections           | `spacing[4]`–`spacing[5]` | `Stack gap={4\|5}`, `CheckoutFlowShell` |
| Two-column flow ↔ summary gutter        | `spacing[6]` | `CheckoutFlowShell` / `CheckoutLayout` |

Default `Surface`/`PageSection` padding is `spacing[4]`; the confirmation panel
and emphasis surfaces step to `padding={5}`. Avoid nested padded cards (no
card-in-card); compose with `Stack` gaps instead.

### Typographic scale

Use named DS typography components; never set `fontSize` directly. The `Text`
component exposes `size` `3xs|2xs|xs|sm|md|lg` (maps to `--font-size-*`),
`weight` `regular|medium|semibold|bold`, and `tone`
`primary|secondary|tertiary|inverse|accent|danger|inherit`. `Heading` carries the
larger steps via `level`/`visualSize`.

| Role                            | Component / props                              | Token reference          |
| ------------------------------- | ---------------------------------------------- | ------------------------ |
| Page title                      | `PageHeader title` (Heading)                   | `fontSize["3xl"\|"4xl"]` |
| Section title                   | `PageSection title` / `CheckoutFormSection`    | `fontSize.xl`            |
| Item title / row value          | `Text weight="semibold"` (default `md`)        | `fontSize.base`          |
| Supporting / subtitle / context | `Text size="sm" tone="secondary"`             | `fontSize.sm`            |
| Microcopy, captions, badges     | `Text size="xs" tone="tertiary"` / `Badge`    | `fontSize.xs`            |
| Money — totals                  | DS totals primitive (bold, `tabular-nums`)     | `fontSize.xl`–`2xl`      |
| Money — line/unit               | `Text weight="semibold"` (`tabular-nums` slot) | `fontSize.base`          |

Rules: one page title per surface; one section title per section; money always
renders in a `tabular-nums` slot (already true inside DS totals primitives — keep
prices inside them rather than hand-rolling rows). Reserve `letterSpacing.wide`
for the small uppercase eyebrow labels only.

### Surface & elevation

Three structural depths, no more:

- **Page canvas** — `Page` background (`--background`).
- **Resting surface** — `Surface` default tone, `shadow-tokenSm` (`shadows.sm`),
  `radius.lg`. Cart line, summary panel, saved-info group.
- **Active / emphasis surface** — `Surface elevated` (`shadow-tokenLg`,
  `shadows.lg`) for the step the customer is acting in; add `glow`
  (`glow-accent`) sparingly, only on the single focused input section (contact /
  payment), never on more than one section at once.

Borders are `--border` (hairline). Semantic surfaces use the canonical tonal map
`SurfaceSemanticTone` = `neutral|info|success|warning|danger|trust|primary`
(`surfaceSemanticToneClasses`). Radius scale: `radius.md` for inputs/badges,
`radius.lg` for cards/panels, `radius.full` for pills.

### Restrained color

Color is meaning, not decoration. Default ink is `textPrimary` /
`textSecondary` / `textTertiary`.

| Intent                       | Token family                          | Where                                   |
| ---------------------------- | ------------------------------------- | --------------------------------------- |
| Primary action / focus       | `primary`, `focusRing` (`--ring`)     | one primary button; input focus         |
| Trust / security / payment   | `trust`, `trustSoft`                  | `SecurePaymentIndicator`, protection    |
| Ready / positive             | `success`, `successSoft`              | "Ready" badges, reassurance             |
| Needs attention (non-block)  | `warning`, `warningSoft`             | one attention surface per item          |
| Blocking only                | `danger`, `dangerSoft`               | unavailable / hard errors only          |
| Savings / deal               | `deal`, `dealSoft`                    | optimization "Save $X" (cart-side only) |

Red (`danger`) is reserved for blocking states. **Remove is not a blocking
state** and must not be danger-toned (see [§3](#3-action--button-hierarchy-rules)).

### Motion

Use DS motion tokens only; respect reduced-motion (DS `Button`/`LinkButton`
already gate interactive motion through `useChaseMotion`).

| Token          | Value                              | Use                                   |
| -------------- | --------------------------------- | ------------------------------------- |
| `motion.fast`  | `120ms`                           | hover/press on controls               |
| `motion.base`  | `150ms`                           | section reveal, row collapse/expand   |
| `motion.slow`  | `240ms`                           | sticky bar / summary disclosure       |
| `motion.ease`  | `cubic-bezier(0.16, 1, 0.3, 1)`   | all of the above                      |

No parallax, no decorative looping animation in the funnel.

---

## 2. Price-communication strategy

### The defect (cart, today)

`cart-page.tsx` shows **no real prices** and repeats the literal
`"Price at checkout"` string roughly five times: line total (`linePriceLabel`),
the `PriceBreakdown` "Subtotal" line value, the `PriceBreakdown` `total`, the
`StickyCtaBar price`, and the shipping/tax line ("Calculated at checkout"). The
breakdown also labels the total **"Subtotal"** twice (line + total) — two rows,
same word, both deferred. The result reads as broken, not deferred.

Root cause is real and must be respected: under **Smart Match**, the final
listing (and therefore the final unit price) is resolved at checkout, not in the
cart. The cart genuinely cannot promise a charge amount. The fix is to **show
what is known and defer exactly one thing, clearly labeled** — not to repeat a
deferral string in every price slot.

### The model: indicative "from" line price + a single deferred total

1. **Per line — an indicative price.** The cart already computes a lowest known
   unit price (`lowestKnownUnitPrice` / `selectedUnitPrice` from
   `seller_options`). Surface it as a **"from"** indicative price:
   - Known price → `from $X` (× quantity for the line), `tabular-nums`, with a
     small `Badge`/caption reading `Indicative`.
   - Genuinely unknown (no priced options) → quiet `Text size="sm"
     tone="tertiary"` reading `Priced at checkout` — **once**, on that line only.
   - Locked listing (`fulfillment_mode === "locked-listing"`) → exact price, no
     "from", no indicative caption.

2. **One deferred total, labeled "Estimated total".** The cart shows a single
   summary value labeled **`Estimated total`** (the sum of known indicative line
   prices), with one muted line `Shipping & tax — calculated at checkout`. Drop
   the duplicate "Subtotal" rows. The deferral is stated **once**, as the total's
   supporting caption: `Final total confirmed at checkout`.

3. **Checkout escalates to a real total.** Once the session has a fulfillment +
   payment preview, the checkout summary shows the firm breakdown (subtotal,
   shipping, tax, marketplace fee, wallet credit) and a single bold total labeled
   **`Total`** (or `Payable total` when fees apply). Pre-quote values render as a
   quiet `Pending` placeholder inside the breakdown — never the word repeated
   across rows.

### Label vocabulary (use exactly these; do not invent variants)

| Context                       | Line/unit slot       | Total label       | Total caption                       |
| ----------------------------- | -------------------- | ----------------- | ----------------------------------- |
| Cart, price known             | `from $X`            | `Estimated total` | `Final total confirmed at checkout` |
| Cart, price unknown           | `Priced at checkout` | `Estimated total` | `Final total confirmed at checkout` |
| Cart, locked listing          | `$X` (exact)         | `Estimated total` | `Final total confirmed at checkout` |
| Checkout, before quote        | line est. or `Pending` | `Total`         | `Secure payment`                    |
| Checkout, quoted              | `$X`                 | `Payable total`   | `Secure payment`                    |
| Offer-intent                  | `$X` (offer)         | `Total`           | `No payment today`                  |

**Rule:** the deferral statement appears **once per surface** (as the total
caption). It never appears in a line slot _and_ a subtotal row _and_ a footer.

### Product/pricing dependency (explicit)

- **Smart Match** resolves the final listing — and thus final unit price,
  availability, and shipping — at checkout. The cart's indicative price is a
  floor (`from`), not a quote. This dependency is the entire reason a deferred
  total exists; do not "fix" it by inventing a cart-side firm total.
- The indicative price uses only already-loaded `seller_options` data — no new
  network call in the cart.
- Locked listings are exempt: the listing is pinned, so the price is exact.

---

## 3. Action & button hierarchy rules

### The defect

In `cart-page.tsx`, `CartLineActions` renders **Remove** as a full-width
`Button tone="danger" leadingIcon="trash" block size="md"` — making the
**destructive** action the most prominent, highest-contrast control on the line.
Hierarchy is inverted: a card whose job is "buy these" leads with "delete this".

### Rules

1. **One primary action per surface.** Exactly one `Button`/`LinkButton`
   `tone="primary"` per surface (cart footer = "Check out"; each checkout step's
   commit; confirmation = "Continue to payment"). DS surfaces already encode this
   contract via `data-primary-action-count="1"` on their action slots
   (`CheckoutSummaryPanel`, `StickyCtaBar`, `CheckoutStickyActionBar`,
   `CheckoutConfirmationPanel`, `ListingPurchasePanel`). Keep that to one.
2. **Per-line cards have no primary.** A cart line is not the place to "buy".
   Its controls are all secondary/ghost. The primary lives once, in the footer /
   sticky bar.
3. **Demote Remove.** Remove becomes a low-emphasis, **non-danger** control:
   `Button tone="ghost" size="sm" leadingIcon="trash"`, not `block`. Danger tone
   is reserved for blocking states, not routine edits. Confirmation of an
   accidental remove is handled by undo affordance, not by visual alarm.
4. **Quantity is a control, not a button trio.** Replace the
   `NumberInput` + two `Button`s + submit `Button` cluster with a single
   `QuantityStepper` (DS, see [§6](#6-ds-primitive-gap-list) / #1852).
5. **Recovery / alternatives are secondary.** "Find alternatives",
   "Keep shopping", "Back to cart" are `tone="secondary"`.

### Tone → role map

| Role                                  | DS tone / variant                                  |
| ------------------------------------- | -------------------------------------------------- |
| The one primary action               | `Button tone="primary"` (or `LinkButton`)          |
| Standard secondary (navigation, edit) | `Button tone="secondary"` / `LinkButton tone="secondary"` |
| Low-emphasis line action (Remove, undo) | `Button tone="ghost" size="sm"`                  |
| Destructive **blocking** confirmation | `Button tone="danger"` — only in an explicit confirm step, never inline on a line |

### Per-line action priority (top → bottom, all non-primary)

1. Quantity stepper (the main thing you do to a line).
2. Listing action when relevant (`Lock this listing`) — `tone="secondary"`.
3. `Find alternatives` (only when blocked) — `tone="secondary"`.
4. `Remove` — `tone="ghost" size="sm"`, visually last and quietest.

---

## 4. Status-messaging consolidation

### The defect

For a single item that "needs attention", today's cart can say it **three times**:
a page-level `Banner` ("Fulfillment needs review"), a per-line `Badge`
(`readinessLabel` warning tone), and per-line inline `Text`
("Resolve before checkout") plus a `Find alternatives` link. One status, three
voices.

### Responsibilities — each status is said once, at one altitude

| Surface  | Owns                                                                 | Says                                                          | Primitive                                  |
| -------- | ------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| **Banner** | **Aggregate, cross-line** state that gates the whole surface       | "2 items need a fulfillment choice before checkout" + 1 action | `Banner` / `MarketplaceNotice` / `CheckoutStateNotice` |
| **Badge**  | **Per-item** current state (the at-a-glance label)                 | `Ready` / `Needs review` / `Unavailable` on that line        | `Badge` (tone matches semantics)           |
| **Inline** | **Per-item** the _one_ resolving action, when the badge is non-ready | a single `tone="secondary"` action (e.g. `Find alternatives`) | `LinkButton` / `Button`                    |

### Rules

1. **No duplication across altitudes for the same fact.** If the Banner counts
   blocked lines, the line shows a Badge + (at most) one action — not a second
   sentence restating the badge. Remove the redundant
   `"Resolve before checkout"` inline `Text` when the Badge already says
   `Needs review`.
2. **One banner at a time, by priority.** When multiple conditions are true,
   show the highest-priority banner only:
   `blocking (danger) > needs-review (warning) > optimization/savings (info/deal) > none`.
   Never stack a warning banner and an info banner.
3. **Badge tone = semantic tone.** `success` ready, `warning` needs review /
   waiting-for-supply / changed, `danger` unavailable, `neutral` informational
   (language, "Standard"). Tones come from `BadgeTone`.
4. **Notices vs banners:** page/section-gating state → `Banner`; in-flow
   contextual state inside the checkout form → `MarketplaceNotice` /
   `CheckoutStateNotice` (one per condition, deduplicated). The checkout page's
   stack of `MarketplaceNotice`s (review-updated, quote-required, totals-stale,
   needs-cart-review, fulfillment-changed, four fast-path variants) must collapse
   to **at most one notice at a time**, chosen by the same priority ladder.
5. **Reassurance is not a status.** "Secure payment" / "No payment until
   checkout" lives once, inside the totals primitive's `reassurance` slot via
   `SecurePaymentIndicator` — not as an extra banner.

---

## 5. Per-surface layout intent

All surfaces wrap in `Page` + `PageHeader`. Two-column flows use the canonical
checkout shell. Money lives in DS totals primitives.

> **Shell note.** Two shells exist: `CheckoutLayout` (current pages — main +
> sticky `Sidebar` summary) and `CheckoutFlowShell` (checkout/checkout.tsx — main
> + desktop `aside` summary + `mobileSummary` + `stickyAction`).
> **Adopt `CheckoutFlowShell`** as the canonical buy-funnel shell: it has
> first-class slots for the mobile collapsible summary
> (`CheckoutMobileSummaryDisclosure`) and the sticky action
> (`CheckoutStickyActionBar`), which the redesign needs. Migrate
> `checkout-page.tsx` and `checkout-start.tsx` off `CheckoutLayout` onto
> `CheckoutFlowShell`.

### 5.1 Cart (`features/cart/ui/cart-page.tsx`)

- **Frame:** `Page` → `PageHeader` (eyebrow "Buy cart", title "Your cart") →
  single `PageSection`.
- **Empty:** `MarketplaceEmptyState` with `PlatformCredibilityCue` trust cue and
  one `LinkButton` recovery (`Keep shopping`). Unchanged in intent.
- **Lines:** each line is `CheckoutSummaryLineItem`-style content inside a resting
  `Surface` (or the refined `MarketplaceCartLineItem`), composed of: image
  (with graceful placeholder — [§6](#6-ds-primitive-gap-list)), title +
  subtitle, `ProductOptions`, **one** readiness `Badge`, indicative `from` price
  (`tabular-nums`), a `QuantityStepper`, and the demoted action column
  (secondary listing action, secondary alternatives when blocked, ghost Remove).
- **Status:** at most one `Banner` (priority ladder, §4); per-line `Badge` +
  single inline action.
- **Quantity stepper stays live during writes (#1935).** The cart deliberately
  does **not** pass `QuantityStepper`'s `loading` flag while an optimistic write
  is pending: `loading` disables both −/+ buttons, which would break the
  rapid-coalescing UX (tap +/+/+ faster than one write settles → coalesce to one
  absolute target). Pending state is surfaced non-blockingly via the
  `data-optimistic-status` hook on the stepper's wrapper, not by disabling the
  control.
- **Totals + CTA:** one totals primitive (`Estimated total`, one muted
  shipping/tax line, `SecurePaymentIndicator` reassurance) + one `StickyCtaBar`
  whose `price` is the `Estimated total` and whose single primary action is
  `Check out` (or `Resolve fulfillment` when not ready), secondary `Keep
  shopping`. The optimization "Use lower fulfillment" path stays a secondary
  action, not a second primary.

### 5.2 Checkout start / readiness (`routes/checkout-start.tsx`)

- **Frame:** `Page` → `PageHeader` → `CheckoutFlowShell`.
- **Main:** `OrderIntentSummary` (when buy-now/offer source) then the account
  choice: guest (`TextInput` name/email + one primary `Continue as guest`) and/or
  account sign-in (secondary). Recovery/sign-in messaging via a single `Banner`.
- **Summary (`desktopSummary` + `mobileSummary`):** the readiness-state totals
  primitive — facts (source, seller, price, quantity, account, payment) + a status
  total labeled `Checkout status` = `Ready`, with `OrderProtectionModule` below.
  Use `CheckoutReadinessPrompt` for the "ready to start" prompt.
- **Express lane:** if accelerated saved payment is available, `CheckoutExpressActions`
  (express path) above the `OR` divider, standard path below.

### 5.3 Checkout steps (`features/sessions/ui/checkout-page.tsx`)

- **Frame:** `Page` → `PageHeader` → `CheckoutFlowShell` (`main` = step stack,
  `desktopSummary` = order summary + totals, `mobileSummary` =
  `CheckoutMobileSummaryDisclosure`, `stickyAction` = `CheckoutStickyActionBar`).
- **Step indicator:** a single `PageStepper` at the top of `main` with
  contact / delivery / shipping / payment / review steps
  (`status: complete|current|upcoming|blocked`). It replaces the implicit
  ordering and gives the flow a visible spine.
- **Saved (returning buyer):** completed steps compress into
  `CheckoutSavedInfoGroup` / `CheckoutSavedInfoRow` (icon, label, value,
  supporting text, one `success` status, one secondary `Edit` action). One row
  per step; editing a row expands exactly that step.
- **Each editable step** is a `CheckoutFormSection` inside a `Surface elevated`
  (add `glow` only to the single focused step — contact or payment):

  | Step       | Content (DS primitives)                                                                 |
  | ---------- | -------------------------------------------------------------------------------------- |
  | Contact    | `TextInput` email (+ optional marketing `Checkbox`). `glow` while focused.              |
  | Delivery   | optional saved-address `NativeSelect`; address `Grid` of `TextInput`s; `ProgressiveDisclosure` for address-book prefs. |
  | Shipping   | `NativeSelect` shipping option + one `CheckoutStateNotice`/`MarketplaceNotice` delivery estimate. |
  | Payment    | `NativeSelect` method, optional saved-instrument `NativeSelect`, save `Checkbox`; one notice for quote state. `glow` while focused. |
  | Review     | the order summary + totals (in the summary column) + the single commit action.         |

- **Commit:** one primary `Button` (`Update totals` when a re-quote is needed,
  else `Pay now` / `Pay now with saved payment`); secondary `Back to cart`. The
  in-form action row and the `CheckoutStickyActionBar` share the same single
  primary (same `form` target) — they are one action rendered responsively, not
  two primaries.
- **Summary column:** order line items (`CheckoutSummaryLineItem`) + totals
  primitive (single-deferred-total model) + `OrderProtectionModule`.

### 5.4 Confirmation (`routes/buy-checkout-confirmation.tsx` → `buy-checkout-confirmation-page.tsx`)

- **Frame:** `Page` → `PageHeader` → single focused column.
- **Body:** `CheckoutConfirmationPanel` (tone `success`, `padding={5}`): status
  title, description, reference + support-reference rows, `Total` row, up to three
  `nextSteps` (payment handoff / fulfillment pending / support reference), and one
  primary action `Continue to payment`.
- **Discipline:** distinguish pending Checkout activity from committed downstream
  facts; no fake completion; no second card stack.

### 5.5 Recovery (`features/sessions/ui/checkout-recovery-page.tsx`)

- Keep `MarketplaceEmptyState` inside a `PageSection`; customer-safe language;
  no-side-effect trust cue; primary + secondary `LinkButton`. Preserve the live
  region for auto-revalidation. This surface is already minimal — align tone and
  spacing tokens only, no structural change.

---

## 6. DS primitive gap list

Actionable checklist for the two downstream DS issues. Each item is a primitive
ADD or REFINE in `@chase-sets/design-system`. **No bounded-context overrides** —
if a need isn't met here, it is added here.

### For #1852 — canonical `QuantityStepper` + suppress native number spinners

Today the cart composes `NumberInput` (which is `TextInput type="number"
inputMode="numeric"` in `forms/text-input.tsx`) **plus** two separate `Button`s
**plus** a submit `Button`. `NumberInput` renders the browser's native number
spinner chevrons, which then sit _on top of_ the custom −/+ buttons — a doubled,
misaligned stepper. A custom stepper (`NumberField` in `forms/number-field.tsx`,
built on `@base-ui/react` with −/+ controls) already exists but the cart does not
use it.

- [ ] **Add `QuantityStepper`** as the canonical quantity control: an integer
      stepper with −/+ controls and a centered editable value, `min`/`max`/`step`,
      `value`/`onValueChange`, accessible `decrementLabel`/`incrementLabel`, a
      `label` (visually hidden when needed), and `loading`/`disabled` for
      optimistic pending state. Build on the existing `NumberField` base; expose a
      compact `size`. One control replaces the input + two buttons + submit.
- [ ] **Suppress native spinner chevrons** wherever `type="number"` is rendered
      (`NumberInput`, `CurrencyInput`, and the `QuantityStepper` field): add the
      canonical control CSS to hide `::-webkit-inner-spin-button`,
      `::-webkit-outer-spin-button`, and Firefox `-moz-appearance: textfield`
      (i.e. `appearance: none`). This belongs in DS control styling, not a
      consumer.
- [ ] **Document** that consumers use `QuantityStepper` for quantity and never
      hand-assemble a number input + buttons.
- [ ] **Tests:** stepper clamps to `min`, fires `onValueChange`, exposes accessible
      labels, and renders **no** native spinner affordance (extend
      `__tests__/primitive-gaps.test.tsx`).

### For #1853 — totals, sticky bar / secure indicator, line-item image, action helpers

**Totals for the single-deferred-total model.** Today `PriceBreakdown`,
`CheckoutTotals`, and `CheckoutSummaryLineItem` accept a free-form `total` /
per-line `value`, which let the cart pass `"Price at checkout"` into every slot.

- [ ] **Refine the totals primitives** (`PriceBreakdown` / `CheckoutTotals`) to
      first-class the single-deferred-total model: an explicit `totalLabel`
      (`Estimated total` / `Total` / `Payable total`), a single optional
      `totalCaption` slot for the **one** deferral statement
      (`Final total confirmed at checkout`), and a `deferred`/`pending` flag that
      renders an indicative or `Pending` total in the canonical quiet style.
      Goal: it is hard to express the "repeat the deferral string in five slots"
      anti-pattern.
- [ ] **`CheckoutSummaryLineItem` indicative price:** support an `indicative`
      flag / `from` affordance so a line can show `from $X` with the
      `tabular-nums` price slot, plus a quiet `Priced at checkout` state — without
      consumers styling it.
- [ ] **Graceful line-item image placeholder.** `CheckoutSummaryLineItem`
      currently renders a raw `<img>` or, when no image, a static `Icon name="image"`
      span — the slot reads blank/jarring while loading or when absent. Route its
      thumbnail through the canonical `Image` primitive (which already has skeleton
      + fallback + `loading="lazy"`, per `primitive-gaps.test.tsx`) and add a
      designed empty/placeholder state. Apply the same to `MarketplaceCartLineItem`.
- [ ] **`StickyCtaBar` + `CheckoutStickyActionBar`:** unify the two sticky-bar
      primitives' API (both already carry `data-primary-action-count="1"`). Ensure
      a `totalLabel`/`total`/`context` triple, single-primary contract, and
      consistent backdrop/elevation tokens. Confirm `SecurePaymentIndicator`
      reads as the canonical reassurance slot in both bars and the totals
      `reassurance` slot.
- [ ] **Action-hierarchy helpers.** Make "one primary per surface" enforceable,
      not just conventional:
  - [ ] An `ActionRow` / `ActionStack` primitive that stamps
        `data-primary-action-count` and arranges primary + secondary +
        low-emphasis with the correct order and spacing.
  - [ ] A low-emphasis **destructive-but-non-blocking** affordance (e.g. a
        documented `Button tone="ghost"` recipe, or a `DestructiveAction` helper)
        so consumers stop reaching for `tone="danger"` on routine Remove. Danger
        stays for blocking confirmations only.
  - [ ] A lint/test guard (extend the existing
        `data-primary-action-count` assertions in
        `__tests__/design-system-marketplace.test.tsx`) so a surface with more
        than one primary fails.
- [ ] **Single-notice helper.** A small `CheckoutNoticeStack` (or documented
      pattern) that takes prioritized notices and renders **one** — encoding the
      §4 priority ladder so checkout stops stacking notices.

---

## Acceptance signals (for downstream surface issues)

- Cart shows indicative `from` prices and exactly **one** deferred value labeled
  `Estimated total`; the string `"Price at checkout"` appears **zero** times.
- Each line: one quantity stepper (no native spinner, no doubled buttons), one
  readiness badge, one inline resolving action, a ghost (non-danger) Remove.
- Each surface has exactly one primary action (`data-primary-action-count="1"`).
- Each status is stated once at one altitude; at most one banner and one notice
  visible at a time.
- Every surface composes from DS primitives only — zero custom overrides — using
  the tokens named above.
