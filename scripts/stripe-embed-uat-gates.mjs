import { readFileSync } from "node:fs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { isStripePublishableKeyForMode } from "./stripe-key-mode.mjs";

const environmentHosts = JSON.parse(readFileSync(new URL("./environment-hosts.json", import.meta.url), "utf8"));

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

/** @param {string} baseUrl @param {string} publishableKey */
export function assertStripeEmbedUatTarget(baseUrl, publishableKey) {
  if (!isStripePublishableKeyForMode(publishableKey, "test")) {
    throw new Error("Stripe embed UAT refused: STRIPE_PUBLISHABLE_KEY must be a Stripe test-mode publishable key.");
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Stripe embed UAT refused: MARKETPLACE_WEB_URL must be a valid HTTPS origin.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (productionHosts.has(hostname)) {
    throw new Error("Stripe embed UAT refused: MARKETPLACE_WEB_URL names a production host.");
  }
  // URL normalizes explicit default ports and dot segments, which are not bare origins.
  const spelling = baseUrl.trim().toLowerCase();
  if (
    !stagingMarketplaceHosts.has(url.hostname.toLowerCase()) ||
    url.protocol !== "https:" ||
    (spelling !== url.origin && spelling !== `${url.origin}/`)
  ) {
    throw new Error("Stripe embed UAT refused: MARKETPLACE_WEB_URL must be a staging marketplace HTTPS origin.");
  }
  return url.origin;
}

/** @param {string} name */
function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Stripe embed UAT requires ${name}.`);
  return value;
}

export function stripeEmbedUatGlobalSetup() {
  if (process.env.STRIPE_EMBED_UAT !== "true") return;
  const publishableKey = requiredEnv("STRIPE_PUBLISHABLE_KEY");
  const baseUrl = requiredEnv("MARKETPLACE_WEB_URL");
  assertStripeEmbedUatTarget(baseUrl, publishableKey);
  acquireHeavySlot("playwright");
}

export default stripeEmbedUatGlobalSetup;
