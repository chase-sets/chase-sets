# Production Destructive Change Approval

Approval state: active
Approval reference: https://github.com/chase-sets/chase-sets/issues/4055#issuecomment-5016949564
Reviewed on: 2026-07-19
Owner: todd.skelton@chasesets.com
Plan fingerprint: sha256:6eefaf301867bc08a35bbca0e5b9a68874eaabd2c0970239f2b30e15212cdf29

## Approved Destructive Changes

- `digitalocean_app.platform`

## Current State

This approval is limited to the reviewed retirement of the DigitalOcean App Platform
application from the staging and production platform states. Any different fingerprint or
destructive resource address must fail closed.

The two inert production `terraform_data` cutover markers are intentionally excluded from
the infrastructure-delete fingerprint. Retained staging and production DNS delete-sets
must remain empty.

## Active Approval Format

Use this shape only for a reviewed pending production plan:

```markdown
Approval state: active
Approval reference: <issue-or-pr-comment>
Reviewed on: <yyyy-mm-dd>
Owner: <approver-email>
Plan fingerprint: sha256:<fingerprint from the failed destructive-plan check>

## Approved Destructive Changes

- `<exact Terraform resource address>`
```
