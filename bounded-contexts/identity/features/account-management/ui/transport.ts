import { UNSAFE_decodeViaTurboStream } from "react-router";
import {
  actionFields,
  routeActions,
  closedObject,
  parseAttemptKey,
  validateEventProofs,
  type AttemptBinding,
  type MutationAction,
} from "../domain/contract";
import type { ClientState } from "./descriptor";
import { validateShippingAddressSnapshot } from "../domain/owner-event";
import type { ShippingAddressSnapshot } from "../../shipping-addresses/domain/domain";
import { parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";

export type MutationFailure = Readonly<{
  intent: MutationAction;
  target: string | null;
  message: string;
  errors: Readonly<{
    fieldErrors: Readonly<Record<string, readonly string[]>>;
    formErrors: readonly string[];
  }> | null;
}>;

export type ClientMutationResult = Readonly<{
  state: ClientState;
  failure?: MutationFailure;
  suggestedAddress?: ShippingAddressSnapshot;
  secretState?: "committed-secret-unrecoverable";
  secret?: string;
  id?: string;
  destination?: string;
  action?: "created" | "rotated";
}>;

export function resolveClientState(value: unknown, status: number): ClientState {
  if (status === 401) return "reauth-required";
  if (status === 403) return "route-denied";
  try {
    if (value && typeof value === "object" && "failure" in value) {
      const payload = closedObject(value, ["failure"]);
      const failure = closedObject(payload.failure, [
        "kind",
        "status",
        "code",
        "message",
        "intent",
        "classification",
        "errors",
        "shippingAddressId",
      ]);
      if (
        typeof failure.message !== "string" ||
        failure.message.length > 500 ||
        typeof failure.intent !== "string" ||
        !Object.hasOwn(actionFields, failure.intent)
      )
        return "ambiguous";
      const admitted =
        ((status === 400 || status === 422) &&
          ["validation_failed", "validation_error", "shipping_address_undeliverable"].includes(String(failure.code))) ||
        (status === 404 && failure.code === "not_found") ||
        (status === 409 && ["conflict", "address_standardization_suggested"].includes(String(failure.code)));
      if (!admitted || failure.status !== status || !["validation", "domain"].includes(String(failure.kind)))
        return "ambiguous";
      if (failure.errors !== undefined) {
        const errors = closedObject(failure.errors, ["fieldErrors", "formErrors"]);
        const fields = closedObject(errors.fieldErrors, [...actionFields.create]);
        for (const messages of [...Object.values(fields), errors.formErrors])
          if (
            !Array.isArray(messages) ||
            messages.length > 10 ||
            messages.some((message) => typeof message !== "string" || message.length > 500)
          )
            return "ambiguous";
      }
      return status === 409 ? "conflict" : "failed-safe";
    }
    const result = closedObject(value, [
      "outcome",
      "code",
      "newlyCommitted",
      "receipt",
      "current",
      "secret",
      "secretState",
      "destination",
      "delivery",
      "suggestedAddress",
    ]);
    if (result.outcome === "committed") {
      validateCommittedResult(result);
      return "succeeded";
    }
    if (
      Object.keys(result).some((key) => !["outcome", "code", "suggestedAddress", "current"].includes(key)) ||
      typeof result.code !== "string" ||
      result.code.length > 100
    )
      return "ambiguous";
    if (result.current !== undefined) {
      const current = closedObject(result.current, ["id", "version", "status"]);
      if (
        result.outcome !== "conflict" ||
        typeof current.id !== "string" ||
        current.id.length > 100 ||
        !Number.isSafeInteger(current.version) ||
        Number(current.version) < 0 ||
        typeof current.status !== "string" ||
        current.status.length > 30
      )
        return "ambiguous";
    }
    if (result.suggestedAddress !== undefined) {
      if (result.outcome !== "not-recorded" || result.code !== "address-standardization-suggested") return "ambiguous";
      validateShippingAddressSnapshot(result.suggestedAddress);
    }
    if (
      result.outcome === "not-recorded" &&
      [
        "not-recorded",
        "interruption-safe-client-required",
        "address-standardization-suggested",
        "shipping-address-undeliverable",
      ].includes(result.code)
    )
      return "failed-safe";
    if (
      result.outcome === "conflict" &&
      [
        "conflict",
        "attempt-hash-conflict",
        "owner-version-conflict",
        "last-active-owner",
        "current-consent",
        "owner-state-conflict",
      ].includes(result.code)
    )
      return "conflict";
  } catch {
    return "ambiguous";
  }
  return "ambiguous";
}

function validatedFailure(
  value: unknown,
  status: number,
  action: string,
  target: string | null,
  lookup: boolean,
): MutationFailure | null {
  if (lookup || !value || typeof value !== "object") return null;
  if (resolveClientState(value, status) !== "failed-safe") return null;
  try {
    const payload = closedObject(value, ["failure"]);
    const failure = closedObject(payload.failure, [
      "kind",
      "status",
      "code",
      "message",
      "intent",
      "classification",
      "errors",
      "shippingAddressId",
    ]);
    if (
      failure.status !== status ||
      typeof failure.message !== "string" ||
      failure.message.length > 500 ||
      failure.intent !== action ||
      !Object.hasOwn(actionFields, action)
    )
      return null;
    if (
      (action === "update" && (target === null || typeof failure.shippingAddressId !== "string")) ||
      (failure.shippingAddressId !== undefined && action !== "update")
    )
      return null;
    if (failure.shippingAddressId !== undefined) {
      parseStrictTypedUlid(String(failure.shippingAddressId), "adr");
      if (failure.shippingAddressId !== target) return null;
    }
    let errors: MutationFailure["errors"] = null;
    if (failure.errors !== undefined) {
      const raw = closedObject(failure.errors, ["fieldErrors", "formErrors"]);
      const fields = closedObject(raw.fieldErrors, [...actionFields[action as MutationAction]]);
      const fieldErrors: Record<string, readonly string[]> = {};
      for (const [field, messages] of Object.entries(fields)) {
        if (
          !Array.isArray(messages) ||
          messages.length > 10 ||
          messages.some((message) => typeof message !== "string" || message.length > 500)
        )
          return null;
        fieldErrors[field] = messages;
      }
      if (
        !Array.isArray(raw.formErrors) ||
        raw.formErrors.length > 10 ||
        raw.formErrors.some((message) => typeof message !== "string" || message.length > 500)
      )
        return null;
      errors = { fieldErrors, formErrors: raw.formErrors as string[] };
    }
    return deepFreeze({
      intent: action as MutationAction,
      target,
      message: failure.message,
      errors,
    });
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function validateCommittedResult(result: Record<string, unknown>) {
  if (typeof result.newlyCommitted !== "boolean") throw new Error("INDETERMINATE");
  if (result.delivery !== undefined && result.delivery !== "unknown") throw new Error("INDETERMINATE");
  const receipt = closedObject(result.receipt, [
    "schemaVersion",
    "binding",
    "action",
    "target",
    "owner",
    "category",
    "hash",
    "priorVersion",
    "committedVersion",
    "events",
    "result",
  ]);
  if (
    receipt.schemaVersion !== 1 ||
    typeof receipt.action !== "string" ||
    !Object.hasOwn(actionFields, receipt.action) ||
    typeof receipt.owner !== "string" ||
    receipt.owner.length > 250 ||
    !["account", "shipping-address-book", "consent", "user", "api-key", "membership", "invitation"].includes(
      String(receipt.category),
    ) ||
    (receipt.target !== null && (typeof receipt.target !== "string" || receipt.target.length > 100)) ||
    typeof receipt.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.hash)
  )
    throw new Error("INDETERMINATE");
  const binding = closedObject(receipt.binding, ["tenantId", "userId", "accountId"]);
  if (
    ["tenantId", "userId", "accountId"].some(
      (name) => typeof binding[name] !== "string" || String(binding[name]).length > 100,
    )
  )
    throw new Error("INDETERMINATE");
  const recorded = closedObject(receipt.result, ["id", "version", "status", "changed"]);
  const current = closedObject(result.current, ["id", "version", "status"]);
  for (const owner of [recorded, current])
    if (
      typeof owner.id !== "string" ||
      owner.id.length > 100 ||
      !Number.isSafeInteger(owner.version) ||
      Number(owner.version) < 0 ||
      typeof owner.status !== "string" ||
      owner.status.length > 30
    )
      throw new Error("INDETERMINATE");
  if (
    !Number.isSafeInteger(receipt.priorVersion) ||
    Number(receipt.priorVersion) < 0 ||
    receipt.committedVersion !== recorded.version ||
    Number(receipt.committedVersion) < Number(receipt.priorVersion) ||
    Number(current.version) < Number(recorded.version) ||
    current.id !== recorded.id ||
    typeof recorded.changed !== "boolean"
  )
    throw new Error("INDETERMINATE");
  if (!Array.isArray(receipt.events) || receipt.events.length > 2) throw new Error("INDETERMINATE");
  validateEventProofs(receipt.action as MutationAction, receipt.events);
  if (
    receipt.events.length !== Number(receipt.committedVersion) - Number(receipt.priorVersion) ||
    recorded.changed !== receipt.events.length > 0
  )
    throw new Error("INDETERMINATE");
  if (
    result.secret !== undefined &&
    (result.newlyCommitted !== true ||
      !["create-api-key", "rotate-api-key"].includes(receipt.action) ||
      typeof result.secret !== "string" ||
      result.secret.length > 200)
  )
    throw new Error("INDETERMINATE");
  if (
    result.secretState !== undefined &&
    (result.secretState !== "committed-secret-unrecoverable" ||
      result.secret !== undefined ||
      result.newlyCommitted !== false ||
      !["create-api-key", "rotate-api-key"].includes(receipt.action))
  )
    throw new Error("INDETERMINATE");
  if (
    result.destination !== undefined &&
    (typeof result.destination !== "string" ||
      !/^\/account(?:\/|\?|$)/.test(result.destination) ||
      result.destination.startsWith("//") ||
      result.destination.length > 16000)
  )
    throw new Error("INDETERMINATE");
  return { receipt, recorded, current, binding };
}

function clientResult(value: unknown, status: number, lookup: boolean): ClientMutationResult {
  const state = resolveClientState(value, status);
  if (state !== "succeeded") {
    if (state === "failed-safe" && value && typeof value === "object" && "suggestedAddress" in value && !lookup)
      return { state, suggestedAddress: validateShippingAddressSnapshot(value.suggestedAddress) };
    return { state };
  }
  const result = value as Record<string, unknown>;
  const { receipt, recorded } = validateCommittedResult(result);
  if (lookup && result.secret !== undefined) return { state: "ambiguous" };
  return {
    state,
    ...(typeof result.destination === "string" ? { destination: result.destination } : {}),
    ...(result.secretState === "committed-secret-unrecoverable" ? { secretState: result.secretState } : {}),
    ...(typeof result.secret === "string"
      ? {
          secret: result.secret,
          id: String(recorded.id),
          action: receipt.action === "create-api-key" ? "created" : "rotated",
        }
      : {}),
  };
}

export async function sendMutation(
  args: Readonly<{
    route: string;
    action: string;
    target: string | null;
    key: string;
    form: FormData;
    binding: AttemptBinding;
    fetch?: typeof globalThis.fetch;
    onConfirming?: () => void;
  }>,
): Promise<ClientMutationResult> {
  const fetch = args.fetch ?? globalThis.fetch;
  try {
    parseAttemptKey(args.key);
    if (
      !Object.hasOwn(routeActions, args.route) ||
      !(routeActions[args.route as keyof typeof routeActions] as readonly string[]).includes(args.action)
    )
      throw new Error("INDETERMINATE");
  } catch {
    return { state: "failed-safe" };
  }
  let response: Response | null = null;
  function observedResult(value: unknown, status: number, lookup: boolean) {
    const result = clientResult(value, status, lookup);
    if (result.state === "succeeded") {
      const committed = validateCommittedResult(value as Record<string, unknown>);
      if (
        committed.receipt.action !== args.action ||
        committed.receipt.target !== args.target ||
        ["tenantId", "userId", "accountId"].some(
          (name) => committed.binding[name] !== args.binding[name as keyof AttemptBinding],
        )
      )
        return { state: "ambiguous" as const };
    }
    return result;
  }
  try {
    response = await fetch(`${args.route}.data`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Idempotency-Key": args.key, Accept: "text/x-script" },
      body: args.form,
    });
    if (response.status < 500 && response.body) {
      const decoded = await UNSAFE_decodeViaTurboStream(response.body, globalThis);
      const envelope = closedObject(decoded.value, ["data", "error"]);
      const result = observedResult(envelope.error === undefined ? envelope.data : null, response.status, false);
      if (result.state !== "ambiguous") {
        const failure = validatedFailure(
          envelope.error === undefined ? envelope.data : null,
          response.status,
          args.action,
          args.target,
          false,
        );
        return failure ? { ...result, failure } : result;
      }
    }
  } catch {
    /* A possibly-sent request is confirmed only with a read. */
  }
  args.onConfirming?.();
  const query = new URLSearchParams({ action: args.action });
  if (args.target !== null) query.set("target", args.target);
  try {
    const observed = await fetch(`/api/identity/account-management/attempts?${query}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { "Idempotency-Key": args.key },
    });
    return observedResult(await observed.json().catch(() => null), observed.status, true);
  } catch {
    return { state: "ambiguous" };
  }
}
