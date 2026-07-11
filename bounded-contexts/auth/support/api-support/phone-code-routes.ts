import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { randomInt } from "node:crypto";
import { authSecurityLifetimesOf, createExpiryTimestamp } from "../../features/sessions/domain/auth-flow";
import { mapPhoneCodeRequestedToNotification } from "../../features/sessions/integrations/notifications/notification-intents";
import { normalizeAuthPhoneNumber } from "../auth-support/identity-projection";
import { consumePhoneCodeToken, insertPhoneCodeToken } from "../auth-support/store";
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
import { requireRegistrationAdmission } from "./registration-gates";

const PHONE_CODE_NOTIFICATION_PROJECTION = "auth-phone-code-notification-intent";

function normalizePhoneCode(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/[\s-]+/g, "");
}

export function registerPhoneCodeRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/phone-code/request", async (c) => {
    const body = await c.req.json();
    const phone = normalizeAuthPhoneNumber(String(body.phone ?? ""));
    if (!phone) {
      return c.json({ error: t("auth.support.apiSupport.phoneCodeRoutes.phone.is.required") }, 400);
    }

    const user = await services.identity.getUserByPhone(phone);
    if (!user) {
      const admission = await requireRegistrationAdmission(services, null);
      if (!admission.ok) {
        return c.json(admission.failure.body, admission.failure.status);
      }
    }

    const tokenId = createId("cmd");
    const code = createPhoneCode();
    const expiresAt = createExpiryTimestamp(authSecurityLifetimesOf(services).magicLinkTtlMs);

    await insertPhoneCodeToken(services.db, {
      tokenId,
      userId: user?.user_id ?? null,
      phone,
      codeHash: services.auth.hashSecret(createPhoneCodeSecret(phone, code)),
      deliveryCode: code,
      expiresAt,
    });

    await services.notificationOutbox.enqueueNotification({
      message: mapPhoneCodeRequestedToNotification({
        phone,
        code,
        correlationId: getBootstrapContext(c).trace?.traceId ?? tokenId,
        idempotencyKey: `auth:phone-code:${tokenId}`,
      }),
      source: {
        sourceEventId: tokenId,
        sourceGlobalPosition: "0",
        projectionName: PHONE_CODE_NOTIFICATION_PROJECTION,
        occurredAt: new Date().toISOString(),
      },
      maxAttempts: 3,
    });

    return c.json({ tokenId, phone, expiresAt });
  });

  app.post("/phone-code/consume", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const phone = normalizeAuthPhoneNumber(String(body.phone ?? ""));
    const code = normalizePhoneCode(body.code);
    if (!phone || !code) {
      return c.json({ error: t("auth.support.apiSupport.phoneCodeRoutes.phone.and.code.are.required") }, 400);
    }

    const record = await consumePhoneCodeToken(services.db, {
      phone,
      codeHash: services.auth.hashSecret(createPhoneCodeSecret(phone, code)),
    });
    if (!record) {
      return c.json({ error: t("auth.support.apiSupport.phoneCodeRoutes.phone.code.is.invalid.or.has") }, 401);
    }

    let user = record.user_id
      ? await services.identity.getUser(record.user_id)
      : await services.identity.getUserByPhone(record.phone);

    if (!user) {
      const admission = await requireRegistrationAdmission(services, null);
      if (!admission.ok) {
        return c.json(admission.failure.body, admission.failure.status);
      }

      let identity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>>;
      try {
        identity = await identityMutations.createPersonalIdentity({
          phone: record.phone,
          displayName:
            typeof body.displayName === "string" && body.displayName.trim()
              ? body.displayName.trim()
              : createOwnedUserDisplayName(record.phone),
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
        authenticationMethod: "sms-code",
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

    if (!user.auth_methods.includes("sms-code")) {
      await identityMutations.enableSmsCode({ userId: user.user_id });
    }

    const authResult = await startInteractiveAuth(services, {
      userId: user.user_id,
      accountId: typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "sms-code",
      context: getBootstrapContext(c),
    });

    return c.json(authResult);
  });
}

function createPhoneCode() {
  return String(randomInt(100000, 1000000));
}

function createPhoneCodeSecret(phone: string, code: string) {
  return `${phone}:${code}`;
}
