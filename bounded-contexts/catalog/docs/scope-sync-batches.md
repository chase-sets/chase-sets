# Scope Sync Batches

A Scope Sync Batch lets a Catalog operator preview and execute Scope Sync across explicit Catalog Scope Record ids or a server-resolved matching scope. The browser submits selection intent; Catalog resolves the complete eligible set without paging through the admin list.

## Preview and confirmation

Matching-scope preview includes active Catalog Scope Records; an explicitly selected inactive record remains visible as a blocker. Only accepted or auto-accepted Provider Scope Mappings participate. Each record is passed through the same provider participation planner used by individual Scope Sync. The resulting evidence includes Scope Record and mapping versions, active profile/unit versions, rollout and credential readiness, provider transport blockers, provider-unit totals, and request or credit estimates.

Catalog hashes selection, budgets, scope and mapping versions, profile/unit versions, and the complete participation previews into a plan fingerprint. Confirmation repeats resolution and rejects a changed fingerprint. Missing Scrydex usage or credit evidence and a configured credited-provider request limit are independent fail-closed controls.

## Durable execution

One durable batch unit represents one Catalog Scope Record. A leased worker turn claims no more than the configured bounded number of units and delegates each to the existing Scope Sync Run. The batch stores only the Scope Run id and support-safe outcome; provider jobs, profiles, payload outcomes, retry behavior, and settled-unit freshness remain authoritative in the existing per-scope workflow.

Running units are reconciled from their Scope Sync Runs after restart. A failure marks only its scope unit failed. Cancel prevents new work and cancels active child imports when possible; resume requeues only cancelled work; per-unit retry requeues only the selected failed unit. Completed units are never reset by recovery commands.

Provider concurrency, provider request limits, and credited-provider request limits are configured independently. The worker admits a scope unit only when every provider involved has capacity. Repeated provider failures open the batch circuit at the configured threshold, leaving remaining queued work durable for operator recovery.

If confirmation finds a completed batch with the same account, operator, and plan fingerprint, it returns that settled batch as a fast no-op. Existing Scope Sync Run freshness policy remains the authority for provider-unit fast-forward.

Batch summaries expose ids, state, counts, profile/mapping versions, bounded samples, estimates, and redacted diagnostics. They do not expose provider payloads, URLs, credentials, account identifiers, or paid-provider usage bodies.
