// The system these specs run against. The Corten marketplace browser gate sets
// CHASE_SETS_BROWSER_E2E_SYSTEM=corten-marketplace; a test that reads marketplace-web's own DOM
// shape is skipped there with the reason it differs.
export const onCortenMarketplace = process.env.CHASE_SETS_BROWSER_E2E_SYSTEM === "corten-marketplace";
