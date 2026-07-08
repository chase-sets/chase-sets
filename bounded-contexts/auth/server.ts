export * from "./support/route-support/auth-host";
export {
  bootstrapPlatformAdminPassword,
  type PlatformAdminPasswordBootstrapConfig,
} from "./support/runtime-support/production-bootstrap";
export { resolveActorFromSessionId } from "./support/runtime-support/services";
export {
  AUTH_GUEST_CHECKOUT_PERMISSIONS,
  AUTH_GUEST_CHECKOUT_ROLE_KEY,
  AUTH_GUEST_CHECKOUT_USER_ID,
  createGuestCheckoutActor,
  isGuestCheckoutActor,
  resolveActorFromRequest,
  resolveActorFromSessionToken,
  resolveGuestCheckoutActor,
  type AuthLinkedPlatformAuthorizationResolver,
  type AuthRequestActorResolverOptions,
} from "./support/runtime-support/runtime";
export {
  AuthApiError,
  createAuthRequestApiClient,
  createInternalAuthRequestApiClient,
} from "./support/request-support/api-client";
export { clearGuestCheckoutCookie } from "./support/auth-support/http";
export {
  createFacebookSocialLoginProvider,
  createGoogleSocialLoginProvider,
  type SocialLoginProvider,
  type SocialLoginProviderName,
  type SocialLoginProfile,
} from "./support/social-login-support/providers";
export {
  createUcpOAuthMetadataRoutes,
  createUcpOAuthRoutes,
  resolveUcpScopedPermissions,
  UCP_OAUTH_SCOPE_FAMILIES,
  UCP_OAUTH_SUPPORTED_SCOPES,
} from "./support/ucp-support/oauth";
