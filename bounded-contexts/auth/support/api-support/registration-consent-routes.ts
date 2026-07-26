import { createIdentityMutations, type AuthApiApp } from "./support";

/**
 * The anonymous read that lets a caller obtain a registration consent
 * resolution before it registers.
 *
 * Auth owns the public surface; Identity owns the value. This route mints
 * nothing -- it forwards Identity's signed resolution unchanged, so a caller
 * that reaches Auth and a caller that could somehow reach Identity directly get
 * the same non-forgeable value, and Auth never holds signing key material.
 */
export function registerRegistrationConsentRoutes(app: AuthApiApp) {
  app.get("/registration-consent", async (c) => c.json(await createIdentityMutations(c).resolveRegistrationConsent()));
}
