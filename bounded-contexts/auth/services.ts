import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createAuthSecretAdapters } from "./auth-support/adapters";
import {
  createIdentityAuthBridge,
  type IdentityAuthBridge,
  type IdentityServices,
} from "@chase-sets/identity/integration";

export type AuthServices = Readonly<{
  db: PgQueryable;
  auth: ReturnType<typeof createAuthSecretAdapters>;
  identity: IdentityAuthBridge;
  projectors: IdentityServices["projectors"];
}>;

export function createAuthServices(
  identityServices: IdentityServices,
): AuthServices {
  return {
    db: identityServices.db,
    auth: createAuthSecretAdapters(),
    identity: createIdentityAuthBridge(identityServices),
    projectors: identityServices.projectors,
  };
}
