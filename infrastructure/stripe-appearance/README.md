# Embedded Stripe Appearance

Stripe owns the default appearance of its embedded Elements, Checkout Elements,
Connect onboarding and management components, and notification banner. Chase Sets
omits custom appearance configuration on initialization and updates. No
Stripe-consumed Ink & Foil appearance or palette token ships.

The former browser appearance adapter and its qualification probes are retired.
Application theme changes do not update or remount Stripe for appearance alone.
Payments and Settlement still own their functional sessions, retries, deadlines,
confirmation, callbacks and teardown.

## Provider Boundary

Chase Sets hosts embedded components in design-system chrome. Its app palette,
typography and neutral `embedded-surface-theme/v1` contract remain application
concerns, not a promise of provider theme parity.

Stripe retains secure card, wallet, Link, payout destination, identity, tax and
document collection; authentication handoffs; validation timing and copy; and
internal iframe layout, focus and loading behavior. Do not access iframe internals,
inject CSS, duplicate provider validation, or replace secure collection with
custom forms for visual parity.
