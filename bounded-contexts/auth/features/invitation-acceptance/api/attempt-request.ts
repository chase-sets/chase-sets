const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readInvitationAttemptId(body: unknown, idempotencyKey: string | undefined): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = "attemptId" in body ? body.attemptId : undefined;
  return typeof value === "string" && UUID.test(value) && value === idempotencyKey ? value : null;
}

export function hasInvitationAttempt(body: unknown, idempotencyKey: string | undefined): boolean {
  return Boolean(idempotencyKey) || Boolean(body && typeof body === "object" && "attemptId" in body);
}
