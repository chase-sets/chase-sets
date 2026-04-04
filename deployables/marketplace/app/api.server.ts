import { createDiscoveryApiClient } from "@chase-sets/discovery/web";
import { createFulfillmentApiClient } from "@chase-sets/fulfillment/web";
import { createIdentityApiClient } from "@chase-sets/identity/web";
import { createInventoryApiClient } from "@chase-sets/inventory/web";
import { createMarketplaceApiClient } from "@chase-sets/marketplace-context/web";
import { createOrderingApiClient } from "@chase-sets/ordering/web";
import { createPaymentsApiClient } from "@chase-sets/payments/web";
import { createReputationApiClient } from "@chase-sets/reputation/web";
import { createSettlementApiClient } from "@chase-sets/settlement/web";
import { createForwardedAuthFetch } from "@chase-sets/identity/server";

export function getMarketplaceApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/marketplace`;
}

export function createMarketplaceServerApiClient(request: Request) {
  return createMarketplaceApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function createMarketplaceDiscoveryApiClient(request: Request) {
  return createDiscoveryApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function createMarketplaceOrderingApiClient(request: Request) {
  return createOrderingApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function createMarketplaceFulfillmentApiClient(request: Request) {
  return createFulfillmentApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function createMarketplacePaymentsApiClient(request: Request) {
  return createPaymentsApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function createMarketplaceReputationApiClient(request: Request) {
  return createReputationApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function getIdentityApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/identity`;
}

export function createMarketplaceIdentityApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: getIdentityApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function getInventoryApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/inventory`;
}

export function createMarketplaceInventoryApiClient(request: Request) {
  return createInventoryApiClient({
    baseUrl: getInventoryApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function getSettlementApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/settlement`;
}

export function createMarketplaceSettlementApiClient(request: Request) {
  return createSettlementApiClient({
    baseUrl: getSettlementApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}
