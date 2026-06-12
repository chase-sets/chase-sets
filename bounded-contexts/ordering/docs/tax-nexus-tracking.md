# Tax Nexus Tracking

Tax nexus tracking is the launch-control surface for deciding when Chase Sets must start collecting sales tax in a jurisdiction.

The tracker is intentionally separate from Tax Quote calculation. Quote providers answer "how much tax for this order?" Nexus tracking answers "is Chase Sets required to register, prepare collection, or collect in this jurisdiction yet?"

## Launch Posture

Production marketplace launch does not require a sales-tax provider while Tax readiness evidence confirms no tracked jurisdiction requires collection. In that posture, order tax snapshots may remain zero-tax snapshots and `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=false`.

When a jurisdiction becomes registered for collection or otherwise collection-required, set `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true` before accepting covered orders. Platform API then fails closed until a provider-backed `TaxQuoteResolver` is composed.

## Threshold Inputs

The default Tax nexus policy is conservative:

- most state-level sales-tax jurisdictions use a `100000.00` gross-sales threshold for launch tracking;
- transaction-count thresholds are nullable because states have been removing low-dollar transaction triggers;
- Delaware, Montana, New Hampshire, and Oregon are marked no-statewide-sales-tax;
- Alaska, Colorado, and Louisiana are manual-review jurisdictions because local administration can be materially different from ordinary state-level threshold tracking.

Counsel/accounting owners should replace the default threshold policies with reviewed jurisdiction policy before launch evidence is approved. The default policy is an operational warning model, not legal advice.

## Statuses

- `monitoring`: below review bands.
- `approaching-threshold`: at or above 80% of the active threshold.
- `prepare-registration`: at or above 95%, or operations already started registration preparation.
- `registration-required`: at or above the active threshold and not registered.
- `collection-required`: at or above the active threshold and registered, but not collecting.
- `collecting`: collection is already active.
- `manual-review`: local rules are complex enough that Tax readiness needs an accountable review before relying on numeric thresholds.
- `not-applicable`: no statewide sales-tax tracking threshold applies in the default policy.

## Operating Rule

For every state and district, the Tax readiness report should track:

- current-year and previous-year gross facilitated sales;
- current-year and previous-year transaction count;
- registration status;
- collection status;
- provider-backed quote readiness;
- manual-review notes.

Use 80%, 95%, and 100% threshold progress as the operational alert bands. At 80%, assign review ownership. At 95%, prepare registration and provider/filing decisions. At 100%, do not start collection until registration, filing ownership, and provider-backed quote readiness are explicitly approved.
