import { defineAuthHost } from "./auth-host";
import { accessAdminAuthHostConfig, catalogAdminAuthHostConfig, marketplaceAuthHostConfig } from "./host-config";

export const marketplaceAuthHost = defineAuthHost(marketplaceAuthHostConfig);
export const catalogAdminAuthHost = defineAuthHost(catalogAdminAuthHostConfig);
export const accessAdminAuthHost = defineAuthHost(accessAdminAuthHostConfig);
