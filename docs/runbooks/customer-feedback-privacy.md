# Customer Feedback Privacy Operations

The policy source is [Customer Feedback Privacy and Retention Policy](../../bounded-contexts/customer-feedback/docs/privacy-and-retention.md). Operators need the narrow capability for each action; security audit access never grants comment access.

## Retention

1. Start a `preview` retention run with a batch limit no greater than 500.
2. Review scanned, eligible, held, and error counts. Investigate unexpected holds or errors before execution.
3. Start `execute` with a new run id, then resume with that run id until the state is `completed`.
4. If a run is already active, do not bypass the advisory lock. Wait for the active batch to finish and inspect its recorded counters.
5. For partial failures, retain the run record, investigate the affected stream, and start a new preview. Redaction commands are idempotent.

The shared artifact sweep physically deletes expired export artifacts. Fetch authorization and expiry checks fail closed even before the sweep runs.

## Accidental sensitive feedback

1. Stop comment access and follow-up for the affected response if exposure may continue.
2. Place a privacy hold only when legal or incident preservation requires it; otherwise issue an `all-sensitive` redaction with a concise content-free reason.
3. Confirm the invitation detail is masked, the related case is marked redacted, pending follow-up is suppressed, and search/cache rebuilds have completed.
4. Confirm replay from the authoritative store ends in the same masked state before restoring traffic.
5. Record incident references in the external incident system, not in the customer comment or redaction reason.

## Export leakage

1. Record the export id, actor, normalized filter summary, row count, and expiry without copying artifact contents.
2. Disable the actor's export capability and delete the artifact row if immediate invalidation is required.
3. Identify recipients through the incident system, rotate any exposed access path, and verify attempts by another actor or after expiry return not found.
4. Preserve the content-free export and access audit. Never attach the leaked CSV to tickets, chat, logs, or evidence packets.

## Stuck retention

1. Inspect the run state, cursor, counters, and active database session holding the Customer Feedback retention advisory lock.
2. Do not terminate a healthy active batch. If its process is gone, confirm the session lock released and resume with the same run id.
3. Investigate held rows separately; a hold must be released by an authorized actor with a reason before another preview.
4. For repeated command errors, verify projection convergence and stream replay before retrying. Do not mask projection rows without the authoritative redaction fact.

## Failed redaction propagation

1. Disable sensitive reads, exports, follow-up delivery, and case notifications for the affected response.
2. Compare the invitation-stream end position with the invitation and case projection checkpoints.
3. Retry the existing projection/reaction groups. The same redaction idempotency key is safe to retry.
4. Rebuild projections from the authoritative store and confirm comment, direct identifier, consent applicability, case follow-up, and export paths remain masked.
5. Restore delivery only after all replicas and caches have converged. A backup restore is not readable until replay includes every redaction fact.
