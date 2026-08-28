import type {
  PortableRouteInput,
  PortableRouteMutationInput,
  PortableRouteOutcome,
} from "@chase-sets/bounded-context-module";
import type { PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { createIdentityApiClient, IdentityApiError } from "../../../support/shell-support/api/client";
import type { Account } from "./contracts";
import type { CurrentActorDisplay } from "../../../support/shell-support/current-actor-display";

type PortableActor = Readonly<{
  accountId: string;
  permissions: readonly string[];
}>;

export type PortableAccountRouteData = Readonly<{
  account: Account;
  actorDisplay: CurrentActorDisplay | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPortableActor(value: unknown): PortableActor | null {
  if (!isRecord(value) || typeof value.accountId !== "string" || !Array.isArray(value.permissions)) {
    return null;
  }
  if (!value.permissions.every((permission) => typeof permission === "string")) {
    return null;
  }
  return { accountId: value.accountId, permissions: value.permissions };
}

async function resolvePortableActor(
  apiOrigin: string,
  fetch: PortableClientFetch,
): Promise<PortableRouteOutcome<PortableActor>> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/session", apiOrigin), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
  } catch {
    return { kind: "transient-error" };
  }
  if (response.status === 401) return { kind: "unauthorized" };
  if (!response.ok) return { kind: "transient-error" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "transient-error" };
  }
  const actor = isRecord(body) ? readPortableActor(body.actor) : null;
  return actor ? { kind: "data", data: actor } : { kind: "transient-error" };
}

function requirePermission(actor: PortableActor, permission: string): PortableRouteOutcome<never> | null {
  return actor.permissions.includes(permission) ? null : { kind: "forbidden", requiredPermissions: [permission] };
}

function identityClient(apiOrigin: string, fetch: PortableClientFetch) {
  return createIdentityApiClient({
    baseUrl: new URL("/api/identity", apiOrigin).toString(),
    fetch,
    credentials: "include",
  });
}

export async function loadPortableAccountRoute(
  _input: PortableRouteInput,
  context: Readonly<{ apiOrigin: string; fetch: PortableClientFetch }>,
): Promise<PortableRouteOutcome<PortableAccountRouteData>> {
  const actorResult = await resolvePortableActor(context.apiOrigin, context.fetch);
  if (actorResult.kind !== "data") return actorResult;
  const forbidden = requirePermission(actorResult.data, "accounts.view");
  if (forbidden) return forbidden;

  const api = identityClient(context.apiOrigin, context.fetch);
  try {
    const [account, actorDisplay] = await Promise.all([
      api.getAccount<Account>(actorResult.data.accountId),
      api.getCurrentActorDisplay<CurrentActorDisplay>().catch(() => null),
    ]);
    return { kind: "data", data: { account, actorDisplay } };
  } catch (error) {
    if (error instanceof IdentityApiError) {
      if (error.status === 401) return { kind: "unauthorized" };
      if (error.status === 403) return { kind: "forbidden", requiredPermissions: ["accounts.view"] };
      if (error.status === 404) return { kind: "not-found" };
      if (error.status >= 500) return { kind: "transient-error" };
    }
    if (error instanceof TypeError) return { kind: "transient-error" };
    throw error;
  }
}

export async function mutatePortableAccountRoute(
  input: PortableRouteMutationInput,
  context: Readonly<{ apiOrigin: string; fetch: PortableClientFetch }>,
): Promise<PortableRouteOutcome<unknown, unknown>> {
  const actorResult = await resolvePortableActor(context.apiOrigin, context.fetch);
  if (actorResult.kind !== "data") return actorResult;
  const forbidden = requirePermission(actorResult.data, "accounts.manage");
  if (forbidden) return forbidden;

  const intent = String(input.formData.get("intent") ?? "");
  if (intent !== "update-profile") {
    return { kind: "navigate", to: "/account" };
  }
  try {
    await identityClient(context.apiOrigin, context.fetch).updateAccount(actorResult.data.accountId, {
      name: String(input.formData.get("name") ?? ""),
      displayName: String(input.formData.get("displayName") ?? ""),
    });
    return { kind: "navigate", to: "/account" };
  } catch (error) {
    if (error instanceof IdentityApiError) {
      if (error.status === 400 || error.status === 422) {
        return { kind: "validation-error", error: error.body };
      }
      if (error.status === 401) return { kind: "unauthorized" };
      if (error.status === 403) return { kind: "forbidden", requiredPermissions: ["accounts.manage"] };
      if (error.status === 404) return { kind: "not-found" };
      if (error.status >= 500) return { kind: "transient-error" };
    }
    if (error instanceof TypeError) return { kind: "transient-error" };
    throw error;
  }
}
