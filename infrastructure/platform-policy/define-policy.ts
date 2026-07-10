import type { JsonValue } from "@chase-sets/primitives/json";
import { PlatformPolicyDomainError } from "./domain";

/**
 * A context-owned declaration of one runtime-configurable business value.
 * `definePolicy` is the machinery's single entry point: a context calls it
 * once per policy, gets back a typed definition, and uses that definition to
 * build create/revise commands and to resolve the current value. The
 * machinery never inspects `Value`'s shape itself -- only `decodeValue` does,
 * so every policy can carry a different value shape on the same shared
 * event stream, tables, and resolver.
 */

const POLICY_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

export type PolicyDefinition<Value> = Readonly<{
  /** Dotted, globally unique key, e.g. "settlement.clearance-window". */
  policyKey: string;
  /** Owning bounded context name, stamped on the document for the registry read model. */
  contextName: string;
  /** Human-readable shape summary shown on the registry read model, e.g. "{ holdDays: integer 0-30 }". */
  schemaSummary: string;
  /** The compiled fallback used whenever no policy document is active (migration safety net). */
  defaultValue: Value;
  /**
   * Parses and validates a raw JSON value (already round-tripped through
   * storage) into `Value`. Throws on anything that does not satisfy the
   * policy's declared shape. Called on both the stored value and, at
   * `definePolicy` time, on the encoded default -- so a policy whose default
   * cannot decode fails at declaration time, not the first time the
   * fallback path is exercised.
   */
  decodeValue: (raw: JsonValue) => Value;
}>;

export type DefinePolicyConfig<Value> = Readonly<{
  policyKey: string;
  contextName: string;
  schemaSummary: string;
  defaultValue: Value;
  decodeValue: (raw: JsonValue) => Value;
}>;

export function isPolicyKey(value: string): boolean {
  return POLICY_KEY_PATTERN.test(value);
}

export function encodePolicyValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

export function definePolicy<Value>(config: DefinePolicyConfig<Value>): PolicyDefinition<Value> {
  if (!isPolicyKey(config.policyKey)) {
    throw new PlatformPolicyDomainError(
      `Policy key '${config.policyKey}' must be dotted lowercase, e.g. '<context-name>.<policy-name>'.`,
    );
  }
  if (config.contextName.trim().length === 0) {
    throw new PlatformPolicyDomainError("Policy contextName is required.");
  }
  if (config.schemaSummary.trim().length === 0) {
    throw new PlatformPolicyDomainError("Policy schemaSummary is required.");
  }

  // Fails fast at declaration time rather than the first time the fallback
  // path is exercised in production.
  config.decodeValue(encodePolicyValue(config.defaultValue));

  return {
    policyKey: config.policyKey,
    contextName: config.contextName,
    schemaSummary: config.schemaSummary,
    defaultValue: config.defaultValue,
    decodeValue: config.decodeValue,
  };
}
