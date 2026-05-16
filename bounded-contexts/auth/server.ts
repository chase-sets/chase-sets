export * from "./support/route-support/auth-host";
export {
  bootstrapPlatformAdminPassword,
  type PlatformAdminPasswordBootstrapConfig,
} from "./support/runtime-support/production-bootstrap";
export {
  AuthApiError,
  createAuthRequestApiClient,
  createInternalAuthRequestApiClient,
} from "./support/request-support/api-client";
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
} from "./support/ucp-support/oauth";
