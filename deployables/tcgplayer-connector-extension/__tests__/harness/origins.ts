export const platformOrigin = "http://127.0.0.1:46174";
export const portalOrigin = "http://127.0.0.1:46175";
export const sentinel = "SYNTHETIC_7940_PORTAL_SENTINEL";
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
