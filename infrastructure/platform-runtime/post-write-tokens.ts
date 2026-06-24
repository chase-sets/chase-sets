import {
  readCompactPostWriteToken,
  type PostWriteTokenPayload,
  type PostWriteTokenStore,
} from "@chase-sets/http/responses";
import {
  navigateAfterWriteFromSourcesWithCompactToken,
  navigateAfterWriteWithCompactToken,
  redirectAfterWriteFromSourcesWithCompactToken,
  redirectAfterWriteWithCompactToken,
  resolvePostWriteTokenRequest,
  type PlatformCompactPostWriteTokenOptions,
  type PlatformCompactRedirectAfterWriteOptions,
} from "./http";

export type PlatformDefaultCompactPostWriteTokenOptions = Omit<
  PlatformCompactPostWriteTokenOptions,
  "postWriteTokenStore"
>;

export type PlatformDefaultCompactPostWriteRedirectOptions = Omit<
  PlatformCompactRedirectAfterWriteOptions,
  "postWriteTokenStore"
>;

let platformPostWriteTokenStoreForTests: PostWriteTokenStore | null = null;

export function configurePlatformPostWriteTokenStoreForTests(store: PostWriteTokenStore | null) {
  const previous = platformPostWriteTokenStoreForTests;
  platformPostWriteTokenStoreForTests = store;
  return () => {
    platformPostWriteTokenStoreForTests = previous;
  };
}

export async function resolvePlatformPostWriteTokenStore(): Promise<PostWriteTokenStore> {
  if (platformPostWriteTokenStoreForTests) {
    return platformPostWriteTokenStoreForTests;
  }

  if (isTestRuntime()) {
    platformPostWriteTokenStoreForTests = createInMemoryPostWriteTokenStoreForTests();
    return platformPostWriteTokenStoreForTests;
  }

  const { getDefaultPostWriteTokenStore } = await import("./post-write-token-store");
  return getDefaultPostWriteTokenStore();
}

export async function resolvePlatformPostWriteRequest(request: Request): Promise<Request> {
  if (!readCompactPostWriteToken(request)) {
    return request;
  }

  return resolvePostWriteTokenRequest(request, await resolvePlatformPostWriteTokenStore());
}

export async function navigateAfterWriteWithPlatformPostWriteToken(
  commandResult: unknown,
  destinationRoute: string,
  options: PlatformDefaultCompactPostWriteTokenOptions = {},
): Promise<string> {
  return navigateAfterWriteWithCompactToken(commandResult, destinationRoute, {
    ...options,
    postWriteTokenStore: await resolvePlatformPostWriteTokenStore(),
  });
}

export async function navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
  commandResults: readonly unknown[],
  destinationRoute: string,
  options: PlatformDefaultCompactPostWriteTokenOptions = {},
): Promise<string> {
  return navigateAfterWriteFromSourcesWithCompactToken(commandResults, destinationRoute, {
    ...options,
    postWriteTokenStore: await resolvePlatformPostWriteTokenStore(),
  });
}

export async function redirectAfterWriteWithPlatformPostWriteToken(
  commandResult: unknown,
  destinationRoute: string,
  options: PlatformDefaultCompactPostWriteRedirectOptions = {},
): Promise<Response> {
  return redirectAfterWriteWithCompactToken(commandResult, destinationRoute, {
    ...options,
    postWriteTokenStore: await resolvePlatformPostWriteTokenStore(),
  });
}

export async function redirectAfterWriteFromSourcesWithPlatformPostWriteToken(
  commandResults: readonly unknown[],
  destinationRoute: string,
  options: PlatformDefaultCompactPostWriteRedirectOptions = {},
): Promise<Response> {
  return redirectAfterWriteFromSourcesWithCompactToken(commandResults, destinationRoute, {
    ...options,
    postWriteTokenStore: await resolvePlatformPostWriteTokenStore(),
  });
}

function isTestRuntime() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function createInMemoryPostWriteTokenStoreForTests(): PostWriteTokenStore {
  const payloads = new Map<string, PostWriteTokenPayload>();
  let sequence = 0;

  return {
    async storePostWriteToken(payload) {
      sequence += 1;
      const token = `pwt_test${String(sequence).padStart(16, "0")}`;
      payloads.set(token, payload);
      return token;
    },
    async resolvePostWriteToken(token) {
      return payloads.get(token) ?? null;
    },
  };
}
