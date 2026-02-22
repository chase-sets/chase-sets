import { DomainEvent } from "../../packages/events/domainEvent";
import { IdentityInvariantError } from "./aggregates";
import {
  IdentityAggregateType,
  IdentityEvent,
  IdentityEventForAggregate,
  IdentityEventType,
  IDENTITY_EVENT_TYPE_PATTERN,
  isEventTypeForAggregate,
  isIdentityAggregateType,
  isIdentityEventType,
} from "./events";

type UnknownDomainEvent = DomainEvent<string, string, unknown>;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const hasPrefix = (value: string, prefix: string): boolean => value.startsWith(prefix);

const isIsoUtcTimestamp = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
};

const SENSITIVE_KEY_FRAGMENTS = ["secret", "password", "token", "private_key"];

const collectSensitivePaths = (
  value: unknown,
  path: string,
  matches: string[]
): void => {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectSensitivePaths(entry, `${path}[${index}]`, matches);
    });
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (SENSITIVE_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
      matches.push(`${path}.${key}`);
    }

    collectSensitivePaths(nestedValue, `${path}.${key}`, matches);
  }
};

export const validateIdentityEventEnvelope = (event: UnknownDomainEvent): string[] => {
  const errors: string[] = [];

  if (!isNonEmptyString(event.type)) {
    errors.push("event.type is required.");
  } else if (!IDENTITY_EVENT_TYPE_PATTERN.test(event.type)) {
    errors.push(
      `event.type '${event.type}' must follow pattern identity.<aggregate>.<action>.v<version>.`
    );
  }

  if (!isNonEmptyString(event.aggregate.type)) {
    errors.push("event.aggregate.type is required.");
  } else if (!isIdentityAggregateType(event.aggregate.type)) {
    errors.push(`event.aggregate.type '${event.aggregate.type}' is not a valid identity aggregate.`);
  }

  if (!isNonEmptyString(event.aggregate.id)) {
    errors.push("event.aggregate.id is required.");
  }

  if (!Number.isInteger(event.version) || event.version < 1) {
    errors.push("event.version must be a positive integer.");
  }

  if (!isNonEmptyString(event.occurredAt) || !isIsoUtcTimestamp(event.occurredAt)) {
    errors.push("event.occurredAt must be an ISO-8601 UTC timestamp.");
  }

  if (!isNonEmptyString(event.performedByAccountId) || !hasPrefix(event.performedByAccountId, "acc_")) {
    errors.push("event.performedByAccountId must be an AccountId with 'acc_' prefix.");
  }

  if (!isNonEmptyString(event.forOrganizationId) || !hasPrefix(event.forOrganizationId, "org_")) {
    errors.push("event.forOrganizationId must be an OrganizationId with 'org_' prefix.");
  }

  if (event.commandId !== undefined && !hasPrefix(event.commandId, "cmd_")) {
    errors.push("event.commandId must use 'cmd_' prefix when provided.");
  }

  if (event.correlationId !== undefined && !hasPrefix(event.correlationId, "cor_")) {
    errors.push("event.correlationId must use 'cor_' prefix when provided.");
  }

  if (isIdentityEventType(event.type) && isIdentityAggregateType(event.aggregate.type)) {
    if (!isEventTypeForAggregate(event.type, event.aggregate.type)) {
      errors.push(
        `event.type '${event.type}' is not valid for aggregate '${event.aggregate.type}'.`
      );
    }
  }

  if (isIdentityEventType(event.type) && (event.type.startsWith("identity.credential.") || event.type.startsWith("identity.api_key."))) {
    const sensitivePaths: string[] = [];
    collectSensitivePaths(event.data, "event.data", sensitivePaths);

    for (const path of sensitivePaths) {
      errors.push(`Sensitive field name detected in event payload at '${path}'.`);
    }
  }

  return errors;
};

export const assertValidIdentityEventEnvelope = (event: UnknownDomainEvent): void => {
  const errors = validateIdentityEventEnvelope(event);
  if (errors.length > 0) {
    throw new IdentityInvariantError(errors.join(" "));
  }
};

export const validateIdentityAggregateStream = <TAggregate extends IdentityAggregateType>(
  aggregateType: TAggregate,
  events: readonly IdentityEventForAggregate<TAggregate>[]
): string[] => {
  const errors: string[] = [];
  const seenCommandIds = new Set<string>();
  let previousVersion = 0;
  let aggregateId: string | undefined;

  for (const event of events) {
    errors.push(...validateIdentityEventEnvelope(event));

    if (event.aggregate.type !== aggregateType) {
      errors.push(
        `Stream aggregate mismatch: expected '${aggregateType}', received '${event.aggregate.type}'.`
      );
    }

    if (aggregateId === undefined) {
      aggregateId = event.aggregate.id;
    } else if (aggregateId !== event.aggregate.id) {
      errors.push(
        `Stream contains multiple aggregate ids: '${aggregateId}' and '${event.aggregate.id}'.`
      );
    }

    if (event.version !== previousVersion + 1) {
      errors.push(
        `Stream version gap at event '${event.type}': expected ${previousVersion + 1}, received ${event.version}.`
      );
    }

    previousVersion = event.version;

    if (event.commandId !== undefined) {
      if (seenCommandIds.has(event.commandId)) {
        errors.push(`Duplicate commandId detected in stream: '${event.commandId}'.`);
      }
      seenCommandIds.add(event.commandId);
    }
  }

  return errors;
};

