import { Hono } from "hono";
import type { AuthServices } from "./services";
import { registerAccountSelectionRoutes } from "./auth-api/account-selection-routes";
import { registerInvitationRoutes } from "./auth-api/invitation-routes";
import { registerMagicLinkRoutes } from "./auth-api/magic-link-routes";
import { registerPasskeyRoutes } from "./auth-api/passkey-routes";
import { registerPasswordRoutes } from "./auth-api/password-routes";
import { registerRegistrationRoutes } from "./auth-api/register-routes";
import { registerSessionApiRoutes } from "./auth-api/session-routes";
export type { AuthApiEnv } from "./auth-api/support";
import type { AuthApiEnv } from "./auth-api/support";

export function buildAuthApi(services: AuthServices) {
  const app = new Hono<AuthApiEnv>();

  registerRegistrationRoutes(app, services);
  registerPasswordRoutes(app, services);
  registerMagicLinkRoutes(app, services);
  registerAccountSelectionRoutes(app, services);
  registerPasskeyRoutes(app, services);
  registerInvitationRoutes(app, services);
  registerSessionApiRoutes(app, services);

  return app;
}
