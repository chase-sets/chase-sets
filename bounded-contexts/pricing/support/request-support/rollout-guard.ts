import type { ResolvedActor } from "@chase-sets/auth-context";
import { readApiErrorMessage } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import {
  normalizeRolloutEnvironment,
  type ReleaseControlPolicyDecision,
  type RolloutEnvironment,
} from "@chase-sets/release-controls";

export const PRICING_ACCOUNT_REPRICING_FEATURE_KEY = "pricing.account-repricing";

export type PricingRolloutGuardDecision = ReleaseControlPolicyDecision;

export class PricingRolloutGuardError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function requirePricingAccountRepricingRollout(
  request: Request,
  actor: ResolvedActor,
  options: Readonly<{
    fetch?: typeof globalThis.fetch;
    environment?: RolloutEnvironment;
  }> = {},
): Promise<PricingRolloutGuardDecision> {
  const decision = await evaluatePricingAccountRepricingRollout(request, actor, options);

  if (!decision.enabled) {
    throw new Response("Not Found.", { status: 404 });
  }

  return decision;
}

export async function evaluatePricingAccountRepricingRollout(
  request: Request,
  actor: ResolvedActor,
  options: Readonly<{
    fetch?: typeof globalThis.fetch;
    environment?: RolloutEnvironment;
  }> = {},
): Promise<PricingRolloutGuardDecision> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const environment = options.environment ?? normalizeRolloutEnvironment(process.env.DEPLOYMENT_ENVIRONMENT);
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/platform");
  const query = new URLSearchParams({
    environment,
    subjectType: "account",
    subjectId: actor.accountId,
  });
  const response = await createForwardedAuthFetch(request, fetchImpl, {
    readTargetContextName: "platform-operations",
  })(
    `${baseUrl}/release-controls/rollouts/${encodeURIComponent(PRICING_ACCOUNT_REPRICING_FEATURE_KEY)}/decision?${query}`,
  );

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new PricingRolloutGuardError(response.status, readApiErrorMessage(body, `API error ${response.status}`));
  }

  return (await response.json()) as PricingRolloutGuardDecision;
}