export const assertValidIdentityAggregateStream = <TAggregate extends IdentityAggregateType>(
  aggregateType: TAggregate,
  events: readonly IdentityEventForAggregate<TAggregate>[]
): void => {
  const errors = validateIdentityAggregateStream(aggregateType, events);
  if (errors.length > 0) {
    throw new IdentityInvariantError(errors.join(" "));
  }
};

type EventGroup = {
  key: string;
  events: IdentityEvent[];
};

const groupIdentityEventsByContext = (events: readonly IdentityEvent[]): EventGroup[] => {
  const groups = new Map<string, IdentityEvent[]>();

  for (const event of events) {
    const key =
      event.correlationId ??
      event.commandId ??
      `${event.performedByAccountId}:${event.forOrganizationId}:${event.occurredAt.slice(0, 10)}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key)!.push(event);
  }

  return [...groups.entries()].map(([key, groupEvents]) => ({
    key,
    events: groupEvents,
  }));
};

const hasEvent = (
  events: readonly IdentityEvent[],
  eventType: IdentityEventType,
  predicate?: (event: IdentityEvent<IdentityEventType>) => boolean
): boolean => {
  for (const event of events) {
    if (event.type !== eventType) {
      continue;
    }

    if (!predicate || predicate(event)) {
      return true;
    }
  }

  return false;
};

export const validateIdentityWorkflowPolicies = (
  events: readonly IdentityEvent[]
): string[] => {
  const errors: string[] = [];
  const groups = groupIdentityEventsByContext(events);

  for (const group of groups) {
    const hasAccountCreated = hasEvent(group.events, "identity.account.created.v1");
    if (hasAccountCreated) {
      const hasPersonalOrganization = hasEvent(
        group.events,
        "identity.organization.created.v1",
        (event) =>
          event.type === "identity.organization.created.v1" &&
          event.data.isPersonal === true
      );

      if (!hasPersonalOrganization) {
        errors.push(
          `Workflow policy violation (${group.key}): account onboarding requires personal organization creation.`
        );
      }

      const hasOwnerMembership = hasEvent(
        group.events,
        "identity.membership.created.v1",
        (event) =>
          event.type === "identity.membership.created.v1" &&
          event.data.status === "active"
      );

      if (!hasOwnerMembership) {
        errors.push(
          `Workflow policy violation (${group.key}): account onboarding requires active membership creation.`
        );
      }

      const hasConsentRecorded = hasEvent(group.events, "identity.consent.recorded.v1");
      if (!hasConsentRecorded) {
        errors.push(
          `Workflow policy violation (${group.key}): account onboarding requires consent recording.`
        );
      }
    }

    const hasInvitationAccepted = hasEvent(group.events, "identity.invitation.accepted.v1");
    if (hasInvitationAccepted) {
      const hasMembershipCreated = hasEvent(group.events, "identity.membership.created.v1");
      if (!hasMembershipCreated) {
        errors.push(
          `Workflow policy violation (${group.key}): invitation acceptance requires membership creation.`
        );
      }
    }

    const hasVerificationCompleted = hasEvent(
      group.events,
      "identity.verification.completed.v1"
    );
    if (hasVerificationCompleted) {
      const hasContactMethodVerified = hasEvent(
        group.events,
        "identity.contact_method.verified.v1"
      );
      if (!hasContactMethodVerified) {
        errors.push(
          `Workflow policy violation (${group.key}): completed verification requires contact method verification event.`
        );
      }
    }
  }

  return errors;
};

export const assertValidIdentityWorkflowPolicies = (
  events: readonly IdentityEvent[]
): void => {
  const errors = validateIdentityWorkflowPolicies(events);
  if (errors.length > 0) {
    throw new IdentityInvariantError(errors.join(" "));
  }
};

export const isIdentityEvent = (event: UnknownDomainEvent): event is IdentityEvent => {
  if (!isIdentityEventType(event.type)) {
    return false;
  }

  if (!isIdentityAggregateType(event.aggregate.type)) {
    return false;
  }

  return isEventTypeForAggregate(event.type, event.aggregate.type);
};

export const isIdentityEventTypeValue = (value: string): value is IdentityEventType =>
  isIdentityEventType(value);
