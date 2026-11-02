import { getSafeSameSitePath } from "../auth-support/same-site-path";

export function isSafeInAppReturnTo(value: string | null): value is string {
  return value !== null && getSafeSameSitePath(value) === value;
}

export function getSafeAdminReturnTo(searchParams: URLSearchParams, fallback: string) {
  const returnTo = searchParams.get("returnTo");
  return isSafeInAppReturnTo(returnTo) ? returnTo : fallback;
}

export function createAdminGoogleWorkspaceSocialLoginHref(returnTo: string) {
  const searchParams = new URLSearchParams({
    journey: "admin",
    returnTo,
  });
  return `/api/auth/social/google/start?${searchParams.toString()}`;
}
