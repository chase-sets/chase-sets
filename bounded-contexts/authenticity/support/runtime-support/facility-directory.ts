export type AuthenticityFacilityAddress = Readonly<{
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;

export type AuthenticityFacilityProfile = Readonly<{
  facilityId: string;
  operatingIdentity: string;
  address: AuthenticityFacilityAddress;
}>;

/**
 * Provider-port seam (m109 epic design pillar 1). Today there is exactly one
 * platform-operated facility: the inspection workbench IS the facility
 * software. Third-party authenticator facilities and multi-facility routing
 * are a Phase-3 seam, not a rebuild -- a future implementation of this port
 * slots in without touching AuthenticityCase domain logic.
 *
 * Facility address and operating identity are platform config, not domain
 * state: this context never models a Facility aggregate.
 */
export type AuthenticityFacilityDirectoryPort = Readonly<{
  getFacilityForCase: (params: Readonly<{ orderId: string }>) => Promise<AuthenticityFacilityProfile>;
}>;

export type AuthenticityFacilityConfig = Readonly<{
  facilityId: string;
  operatingIdentity: string;
  address: AuthenticityFacilityAddress;
}>;

export function createPlatformOperatedFacilityDirectory(
  config: AuthenticityFacilityConfig,
): AuthenticityFacilityDirectoryPort {
  const profile: AuthenticityFacilityProfile = {
    facilityId: config.facilityId,
    operatingIdentity: config.operatingIdentity,
    address: config.address,
  };

  return {
    getFacilityForCase: async () => profile,
  };
}
