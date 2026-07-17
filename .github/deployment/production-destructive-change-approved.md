# Production Destructive Change Approval

Approval state: active
Approval reference: #5574 (Phase B2b for #4053)
Reviewed on: 2026-07-17
Owner: Platform Operations
Plan fingerprint: sha256:dfd925eb420d5cd85238442c0c84c10e1605631ef1dcd1955bb8ca59083633e6

## Approved Destructive Changes

- `digitalocean_record.app_serving["admin"]`
- `digitalocean_record.app_serving["www"]`

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
