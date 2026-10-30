# Runbook: take an issue back from the platform loop

This procedure returns one issue from the platform loop to the host product
loop. It does not roll back a milestone, stop a platform process, or change
milestone metadata.

Evidence from the 2026-09-29 and 2026-09-30 drills is recorded in
[platform-loop-rollback-evidence.md](platform-loop-rollback-evidence.md).
The record is explicitly **NOT EXERCISED** because neither drill performed a
per-issue take-back.

## Take-back

1. Post the authorized take-back comment on the issue.
2. Add the `dispatch:platform-return` label.
3. Remove the `dispatch:platform` label.
4. Wait until `dispatch:platform-return` is gone. The platform loop removes it
   after acknowledging the return. When no platform run holds the issue, the
   controller loop removes it after any queued platform pull request is
   dequeued.
5. Deliver the issue normally. If an open platform pull request exists, adopt
   it only after an exact-head independent review, or close it and redispatch.

The handoff and comment details are defined by the orchestrator guidance and the
controller handoff file; this runbook intentionally does not duplicate their
comment schema or timing rules.
