export type PlatformFeedbackTopic =
  | "ease-of-use"
  | "pricing-fees"
  | "product-data-search"
  | "checkout-payment"
  | "selling-inventory"
  | "performance-reliability"
  | "other";

export type PlatformFeedbackWorkflow =
  | "checkout-payment"
  | "listing-publish"
  | "listing-update"
  | "offer-submit"
  | "offer-accept"
  | "inventory-create"
  | "inventory-adjust";

export type PlatformFeedbackStatus = "new" | "reviewed" | "archived";

export type PlatformFeedbackRelatedEntity = {
  type: string;
  id: string;
};

export const platformFeedbackTopics = [
  "ease-of-use",
  "pricing-fees",
  "product-data-search",
  "checkout-payment",
  "selling-inventory",
  "performance-reliability",
  "other",
] as const satisfies readonly PlatformFeedbackTopic[];

export const platformFeedbackWorkflows = [
  "checkout-payment",
  "listing-publish",
  "listing-update",
  "offer-submit",
  "offer-accept",
  "inventory-create",
  "inventory-adjust",
] as const satisfies readonly PlatformFeedbackWorkflow[];

export class ExperienceDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExperienceDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ExperienceDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new ExperienceDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function ensureIsoTimestamp(value: string, message: string): string {
  assert(!Number.isNaN(Date.parse(value)), message);
  return value;
}

export function normalizeRating(value: number): number {
  assert(Number.isInteger(value), "Rating must be a whole number.");
  assert(value >= 1 && value <= 5, "Rating must be between 1 and 5.");
  return value;
}

export function normalizeComment(value?: string | null): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }

  assert(normalized.length <= 1000, "Comment must be 1000 characters or fewer.");
  return normalized;
}

export function normalizeTopic(value: string): PlatformFeedbackTopic {
  const normalized = value.trim();
  if (platformFeedbackTopics.includes(normalized as PlatformFeedbackTopic)) {
    return normalized as PlatformFeedbackTopic;
  }

  throw new ExperienceDomainError("Platform feedback topic is not supported.");
}

export function normalizeWorkflow(value: string): PlatformFeedbackWorkflow {
  const normalized = value.trim();
  if (platformFeedbackWorkflows.includes(normalized as PlatformFeedbackWorkflow)) {
    return normalized as PlatformFeedbackWorkflow;
  }

  throw new ExperienceDomainError("Platform feedback workflow is not supported.");
}

export function normalizeStatus(value: string): PlatformFeedbackStatus {
  switch (value.trim()) {
    case "new":
      return "new";
    case "reviewed":
      return "reviewed";
    case "archived":
      return "archived";
    default:
      throw new ExperienceDomainError("Platform feedback status is not supported.");
  }
}

export function normalizeRelatedEntities(
  value: readonly PlatformFeedbackRelatedEntity[] = [],
): PlatformFeedbackRelatedEntity[] {
  return value
    .map((entity) => ({
      type: entity.type.trim(),
      id: entity.id.trim(),
    }))
    .filter((entity) => entity.type.length > 0 && entity.id.length > 0);
}

export function relatedEntityKey(entities: readonly PlatformFeedbackRelatedEntity[] = []) {
  const primary = normalizeRelatedEntities(entities)[0];
  return primary ? `${primary.type}:${primary.id}` : null;
}
