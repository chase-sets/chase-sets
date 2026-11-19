/**
 * There is no dedicated saved-searches route in Discovery. The working "save this search"
 * surface is the Product alerts section of the Notifications-owned notification center
 * settings. `/account/product-alerts` (bounded-contexts/discovery/routes/account-product-alerts.tsx)
 * and its pause, resume and delete actions redirect here in one hop, so an action's write
 * receipt reaches the settings read; the retired `?notifications=settings` sheet address
 * redirects again and drops every other parameter.
 */
export const productAlertSettingsHref = "/account/notifications?view=settings&section=product-alerts";
