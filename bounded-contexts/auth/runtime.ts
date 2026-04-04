import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AuthServices } from "./services";
import { getSessionByTokenHash } from "./auth-support/store";
import { AUTH_SESSION_COOKIE_NAME } from "./server";

function parseCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  return new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex < 0) {
          return [part, ""];
        }

        return [
          part.slice(0, separatorIndex),
          decodeURIComponent(part.slice(separatorIndex + 1)),
        ];
      }),
  );
}

export function readAuthSessionToken(request: Request) {
  const cookieToken =
    parseCookieHeader(request.headers.get("cookie")).get(AUTH_SESSION_COOKIE_NAME) ??
    null;
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

export function createAuthBootstrapContext(
  services: AuthServices,
): EventStoreContext {
  return services.identity.createBootstrapContext();
}

export async function resolveActorFromSessionToken(
  services: AuthServices,
  sessionToken: string,
): Promise<ResolvedActor | null> {
  const tokenRecord = await getSessionByTokenHash(
    services.db,
    services.auth.hashSecret(sessionToken),
  );

  if (!tokenRecord || new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return services.identity.resolveActorFromSessionId(tokenRecord.session_id);
}

export async function resolveActorFromRequest(
  services: AuthServices,
  request: Request,
): Promise<ResolvedActor | null> {
  const sessionToken = readAuthSessionToken(request);
  if (!sessionToken) {
    return null;
  }

  return resolveActorFromSessionToken(services, sessionToken);
}
