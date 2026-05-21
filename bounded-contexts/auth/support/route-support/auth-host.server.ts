import { defineAuthHost } from "./auth-host";
import { catalogAdminAuthHostConfig, identityAdminAuthHostConfig, marketplaceAuthHostConfig } from "./host-config";

export const marketplaceAuthHost = defineAuthHost(marketplaceAuthHostConfig);
export const catalogAdminAuthHost = defineAuthHost(catalogAdminAuthHostConfig);
export const identityAdminAuthHost = defineAuthHost(identityAdminAuthHostConfig);
