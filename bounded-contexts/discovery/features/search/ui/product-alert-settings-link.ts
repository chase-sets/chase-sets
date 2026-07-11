/**
 * There is no dedicated saved-searches route in Discovery. The working "save this search"
 * surface is the product-alerts settings view of the notification center sheet, opened via
 * query params on the marketplace shell's global route
 * (see deployables/marketplace/app/routes/layout.tsx's `notifications`/`notificationSection`
 * handling). `/account/product-alerts` (bounded-contexts/discovery/routes/account-product-alerts.tsx)
 * redirects here for direct/bookmarked visits; UI affordances should link straight to this URL
 * to avoid the extra redirect hop.
 */
export const productAlertSettingsHref = "/search?notifications=settings&notificationSection=product-alerts";
