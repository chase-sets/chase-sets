import { Hono } from "hono";
import type { AuthServices } from "./support/runtime-support/services";
import { registerAccountSelectionRoutes } from "./support/api-support/account-selection-routes";
import { registerInvitationRoutes } from "./support/api-support/invitation-routes";
import { registerMagicLinkRoutes } from "./support/api-support/magic-link-routes";
import { registerGuestCheckoutRoutes } from "./support/api-support/guest-checkout-routes";
import { registerPasskeyRoutes } from "./support/api-support/passkey-routes";
import { registerPhoneCodeRoutes } from "./support/api-support/phone-code-routes";
import { registerPasswordRoutes } from "./support/api-support/password-routes";
import { registerRegistrationRoutes } from "./support/api-support/register-routes";
import { registerRegistrationConsentRoutes } from "./support/api-support/registration-consent-routes";
import { registerSessionApiRoutes } from "./support/api-support/session-routes";
import { registerSocialLoginRoutes } from "./support/api-support/social-login-routes";
export type { AuthApiEnv } from "./support/api-support/support";
import type { AuthApiEnv } from "./support/api-support/support";

export function buildAuthApi(services: AuthServices) {
  const app = new Hono<AuthApiEnv>();

  registerRegistrationConsentRoutes(app);
  registerRegistrationRoutes(app, services);
  registerSocialLoginRoutes(app, services);
  registerPasswordRoutes(app, services);
  registerMagicLinkRoutes(app, services);
  registerPhoneCodeRoutes(app, services);
  registerGuestCheckoutRoutes(app, services);
  registerAccountSelectionRoutes(app, services);
  registerPasskeyRoutes(app, services);
  registerInvitationRoutes(app, services);
  registerSessionApiRoutes(app, services);

  return app;
}
