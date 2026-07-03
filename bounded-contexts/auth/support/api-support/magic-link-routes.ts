import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { AUTH_MAGIC_LINK_TTL_MS, createExpiryTimestamp } from "../../features/sessions/domain/auth-flow";
import { consumeMagicLinkToken, insertMagicLinkToken } from "../auth-support/store";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  jsonWithMutationReceipts,
  readIdentityMutationConflict,
  type AuthApiApp,
} from "./support";

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim().toLowerCase();
}

function isLocalHost(host: string) {
  const hostname = (host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0])?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function buildPublicOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const host = forwardedHost || request.headers.get("host") || requestUrl.host;
  const protocol =
    forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : requestUrl.protocol.replace(/:$/, "");

  return `${protocol === "http" && !isLocalHost(host) ? "https" : protocol}://${host}`;
}

function safeLandingPath(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/sign-in/magic";
}

function safeReturnTo(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

export function registerMagicLinkRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/magic-link/request", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const user = await services.identity.getUserByEmail(email);
    const tokenId = createId("cmd");
    const token = services.auth.issueOpaqueToken("magic");
    const expiresAt = createExpiryTimestamp(AUTH_MAGIC_LINK_TTL_MS);

    await insertMagicLinkToken(services.db, {
      tokenId,
      userId: user?.user_id ?? null,
      email,
      tokenHash: services.auth.hashSecret(token),
      deliveryToken: token,
      expiresAt,
    });

    await services.eventStore.appendToStream({
      streamId: `auth.magic-link-${tokenId}`,
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "auth.magic-link.requested",
          payload: {
            tokenId,
            userId: user?.user_id ?? null,
            email,
            expiresAt,
            origin: buildPublicOrigin(c.req.raw),
            landingPath: safeLandingPath(body.landingPath),
            returnTo: safeReturnTo(body.returnTo),
          },
        },
      ],
      context: getBootstrapContext(c),
    });

    return c.json({ tokenId, expiresAt });
  });

  app.post("/magic-link/consume", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const record = await consumeMagicLinkToken(services.db, services.auth.hashSecret(String(body.token ?? "")));
    if (!record) {
      return c.json({ error: t("auth.support.apiSupport.magicLinkRoutes.magic.link.is.invalid.or.has") }, 401);
    }

    let user = record.user_id
      ? await services.identity.getUser(record.user_id)
      : await services.identity.getUserByEmail(record.email);

    if (!user) {
      let identity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>>;
      try {
        identity = await identityMutations.createPersonalIdentity({
          email: record.email,
          displayName: createOwnedUserDisplayName(record.email),
        });
      } catch (error) {
        const conflict = readIdentityMutationConflict(error);
        if (conflict) {
          return c.json(conflict, 409);
        }

        throw error;
      }
      const authResult = await startInteractiveAuth(services, {
        userId: identity.userId,
        accountId: identity.accountId,
        authenticationMethod: "magic-link",
        context: getBootstrapContext(c),
        membershipsOverride: [
          {
            membershipId: identity.membershipId,
            accountId: identity.accountId,
            roleKey: "owner",
            status: "active",
            rolePermissions: AUTH_ROLE_PERMISSIONS.owner,
          },
        ],
      });

      return jsonWithMutationReceipts(c, authResult, 200, [identity]);
    }

    const authResult = await startInteractiveAuth(services, {
      userId: user!.user_id,
      accountId: typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "magic-link",
      context: getBootstrapContext(c),
    });

    return c.json(authResult);
  });
}
