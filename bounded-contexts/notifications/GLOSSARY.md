# Notifications Domain Glossary

This glossary defines the canonical terminology for the Notifications bounded context.

## Notification Center

A **Notification Center** is the account-level surface for reviewing recent marketplace updates and simple notification actions.

Notes:

- Notification Center is owned by Notifications.
- The marketplace Notification Center is presented as a side sheet on desktop and a bottom sheet on mobile from the shell.
- It owns feed read state, unread counts, and mark-read actions.

## Notification Feed Item

A **Notification Feed Item** is a projected account-visible update shown in the Notification Center.

Notes:

- Notification Feed Items are owned by Notifications.
- Feed Items are created from source-context facts and notification policy decisions.
- Feed Items may link back to source-context workflows, but they do not own those workflows.

## Notification Preference

A **Notification Preference** is an account-level setting that controls notification delivery or notification-center behavior.

Notes:

- Notification Preferences are owned by Notifications.
- Preferences may control channels, categories, quieting, suppression, or future frequency rules.
- Preferences do not redefine source-context business rules such as Product Alert match criteria.

## Notification Category

A **Notification Category** classifies delivery policy independently from message wording.

Notes:

- `security`, `order-critical`, and `legal` categories are mandatory.
- `operational` and `product-alerts` categories are suppressible by Notification Preferences.
- Message criticality supplies the default category: security maps to `security`, commerce maps to
  `order-critical`, and operational maps to `operational`.

## Mandatory Notification

A **Mandatory Notification** is a security, order-critical, or legal notification that must reach
its recipient through its requested channel even when that channel is disabled in preferences.

## Suppressible Notification

A **Suppressible Notification** is an operational or Product Alert notification whose channel
delivery may be removed by the recipient's current Notification Preferences. Preference resolution
happens at the shared outbox dispatcher immediately before adapter delivery.

## Recipient Account

A **Recipient Account** is the account whose Notification Preferences govern a notification. The
recipient account is carried on the outbound message when known; anonymous messages have no
recipient account and therefore have no account-level opt-out to apply.

## Notification Delivery Report

A **Notification Delivery Report** is the durable, minimal fact Notifications
publishes after an attempted channel delivery. It identifies the source workflow
by stable reference and records sent, failed, suppressed, or retry-exhausted
outcomes without copying message bodies or contact details.

## Customer Feedback

**Customer Feedback** is the source-context event noun used when Notifications
reports delivery outcomes for feedback attention, digests, and consented
follow-up. Notifications owns delivery only; Customer Feedback retains case and
consent authority.
