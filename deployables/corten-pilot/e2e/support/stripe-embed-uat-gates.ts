import environmentHosts from "../../../../scripts/environment-hosts.json";
import { isStripePublishableKeyForMode } from "../../../../scripts/stripe-key-mode.mjs";

const productionHosts = new Set(
  environmentHosts.hosts
    .filter(({ environment }) => environment === "production")
    .map(({ host }) => host.toLowerCase()),
);
const stagingMarketplaceHosts = new Set(
  environmentHosts.hosts
    .filter(
      ({ environment, status, host }) =>
        environment === "staging" && status === "current" && /^(marketplace|marketplace-corten)\./.test(host),
    )
    .map(({ host }) => host.toLowerCase()),
);

export function assertStripeEmbedUatTarget(baseUrl: string, publishableKey: string): string {
  if (!isStripePublishableKeyForMode(publishableKey, "test")) {
    throw new Error("Stripe embed UAT refused: STRIPE_PUBLISHABLE_KEY must be a Stripe test-mode publishable key.");
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Stripe embed UAT refused: MARKETPLACE_WEB_URL must be a valid HTTPS origin.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (productionHosts.has(hostname)) {
    throw new Error("Stripe embed UAT refused: MARKETPLACE_WEB_URL names a production host.");
  }
  if (
    !stagingMarketplaceHosts.has(url.hostname.toLowerCase()) ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Stripe embed UAT refused: MARKETPLACE_WEB_URL must be a staging marketplace HTTPS origin.");
  }
  return url.origin;
}
