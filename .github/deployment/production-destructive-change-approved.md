# Production Destructive Change Approval

Approval state: no-active-approval
Approval reference: none
Reviewed on: not active
Owner: Platform Operations

## Current State

There is no active production destructive-change approval.

Any production Terraform plan containing destructive actions must fail closed until an
operator commits an active approval that names the exact destructive resource addresses and
the current plan fingerprint reported by the failed deployment check.

## Active Approval Format

Use this shape only for a reviewed pending production plan:

```markdown
Approval state: active
Approval reference: <issue-or-pr>
Reviewed on: <yyyy-mm-dd>
Owner: Platform Operations
Plan fingerprint: sha256:<fingerprint from the failed destructive-plan check>

## Approved Destructive Changes

- `<exact Terraform resource address>`
```

The retired 2026-06-12 approval for the PR #1390 context-merge resources is spent and
intentionally not carried forward as standing authorization.
