export type OneTimeApiKeySecret = Readonly<{
  apiKeyId: string;
  keyPrefix: string;
  secret: string;
  action: "created" | "rotated";
  detailsHref?: string;
}>;

export type ApiKeySecretMutationResult = Readonly<{
  id?: unknown;
  keyPrefix?: unknown;
  secret?: unknown;
}>;

export function oneTimeSecretFromMutation(
  result: ApiKeySecretMutationResult,
  action: OneTimeApiKeySecret["action"],
): OneTimeApiKeySecret {
  if (
    typeof result.id !== "string" ||
    !result.id.trim() ||
    typeof result.keyPrefix !== "string" ||
    !result.keyPrefix.trim() ||
    typeof result.secret !== "string" ||
    !result.secret.trim()
  ) {
    throw new Response("API key mutation did not return the one-time secret.", { status: 502 });
  }

  return {
    apiKeyId: result.id,
    keyPrefix: result.keyPrefix,
    secret: result.secret,
    action,
  };
}
