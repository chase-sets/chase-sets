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
