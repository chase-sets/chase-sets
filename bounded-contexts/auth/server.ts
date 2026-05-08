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
