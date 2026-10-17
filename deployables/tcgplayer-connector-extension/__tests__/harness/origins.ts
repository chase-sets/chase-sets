export const platformOrigin = "http://127.0.0.1:46174";
export const portalOrigin = "http://127.0.0.1:46175";
export const sentinel = "SYNTHETIC_7940_PORTAL_SENTINEL";
/** The captured 16-column Export From Live header (#7026), as the synthetic provider fake serves it. */
export const syntheticExportHeader = [
  "TCGplayer Id",
  "Product Line",
  "Set Name",
  "Product Name",
  "Title",
  "Number",
  "Rarity",
  "Condition",
  "TCG Market Price",
  "TCG Direct Low",
  "TCG Low Price With Shipping",
  "TCG Low Price",
  "Total Quantity",
  "Add to Quantity",
  "TCG Marketplace Price",
  "Photo URL",
] as const;
export const connectorHostRegistry = [
  {
    origin: portalOrigin,
    capture: "https://github.com/chase-sets/chase-sets/issues/7940#synthetic-loopback-fixture",
  },
];

export function assertHarnessOrigins(platform: string, hosts: readonly { origin: string }[]) {
  if (platform !== platformOrigin || hosts.length !== 1 || hosts[0]?.origin !== portalOrigin)
    throw new Error("connector-harness-origin-refused");
}
