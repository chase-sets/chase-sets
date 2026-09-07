import {
  parseResolveEconomicsInput,
  parseResolveEconomicsRequest,
  type ResolveEconomicsRequest,
} from "../domain/contracts";

/**
 * Closes the public request before authenticated identity is injected. Provider,
 * environment, account, and nested Channel coordinates are therefore rejected
 * as unknown input instead of being ignored or trusted.
 */
export function parseAuthenticatedResolveEconomicsRequest(
  raw: unknown,
  authenticatedAccountId: string,
): ResolveEconomicsRequest {
  const input = parseResolveEconomicsInput(raw);
  return parseResolveEconomicsRequest({ accountId: authenticatedAccountId, ...input });
}
