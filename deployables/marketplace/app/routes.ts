import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  route("favicon.ico", "routes/favicon.ts"),
  route(
    ".well-known/appspecific/com.chrome.devtools.json",
    "routes/chrome-devtools.ts",
  ),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    route("search", "routes/search.tsx"),
    route("items/:id", "routes/item-detail.tsx"),
    route("sign-in", "routes/sign-in.tsx"),
    route("register", "routes/register.tsx"),
    route("account/select", "routes/account-select.tsx"),
    route("account", "routes/account.tsx"),
    route("account/inventory", "routes/account-inventory.tsx"),
    route("account/inventory/records/:recordId", "routes/account-inventory-record.tsx"),
    route("account/inventory/locations", "routes/account-inventory-locations.tsx"),
    route("account/offers", "routes/account-offers.tsx"),
    route("account/offers/:offerId", "routes/account-offer.tsx"),
    route("account/listings", "routes/account-listings.tsx"),
    route("account/listings/:listingId", "routes/account-listing.tsx"),
    route("account/market-offers", "routes/account-market-offers.tsx"),
    route("account/market-offers/:offerId", "routes/account-market-offer.tsx"),
    route("account/team", "routes/account-team.tsx"),
    route("account/security", "routes/account-security.tsx"),
    route("account/consents", "routes/account-consents.tsx"),
  ]),
] satisfies RouteConfig;
