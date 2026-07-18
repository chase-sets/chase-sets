# Production Destructive Change Approval

Approval state: active
Approval reference: #5574 + Todd 2026-07-18 standing retry grant (Phase B2c for #4053)
Reviewed on: 2026-07-18
Owner: Platform Operations
Plan fingerprint: sha256:692539e7511fb7339e40c58120900ed89799367ab9e9220520f3c7d2d231eaa1

## Approved Destructive Changes

- `digitalocean_app.platform.domain["chasesets.com"]`
- `digitalocean_app.platform.domain["www.chasesets.com"]`
- `digitalocean_app.platform.domain["admin.chasesets.com"]`

Nested App Platform domain releases are enumerated by the plan inspector as
`digitalocean_app.platform.domain["<hostname>"]` and must be pinned individually alongside
any Terraform resources deleted by the same serving swap.

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
