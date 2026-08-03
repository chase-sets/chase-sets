export function authorizeConsentForActor(context: unknown): unknown {
  return context;
}

export function authorizeConsentForSelfRegistration(userId: unknown, accountId: unknown): unknown {
  return { userId, accountId };
}

export function authorizeConsentForProvisioning(userId: unknown, accountId: unknown): unknown {
  return { userId, accountId };
}
