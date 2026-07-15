# Customer Feedback Privacy and Retention Policy

Policy version: `customer-feedback-privacy.v1`

Customer Feedback owns this policy and its behavior. The implementation uses irreversible, attributed redaction facts plus projection masking. It does not introduce a platform-wide privacy framework or cryptographic erasure.

## Classification and retention

| Data class | Examples | Retention | Action and clock |
| --- | --- | --- | --- |
| Response content | Customer comment | 365 days | Redact from submission time |
| Direct identifiers | Account, source entity, correlation, consent subject, idempotency references | 365 days | Redact from submission time |
| Invitation diagnostics | Sampling and suppression diagnostics | 90 days | Redact from creation time |
| Operator notes | Attributed case notes and sensitive work references | 365 days | Redact from case closure |
| Delivery artifacts | Follow-up provider payloads and retry artifacts | 30 days | Delete from creation time |
| Export artifacts | Generated CSV | 24 hours | Delete from creation time; fetch also fails closed at expiry |
| Structural audit | Actor, capability, action, scope, reason, result, timestamps and content-free counts | 2,555 days | Retain, then delete |

The executable schedule is `features/privacy/domain/policy.ts`. A policy change requires a new version; it never silently changes the meaning of an earlier redaction or audit fact.

## Durable representation and replay

The authoritative stream retains the original event bytes and appends `customer-feedback.response.redacted`. This residual immutable history is acceptable because the event store is an encrypted, access-restricted recovery record; application reads never expose raw event payloads. The redaction fact retains only invitation identity, scope, policy version, actor, reason, idempotency key, and time.

A full replay applies earlier response facts and then the irreversible redaction fact. The final invitation projection clears comments and consent/contact identifiers, replaces source/account/idempotency references with deterministic redacted markers where a structural join must remain, and removes the public redemption reference. The case reaction appends its own response-redacted fact, withdraws follow-up applicability, cancels pending contact, and masks case projection identifiers. Analytics retain only the rating and non-identifying metric dimensions. Attention, dashboards, exports, notifications, and linked cases never copy comment content.

Backups can contain pre-redaction event bytes until encrypted backup expiry. Restores must replay through the current end position before reads or delivery workers are enabled. Caches and search indexes must derive only from masked projections, use no customer comment as a key or label, and be purged/rebuilt after a redaction incident. Logs, traces, metrics, URLs, notification facts, and error details must contain structural ids and safe reason codes only. Generated exports are stored separately from their content-free audit record and cannot be fetched after expiry or by another actor.

## Holds and commands

Redaction requires an authorized actor, stable content-free reason code, explicit scope, timestamp, and idempotency key. Repeating the key or a completed scope is a no-op. An active response privacy hold blocks redaction and retention execution. Hold placement and release require their own capability, actor, reason code, and timestamp, and both are audited. Reason codes are lowercase kebab-case and never contain customer text, email addresses, tokens, or incident narratives.

Retention execution is bounded to 1–500 invitations, uses one PostgreSQL advisory lock across a run batch, records a resumable cursor and counters, skips active holds, and supports `preview` and `execute` modes. Operators preview before execution and resume with the returned run id until the state is complete.

## Consent and access

Follow-up consent records the exact statement, version, affirmative timestamp, subject account, purpose (`case-specific-follow-up`), and applicability (`this-response-only`). Missing statement metadata, a missing affirmative timestamp, withdrawal, or response redaction means no consent. Consent never authorizes marketing.

Capabilities are deliberately separate:

- `customer-feedback.privacy.view-comments`
- `customer-feedback.privacy.export-sensitive-feedback`
- `customer-feedback.privacy.follow-up`
- `customer-feedback.privacy.redact-feedback`
- `customer-feedback.privacy.manage-feedback-holds`
- `customer-feedback.privacy.audit-feedback-privacy`

Sensitive views and exports produce content-free audit facts. Exports record the actor, capability, normalized filters, reason, row count, expiry, and success/failure. CSV cells beginning with formula-control characters are prefixed with an apostrophe, comments are excluded, and response values never enter logs, traces, or metric labels.
