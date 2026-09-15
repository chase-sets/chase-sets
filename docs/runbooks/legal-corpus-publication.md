# Legal Corpus Publication

This is an operator procedure, not approval to publish or activate. The checked-in seven policy artifacts remain pending counsel review. A syntactically valid approval reference is necessary but never sufficient legal evidence. No environment variable, seed, payout attestation, or synthetic test supplies approval.

## Approved Publication

1. Before editing source, obtain attributable counsel approval tied to the exact reviewed content/version or the existing offline legal packet. Counsel must dispose metadata and every rendered operative section, not just required subjects, including canonical unresolved disclosures, assumptions and additional copy. Keep privileged advice outside the repository. Use the existing Public Presence legal packet/corpus tooling; do not create a second packet owner.
2. Confirm approved final wording matches actual shipped product behavior. Resolve material product changes through their behavior owner before making the legal promise effective. For Terms, retain explicit disposition of notice email, governing law, and the unratified injunctive-relief carveout. Adjacent rulings are not approval of those claims.
3. Edit only the approved artifact: exact version, `published`, valid UTC `effectiveAt`, genuine non-placeholder non-privileged `counselApprovalReference`, reviewed rollout/product limits, and `counsel-approved` operative sections. Run `pnpm --filter @chase-sets/public-presence run compile:public-policies` and its `check:public-policies`. The content fingerprint covers operative copy. The per-artifact registry pin still constrains all pending siblings; do not relax it globally.
4. Merge and deploy through the normal authorized process. Before activation, capture the exact source/compiled fingerprint, deployed commit/image, canonical rendered metadata and effective posture at the public route. Confirm serving builds converge; do not activate against pending, stale, mixed or withdrawn content. Structural readiness is not counsel approval.

## Document And Activation

Use the existing policy console to create/revise the mapped document, with value `{ "version": "<approved-vN>" }`. The closed mappings are Terms of Service, Privacy Policy, Seller Agreement and Payments Terms to `identity.<policy-key>-active-version`. Legacy `terms` and non-consent keys are rejected. Capture the document id from the console; editing it is not activation.

Sign in with `platform-policy.manage` and authenticate within the preceding 15 minutes. The exact boundary is inclusive; missing, invalid, future and older authentication fail closed. Actor, account, tenant and audit attribution come from the authenticated request, never the JSON body. Use the existing authenticated HTTP session and protected Identity mount, not a GET link, seed or SQL write. Do not record session cookies/tokens in evidence.

For Terms the mounted URLs are:

```text
POST /api/identity/admin/consents/terms-of-service/activate
POST /api/identity/admin/consents/terms-of-service/deactivate
```

Activation JSON contains exactly these three fields, populated from the approved deployed record and matching document:

```json
{"version":"<approved-vN>","documentId":"<document-id>","contentFingerprint":"sha256:<compiled-64-lowercase-hex>"}
```

These placeholders are not executable approval data. For the other consent keys, replace only `terms-of-service` in the URL. No additional activation editor or async workflow is provided by the console's runbook link.

The API checks compiled activatability and exact key/version/fingerprint, then folds the authoritative document stream and guards its version in the same transaction as the activation append. It never uses the console projection as authority. Idempotent registration happens after validation; interruption may leave registered/never-activated, not active. An exact active version/document repeat appends nothing; changed version or document replaces activation. Both streams are bounded to fewer than 10,000 replayed events. Missing atomic append fails closed.

Capture request key/version/document/fingerprint, redacted actor permission and recent-auth fact, request/response time, response authority stream/revision and exact deployment. Read back the canonical activation response and authenticated `GET /api/identity/consents/terms-of-service` required version. This proves authority resolution, not account affirmation or checkout.

## Refusals And Retry

`authentication_required`, `actor_context_mismatch`, `permission_required` and `recent_authentication_required` distinguish authorization failures. `invalid_policy_key`, `invalid_activation_input` and `invalid_deactivation_input` reject malformed requests without writing. Publication failures are `publication_not_activatable`, `publication_key_mismatch`, `publication_version_mismatch` and `publication_fingerprint_mismatch`.

Document failures are `document_not_found`, `document_policy_mismatch`, `document_invalid` and `document_version_mismatch`. `activation_concurrency_conflict` requires rereading the document, publication and authority before retry, never blindly retrying stale data. `atomic_append_unavailable`, `history_too_long` and `activation_unavailable` require investigation, not a bypass. Authority lifecycle errors such as `invalid_transition` remain explicit. Do not weaken tests or timeouts to obtain an activation.

## Re-Prompt And Version Change

After real activation, the owning operator outcome still requires a real account to review the identified displayed version/content, affirm it, and produce correlated acceptance and checkout balance-credit evidence, including the prior missing-acceptance refusal. API-only acceptance is not display/affirmation proof. An activation change during affirmation must cause re-review/retry rather than recording unseen terms; the held authenticated reacceptance/display-binding work is not supplied by these mechanics or by registration UI. Counsel returning alone cannot complete that outcome.

A material change requires a new approved monotonically increasing `vN`, compilation/deployment/readback and explicit reactivation. A newer eligible publication against the old authority remains `publication-activation-version-mismatch`; document revision or old acceptance is not activation. Capture the mismatch interval. No silent downgrade is rollback.

## Rollback

Send exactly `{}` to the authenticated deactivation URL. The same permission and recent-auth gates apply, but publication validity and document matching do not: rollback remains available when publication is withdrawn or the document has changed. Active becomes inactive; a non-active key returns `invalid_transition`. Terms resolution fails closed even with retained acceptance facts. Do not delete authority events or Consents. Reactivation requires the current approved publication and matching guarded document again.

Record real rollback/version-bump evidence on the existing operator outcome when exercised. Real counsel, staging publication/activation, first re-prompt and wallet proof remain on their existing owners; synthetic mechanics substitute for none of them. Production activation needs its own authorized operator window.
