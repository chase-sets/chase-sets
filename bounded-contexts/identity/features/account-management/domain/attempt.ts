import { createHash } from "node:crypto";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import { parseGrantableRoleKey } from "../../../support/runtime-support/common";
import {
  actionFields,
  closedObject,
  isInstant,
  parseAttemptKey,
  type AttemptBinding,
  type MutationAction,
} from "./contract";
export { parseAttemptKey } from "./contract";

export type CanonicalRequest = Readonly<{
  action: MutationAction;
  target: string | null;
  fields: JsonObject;
  hash: string;
}>;

export function digest(value: JsonValue): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex");
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const object = value as JsonObject;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortJson(object[key])]),
    ) as JsonObject;
  }
  return value;
}

export function validateBinding(binding: AttemptBinding): AttemptBinding {
  closedObject(binding, ["tenantId", "userId", "accountId"]);
  if (typeof binding.tenantId !== "string" || !/^tnt_[a-zA-Z0-9_-]{1,80}$/.test(binding.tenantId))
    throw new Error("INDETERMINATE");
  boundedId(binding.userId, "usr");
  boundedId(binding.accountId, "acc");
  return binding;
}

export function attemptStreamId(binding: AttemptBinding, key: string): string {
  return `identity.account-management-mutation-attempt-${digest({ version: 1, ...validateBinding(binding), key: parseAttemptKey(key) })}`;
}

const targetPrefixes: Record<MutationAction, string | null> = {
  "update-profile": "acc",
  create: null,
  update: "adr",
  default: "adr",
  archive: "adr",
  withdraw: "cns",
  "update-user": "usr",
  "unlink-social-login": "usr",
  "create-api-key": null,
  "rotate-api-key": "key",
  "revoke-api-key": "key",
  "create-invitation": null,
  "cancel-invitation": "ivt",
  "change-role": "mbr",
  revoke: "mbr",
  reinstate: "mbr",
};

export function parseActionTarget(action: string, target: string | null): MutationAction {
  if (!Object.hasOwn(actionFields, action)) throw new Error("INDETERMINATE");
  const known = action as MutationAction;
  const prefix = targetPrefixes[known];
  if (prefix) {
    if (typeof target !== "string") throw new Error("INDETERMINATE");
    boundedId(target, prefix);
  } else if (target !== null) throw new Error("INDETERMINATE");
  return known;
}

export function canonicalRequest(action: string, target: string | null, body: unknown): CanonicalRequest {
  const known = parseActionTarget(action, target);
  const fields: JsonObject = {};
  const allowed = actionFields[known] as readonly string[];
  const raw = closedObject(body, allowed);
  for (const name of allowed) {
    const value = raw[name];
    if (value === undefined) continue;
    if (name === "makeDefault") {
      if (typeof value !== "boolean") throw new Error("INDETERMINATE");
      fields[name] = value;
    } else {
      if (value !== null && (typeof value !== "string" || value.length > 1000)) throw new Error("INDETERMINATE");
      fields[name] = value === null ? null : (value as string).trim();
    }
  }
  for (const name of ["email"]) if (typeof fields[name] === "string") fields[name] = fields[name].toLowerCase();
  for (const name of ["state", "country"])
    if (typeof fields[name] === "string") fields[name] = fields[name].toUpperCase();
  if (known === "create-invitation") {
    if (typeof fields.invitationId !== "string" || typeof fields.expiresAt !== "string" || !isInstant(fields.expiresAt))
      throw new Error("INDETERMINATE");
    boundedId(fields.invitationId, "ivt");
  }
  for (const [name, prefix] of [
    ["userId", "usr"],
    ["accountId", "acc"],
  ]) {
    if (fields[name] !== undefined) {
      if (typeof fields[name] !== "string") throw new Error("INDETERMINATE");
      boundedId(fields[name] as string, prefix);
    }
  }
  if (fields.roleKey !== undefined && !parseGrantableRoleKey(fields.roleKey)) throw new Error("INDETERMINATE");
  if (
    fields.addressVerificationDecision !== undefined &&
    fields.addressVerificationDecision !== null &&
    !["accept-suggested", "keep-original"].includes(String(fields.addressVerificationDecision))
  )
    throw new Error("INDETERMINATE");
  const semantics = { ...fields };
  delete semantics.invitationId;
  delete semantics.expiresAt;
  return { action: known, target, fields, hash: digest({ version: 1, action: known, target, fields: semantics }) };
}

function boundedId(value: string, prefix: string) {
  if (value.length > 100) throw new Error("INDETERMINATE");
  return parseTypedId(value, prefix);
}
