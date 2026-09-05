import {
  ChannelConnectionError,
  channelConnectionStatuses,
  channelEnvironments,
  type ChannelConnectionBinding,
  type ChannelConnectionSetupDeclaration,
} from "./contracts";

const LOWER_KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RFC_3339_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const C0_CONTROL = /[\u0000-\u001f\u007f]/;
const SENSITIVE_REFERENCE =
  /(?:password|passwd|secret|bearer|authorization|private[-_]?key|access[-_]?token|refresh[-_]?token|api[-_]?key)/i;

export function assertClosedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const keys = Object.keys(value as object);
  if (keys.some((key) => !allowedKeys.includes(key))) invalid(`${label} contains an unknown field.`);
}

export function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || scalarLength(value) > 128 || !isScalarString(value)) {
    invalid(`${label} must contain 1 to 128 Unicode scalars.`);
  }
}

export function assertProviderKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    scalarLength(value) < 1 ||
    scalarLength(value) > 64 ||
    !isScalarString(value) ||
    !LOWER_KEBAB.test(value)
  ) {
    invalid("providerKey must be lower-kebab and contain 1 to 64 Unicode scalars.");
  }
}

export function assertChannelEnvironment(value: unknown): asserts value is "sandbox" | "production" {
  if (!channelEnvironments.includes(value as never)) invalid("Channel environment is invalid.");
}

export function assertPolicyKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    scalarLength(value) < 1 ||
    scalarLength(value) > 64 ||
    !isScalarString(value) ||
    !LOWER_KEBAB.test(value)
  ) {
    invalid("policyKey must be lower-kebab and contain 1 to 64 Unicode scalars.");
  }
}

export function assertRfc3339Instant(value: unknown, label = "instant"): asserts value is string {
  if (typeof value !== "string" || !RFC_3339_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) {
    invalid(`${label} must be a timezone-bearing RFC 3339 instant.`);
  }
}

export function assertCredentialReference(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    scalarLength(value) < 1 ||
    scalarLength(value) > 512 ||
    !isScalarString(value) ||
    C0_CONTROL.test(value) ||
    SENSITIVE_REFERENCE.test(value)
  ) {
    invalid("credentialReference is invalid or secret-shaped.");
  }
}

export function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${label} must be a non-negative safe integer.`);
}

export function assertBindingsShape(value: unknown): asserts value is readonly ChannelConnectionBinding[] {
  if (!Array.isArray(value)) invalid("bindings must be an array.");
  if (value.length > 200) invalid("bindings may contain at most 200 entries.");
  const ids = new Set<string>();
  for (const member of value) {
    assertClosedRecord(member, ["storageLocationId", "revision"], "binding");
    assertOpaqueId(member.storageLocationId, "storageLocationId");
    assertSafeInteger(member.revision, "binding revision");
    if (ids.has(member.storageLocationId)) invalid("bindings must have unique storageLocationId values.");
    ids.add(member.storageLocationId);
  }
}

export function assertSetupDeclaration(
  value: unknown,
  expected: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>,
): asserts value is ChannelConnectionSetupDeclaration {
  assertClosedRecord(value, ["providerKey", "environment", "requirements"], "setup declaration");
  assertProviderKey(value.providerKey);
  assertChannelEnvironment(value.environment);
  if (value.providerKey !== expected.providerKey || value.environment !== expected.environment) {
    invalid("setup declaration identity does not match the resolver query.");
  }
  assertClosedRecord(value.requirements, ["credential", "requiredPolicyKeys", "binding"], "setup requirements");
  if (value.requirements.credential !== "required" && value.requirements.credential !== "not-required") {
    invalid("setup credential requirement is invalid.");
  }
  if (value.requirements.binding !== "one-or-more-current") invalid("setup binding requirement is invalid.");
  if (!Array.isArray(value.requirements.requiredPolicyKeys) || value.requirements.requiredPolicyKeys.length > 32) {
    invalid("setup requiredPolicyKeys must contain zero to 32 entries.");
  }
  const policies = new Set<string>();
  for (const policyKey of value.requirements.requiredPolicyKeys) {
    assertPolicyKey(policyKey);
    if (policies.has(policyKey)) invalid("setup requiredPolicyKeys must be unique.");
    policies.add(policyKey);
  }
}

export function assertConnectionStatus(value: unknown): asserts value is (typeof channelConnectionStatuses)[number] {
  if (!channelConnectionStatuses.includes(value as never)) invalid("status is invalid.");
}

function invalid(message: string): never {
  throw new ChannelConnectionError("invalid-input", message);
}

function scalarLength(value: string): number {
  return [...value].length;
}

function isScalarString(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}
