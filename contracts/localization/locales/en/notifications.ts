export const notificationsEnglishTranslations = {
  "notifications.api.authentication.required": "Authentication required.",
  "notifications.api.email.webhook.failed": "Email webhook failed.",
  "notifications.api.forbidden": "Forbidden.",
  "notifications.api.mobile.webhook.failed": "Mobile message webhook failed.",
  "notifications.api.preference.invalid": "Notification preference is not supported.",
  "notifications.features.notificationCenter.ui.shell.open": "Open",
  "notifications.features.notificationCenter.ui.shell.preference.email.description":
    "Allow email delivery for eligible marketplace updates.",
  "notifications.features.notificationCenter.ui.shell.preference.email.label": "Email notifications",
  "notifications.features.notificationCenter.ui.shell.preference.productAlerts.description":
    "Notify this account when watched products match alert rules.",
  "notifications.features.notificationCenter.ui.shell.preference.productAlerts.label": "Product alerts",
  "notifications.features.notificationCenter.ui.shell.preference.web.description":
    "Show marketplace updates in the notification center.",
  "notifications.features.notificationCenter.ui.shell.preference.web.label": "In-app notifications",
  "notifications.features.notificationCenter.ui.shell.productAlerts.listings.allNewMatches":
    "Listings - all new matches",
  "notifications.features.notificationCenter.ui.shell.productAlerts.listings.atOrBelow":
    "Listings - at or below ${amount}",
  "notifications.features.notificationCenter.ui.shell.productAlerts.offers.allNewMatches": "Offers - all new matches",
  "notifications.features.notificationCenter.ui.shell.productAlerts.offers.atOrAbove": "Offers - at or above ${amount}",
  "notifications.features.notificationCenter.ui.shell.source.inventory": "Inventory",
  "notifications.features.notificationCenter.ui.shell.source.marketplace": "Marketplace",
  "notifications.features.notificationCenter.ui.shell.source.orders": "Orders",
  "notifications.features.notificationCenter.ui.shell.source.productAlerts": "Product alerts",
  "notifications.features.notificationCenter.ui.shell.source.shipments": "Shipments",
  "notifications.intents.restockDecisionPending.body":
    "{quantity} returned units need a restock or write-off decision.",
  "notifications.intents.restockDecisionPending.title": "Restock decision pending for order {orderReference}",
  "notifications.intents.saleRecorded.body": "{quantity} units across {lineCount} lines were recorded as sold.",
  "notifications.intents.saleRecorded.title": "Sale recorded for order {orderReference}",
  "notifications.intents.stockCommitted.body": "{quantity} units across {lineCount} lines are committed to this sale.",
  "notifications.intents.stockCommitted.title": "Stock committed for order {orderReference}",
  "notifications.intents.stockReturned.body.orderCancelled":
    "{quantity} units across {lineCount} lines returned to available stock after the order was cancelled.",
  "notifications.intents.stockReturned.body.paymentDeadline":
    "{quantity} units across {lineCount} lines returned to available stock after the payment deadline passed.",
  "notifications.intents.stockReturned.title": "Stock returned for order {orderReference}",
  "notifications.routes.accountNotifications.description": "Review marketplace updates from the notification center.",
  "notifications.routes.accountNotifications.title": "Notifications | Marketplace",
} as const;
