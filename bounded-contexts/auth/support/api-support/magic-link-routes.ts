import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  AUTH_MAGIC_LINK_TTL_MS,
  createExpiryTimestamp,
} from "../../features/sessions/domain/auth-flow";
import {
  consumeMagicLinkToken,
  insertMagicLinkToken,
} from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  type AuthApiApp,
} from "./support";

export function registerMagicLinkRoutes(
  app: AuthApiApp,
  services: AuthServices,
) {
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
      expiresAt,
    });

    return c.json({ tokenId, token, expiresAt });
  });

  app.post("/magic-link/consume", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const record = await consumeMagicLinkToken(
      services.db,
      services.auth.hashSecret(String(body.token ?? "")),
    );
    if (!record) {
      return c.json({ error: t("auth.support.apiSupport.magicLinkRoutes.magic.link.is.invalid.or.has") }, 401);
    }

    let user = record.user_id
      ? await services.identity.getUser(record.user_id)
      : await services.identity.getUserByEmail(record.email);

    if (!user) {
      const identity = await identityMutations.createPersonalIdentity({
        email: record.email,
        displayName: createOwnedUserDisplayName(record.email),
      });
      user = await services.identity.getUser(identity.userId);
    }

    const authResult = await startInteractiveAuth(services, {
      userId: user!.user_id,
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "magic-link",
      context: getBootstrapContext(c),
    });

    return c.json(authResult);
  });
}
