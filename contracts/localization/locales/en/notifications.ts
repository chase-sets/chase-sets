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
  "notifications.intents.payoutReadinessRegression.title": "Action needed to keep payouts flowing",
  "notifications.intents.payoutReadinessRegression.body":
    "Payouts are blocked until you resolve {reason}. Deadline: {deadline}.",
  "notifications.intents.payoutReadinessRegression.noDeadline": "no deadline provided",
  "notifications.intents.saleRecorded.body": "{quantity} units across {lineCount} lines were recorded as sold.",
  "notifications.intents.saleRecorded.title": "Sale recorded for order {orderReference}",
  "notifications.intents.sellerAvailabilityRestored.title": "Your listings are live again",
  "notifications.intents.sellerAvailabilityRestored.body":
    "Your away period ended, so your listings automatically resumed and are visible to buyers again.",
  "notifications.intents.customerFeedbackAttention.title": "Customer feedback needs attention",
  "notifications.intents.customerFeedbackAttention.body":
    "A {priority}-priority CSAT response rated {rating} needs review.",
  "notifications.intents.customerFeedbackFollowUp.title": "Support follow-up requested",
  "notifications.intents.customerFeedbackFollowUp.body":
    "Chase Sets support is following up about feedback you asked us to contact you about.",
  "notifications.intents.customerFeedbackDigest.title": "Customer feedback attention digest",
  "notifications.intents.customerFeedbackDigest.body": "{count} feedback cases need attention.",
  "notifications.intents.stockCommitted.body": "{quantity} units across {lineCount} lines are committed to this sale.",
  "notifications.intents.stockCommitted.title": "Stock committed for order {orderReference}",
  "notifications.intents.stockReturned.body.orderCancelled":
    "{quantity} units across {lineCount} lines returned to available stock after the order was cancelled.",
  "notifications.intents.stockReturned.body.paymentDeadline":
    "{quantity} units across {lineCount} lines returned to available stock after the payment deadline passed.",
  "notifications.intents.stockReturned.title": "Stock returned for order {orderReference}",
  "notifications.intents.supportDispute.noDeadline": "as soon as possible",
  "notifications.intents.supportDispute.party.buyer": "buyer",
  "notifications.intents.supportDispute.party.seller": "seller",
  "notifications.intents.supportDispute.party.support": "Chase Sets support",
  "notifications.intents.supportDispute.resolution.full-refund": "full refund",
  "notifications.intents.supportDispute.resolution.partial-refund": "partial refund",
  "notifications.intents.supportDispute.resolution.return-for-refund": "return for refund",
  "notifications.intents.supportDispute.resolution.replacement": "replacement",
  "notifications.intents.supportDispute.resolution.cancel-order": "order cancellation",
  "notifications.intents.supportDispute.resolution.no-action": "no change",
  "notifications.intents.supportDispute.resolution.support-reviewed": "a support decision",
  "notifications.intents.supportDispute.openedSeller.title": "Support case opened on order {orderReference}",
  "notifications.intents.supportDispute.openedSeller.body":
    "A buyer opened a support case. Respond by {deadline} to keep it out of review.",
  "notifications.intents.supportDispute.openedBuyer.title": "We opened your support case for order {orderReference}",
  "notifications.intents.supportDispute.openedBuyer.body":
    "The seller has been asked to respond. We will let you know the moment there is an update — no action is needed right now.",
  "notifications.intents.supportDispute.responseRecorded.title": "New response on your case for order {orderReference}",
  "notifications.intents.supportDispute.responseRecorded.body":
    "The other party responded to your support case. Review it and reply.",
  "notifications.intents.supportDispute.offerRecorded.title": "You have an offer on order {orderReference}",
  "notifications.intents.supportDispute.offerRecorded.body":
    "The {offeredBy} offered you a {resolution}. Review it and accept or decline.",
  "notifications.intents.supportDispute.offerDeclined.title": "Your offer on order {orderReference} was declined",
  "notifications.intents.supportDispute.offerDeclined.body":
    "Your offer was declined and the case is still open. Respond with a new offer or let support review it.",
  "notifications.intents.supportDispute.escalated.title": "Your case for order {orderReference} went to support",
  "notifications.intents.supportDispute.escalated.body":
    "Chase Sets support is now reviewing this case. No action is needed from you while we investigate.",
  "notifications.intents.supportDispute.resolved.title": "Your case for order {orderReference} is resolved",
  "notifications.intents.supportDispute.resolved.body.agreement":
    "Both parties agreed on {outcome}. Nothing more is needed from you.",
  "notifications.intents.supportDispute.resolved.body.automated":
    "This case was resolved automatically with {outcome}. Nothing more is needed from you.",
  "notifications.intents.supportDispute.resolved.body.adjudicated":
    "Chase Sets support decided this case: {outcome}. This decision is binding and closes the case.",
  "notifications.intents.supportDispute.resolved.body.generic":
    "This case was resolved with {outcome}. Nothing more is needed from you.",
  "notifications.intents.supportDispute.cancelled.title": "Your case for order {orderReference} was cancelled",
  "notifications.intents.supportDispute.cancelled.body":
    "This support case was cancelled and closed. Nothing more is needed from you.",
  "notifications.intents.supportDispute.responseReminder.title": "Reminder: respond on order {orderReference}",
  "notifications.intents.supportDispute.responseReminder.body":
    "Your response is still needed. Respond by {deadline}, or {outcome}.",
  "notifications.intents.supportDispute.responseReminder.legacyBody":
    "Your response is still needed. Reply by {deadline} to keep the case out of review.",
  "notifications.intents.supportDispute.responseReminder.outcome.full-refund": "a full refund is applied automatically",
  "notifications.intents.supportDispute.responseReminder.outcome.partial-refund":
    "a partial refund is applied automatically",
  "notifications.intents.supportDispute.responseReminder.outcome.return-for-refund":
    "a return for refund is approved automatically",
  "notifications.intents.supportDispute.responseReminder.outcome.replacement":
    "a replacement is approved automatically",
  "notifications.intents.supportDispute.responseReminder.outcome.cancel-order": "the order is cancelled automatically",
  "notifications.intents.supportDispute.responseReminder.outcome.no-action":
    "the case closes without a change automatically",
  "notifications.intents.supportDispute.responseReminder.outcome.support-reviewed":
    "the case moves to a support decision automatically",
  "notifications.intents.supportDispute.responseReminder.outcome.supportReview":
    "the case moves to Chase Sets support review automatically",
  "notifications.intents.supportDispute.returnDelivered.title": "A return arrived for order {orderReference}",
  "notifications.intents.supportDispute.returnDelivered.body":
    "Inspect the returned item by {deadline}, or the refund releases automatically.",
  "notifications.intents.supportDispute.returnDisputed.title":
    "Return condition is under review for order {orderReference}",
  "notifications.intents.supportDispute.returnDisputed.body":
    "The seller reported a problem with the returned item's condition. Chase Sets support will review it — no action is needed from you right now.",
  "notifications.intents.supportDispute.returnRefundReleased.title":
    "Your refund is on the way for order {orderReference}",
  "notifications.intents.supportDispute.returnRefundReleased.body":
    "Your return was accepted and the refund has been released. No action is needed from you.",
  "notifications.intents.supportDispute.holdPlaced.title": "A payout is held for order {orderReference}",
  "notifications.intents.supportDispute.holdPlaced.body":
    "Your payout for this order is held while a support case is reviewed. Respond to the case to help resolve it sooner.",
  "notifications.intents.supportDispute.holdReleased.title": "Your held payout was released for order {orderReference}",
  "notifications.intents.supportDispute.holdReleased.body":
    "The support case closed without a refund, so the held funds were released back to you. No action is needed.",
  "notifications.intents.supportDispute.holdConsumed.title":
    "Held funds were used for a refund on order {orderReference}",
  "notifications.intents.supportDispute.holdConsumed.body":
    "The case resolved with a {resolution}, so the held funds were applied to the buyer's refund rather than paid out to you.",
  "notifications.routes.accountNotifications.description": "Review marketplace updates from the notification center.",
  "notifications.routes.accountNotifications.title": "Notifications | Marketplace",
} as const;
