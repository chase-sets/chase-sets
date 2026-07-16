import type { AuthServices } from "./services";
import { upsertPasswordCredential } from "../auth-support/store";

export type PlatformAdminPasswordBootstrapConfig = Readonly<{
  userId: string;
  credentialId: string;
  password: string;
}>;

export async function bootstrapPlatformAdminPassword(
  services: AuthServices,
  config: PlatformAdminPasswordBootstrapConfig,
) {
  if (!config.password.trim()) {
    throw new Error("PLATFORM_ADMIN_PASSWORD is required.");
  }

  await upsertPasswordCredential(services.db, {
    userId: config.userId,
    credentialId: config.credentialId,
    secretHash: await services.auth.hashPassword(config.password),
  });
}
