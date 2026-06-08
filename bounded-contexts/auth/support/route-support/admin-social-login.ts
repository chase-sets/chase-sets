export type AdminSocialLoginJourney = "access-admin" | "catalog-admin";

export function isSafeInAppReturnTo(value: string | null): value is string {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function getSafeAdminReturnTo(searchParams: URLSearchParams, fallback: string) {
  const returnTo = searchParams.get("returnTo");
  return isSafeInAppReturnTo(returnTo) ? returnTo : fallback;
}

export function createAdminGoogleWorkspaceSocialLoginHref(journey: AdminSocialLoginJourney, returnTo: string) {
  const searchParams = new URLSearchParams({
    journey,
    returnTo,
  });
  return `/api/auth/social/google/start?${searchParams.toString()}`;
}
