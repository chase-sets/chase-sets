import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { normalizeEmail } from "../common";
import { IDENTITY_BOOTSTRAP_TENANT_ID } from "../constants";
import { createIdentityBootstrapContext } from "../bootstrap-context";
import type { IdentityServices } from "../services";

export type IdentityBootstrapPort = Readonly<{
  bootstrapTenantId: string;
  createBootstrapContext: () => EventStoreContext;
  normalizeEmail: typeof normalizeEmail;
}>;

export function createIdentityBootstrapPort(
  services: IdentityServices,
): IdentityBootstrapPort {
  void services;

  return {
    bootstrapTenantId: IDENTITY_BOOTSTRAP_TENANT_ID,
    createBootstrapContext: createIdentityBootstrapContext,
    normalizeEmail,
  };
}
