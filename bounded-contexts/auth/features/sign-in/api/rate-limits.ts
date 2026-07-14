import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
  type RateLimitRule,
} from "@chase-sets/http/rate-limit";

type AuthRateLimitDimension = Readonly<{
  surface: string;
  rule: RateLimitRule;
}>;

type AuthRateLimitPairOptions = Readonly<{
  identifier: AuthRateLimitDimension;
  ip: AuthRateLimitDimension;
}>;

/**
 * Keeps identifier and network limits paired so every guarded auth attempt is
 * counted against both dimensions, even when one dimension is already over
 * its limit.
 */
export function createAuthRateLimitPair(options: AuthRateLimitPairOptions) {
  const identifierLimiter = createConfiguredInMemoryRateLimiter(options.identifier.surface, options.identifier.rule);
  const ipLimiter = createConfiguredInMemoryRateLimiter(options.ip.surface, options.ip.rule);

  function decide(request: Request, identifierKey: string, increment: boolean) {
    const identifierDecision = increment
      ? identifierLimiter.check(identifierKey)
      : identifierLimiter.peek(identifierKey);
    const ipDecision = increment
      ? ipLimiter.check(publicClientRequestKey(request))
      : ipLimiter.peek(publicClientRequestKey(request));

    if (identifierDecision.limited) {
      return rateLimitExceededJsonResponse(options.identifier.surface, identifierDecision);
    }
    if (ipDecision.limited) {
      return rateLimitExceededJsonResponse(options.ip.surface, ipDecision);
    }
    return null;
  }

  return {
    check(request: Request, identifierKey: string) {
      return decide(request, identifierKey, true);
    },
    peek(request: Request, identifierKey: string) {
      return decide(request, identifierKey, false);
    },
    record(request: Request, identifierKey: string) {
      decide(request, identifierKey, true);
    },
  };
}
