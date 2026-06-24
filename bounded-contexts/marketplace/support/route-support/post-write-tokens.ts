import { readCompactPostWriteToken, type PostWriteTokenStore } from "@chase-sets/http/responses";
import { resolvePostWriteTokenRequest } from "@chase-sets/platform-runtime/http";

let marketplacePostWriteTokenStoreForTests: PostWriteTokenStore | null = null;

export function configureMarketplacePostWriteTokenStoreForTests(store: PostWriteTokenStore | null) {
  const previous = marketplacePostWriteTokenStoreForTests;
  marketplacePostWriteTokenStoreForTests = store;
  return () => {
    marketplacePostWriteTokenStoreForTests = previous;
  };
}

export async function resolveMarketplacePostWriteTokenStore(): Promise<PostWriteTokenStore> {
  if (marketplacePostWriteTokenStoreForTests) {
    return marketplacePostWriteTokenStoreForTests;
  }

  const { getDefaultPostWriteTokenStore } = await import("@chase-sets/platform-runtime/post-write-token-store");
  return getDefaultPostWriteTokenStore();
}

export async function resolveMarketplacePostWriteRequest(request: Request): Promise<Request> {
  if (!readCompactPostWriteToken(request)) {
    return request;
  }

  return resolvePostWriteTokenRequest(request, await resolveMarketplacePostWriteTokenStore());
}
