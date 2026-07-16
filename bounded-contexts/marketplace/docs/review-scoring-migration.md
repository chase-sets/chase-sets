# Review Scoring Migration

Marketplace publishes one directional scoring fact per Order from the complete Support request history. The `resolution-aware-v1` policy includes a rating only for normal completion or when the reviewed party is authoritatively responsible. Carrier, platform, shared, undetermined, unrecognized, and legacy unattributed resolution facts are Context-only. Remedy names and refund amounts are never policy inputs.

## Historical rebuild

Deployment rebuilds these projection revisions from authoritative events:

- `marketplace-review-projection` revision 2;
- `marketplace-identity-account-projection` revision 2;
- `checkout-seller-accounts-projection` revision 2;
- `discovery-market-projection` revision 2;
- `settlement-account-risk-source-projection` revision 2.

The scoring reaction replays Support lifecycle streams into order-keyed Marketplace scoring streams. Source stream versions make repeated or reordered Support delivery a no-op. Projection checkpoints and per-row scoring stream versions make fact delivery restartable. Recalculation always derives counters from review rows instead of applying increments or decrements.

Old review submissions with no resolution context remain Included, preserving their existing rating impact. Replayed authoritative responsibility facts then replace that default. A legacy resolution without responsibility becomes Context-only and records `responsibility-missing`; an unknown responsibility or policy version becomes Context-only and records an unrecognized operational signal. Review content is retained.

## Dry run and invariant report

Use a disposable database restored from a representative snapshot. Record these counts before rebuilding:

- publishable reviews by author role;
- ratings included by author role;
- Context-only reviews by reason code;
- held, pending, withdrawn, and moderated reviews;
- scoring rows with an operational signal.

Run projection replay with the platform projection operations tooling in report or dry-run mode for each affected group, then execute the rebuild. Compare the same counts afterward. Publishable review totals must not change. Ordinary completed reviews must retain their included count. Any reduction in included ratings must be attributable to an authoritative non-subject responsibility, an open hold, or a fail-safe legacy/unknown fact. The canonical Marketplace summary and every consumer summary must agree by account and role.

Capture the representative rebuild estimate before cutover with:

```sh
pnpm run replay:projection -- platform-api benchmark --all --out artifacts/release-health/review-scoring-projection-rebuild.json
```

The benchmark report is the non-mutating operational evidence for projected event counts, estimated duration, and readiness. Execute revision rebuilds only through the projection operations control plane after reviewing that artifact.

## Retry and rollback

A failed rebuild is safe to retry from the last checkpoint or from an empty owned-table generation. Replaying Support facts cannot append a duplicate disposition event for the same source version, and recomputation cannot double-add or double-remove a rating.

Rollback restores the prior application version and prior projection revision checkpoints; it does not delete scoring events or review content. If a new projection generation has not been promoted, discard that generation. If it has been promoted, rebuild the prior revision into a new generation before cutover. Keep the new scoring streams for audit and forward replay. Never repair rating impact by editing review rows or inferring responsibility from a refund, return, damage flow, or resolution label.
