# Reputation Domain Glossary

This glossary defines the canonical terminology for the Reputation bounded context.

Use these terms consistently in documentation, APIs, events, and internal models.

## Review

A **Review** is the full post-transaction evaluation record one account records about another, scoped to a single order.

Notes:

- Reviews are transactional and require an `OrderId`.
- A Review contains both a Rating and optional Feedback.

## Rating

A **Rating** is the numeric score inside a review.

Notes:

- Ratings are integer values from `1` through `5`.

## Feedback

A **Feedback** is the written narrative attached to a review.

Notes:

- Feedback captures qualitative context for a Rating.

## Review Author

A **Review Author** is the account that leaves a review.

Notes:

- A Review Author is an `Account`, not a separate root entity.

## Review Subject

A **Review Subject** is the account being evaluated by a review.

Notes:

- A Review Subject is an `Account`, not a separate root entity.

## Review Eligibility

**Review Eligibility** is the rule that determines when a review may be submitted for an order.

Notes:

- Eligibility depends on completed commerce and is unlocked by delivery-complete signals by default.

## Review Summary

A **Review Summary** is the canonical aggregate snapshot for an account derived from active reviews.

Examples:

- Average rating
- Review count
- Rating distribution

## Review Status

**Review Status** is the lifecycle state of a review.

Examples:

- Active
- Withdrawn
