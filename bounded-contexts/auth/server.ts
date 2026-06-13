export * from "./support/route-support/auth-host";
export {
  bootstrapPlatformAdminPassword,
  type PlatformAdminPasswordBootstrapConfig,
} from "./support/runtime-support/production-bootstrap";
export { resolveActorFromSessionId } from "./support/runtime-support/services";
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
export { createUcpOAuthMetadataRoutes, createUcpOAuthRoutes } from "./support/ucp-support/oauth";
