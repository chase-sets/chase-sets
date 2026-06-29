import { defineAuthHost } from "./auth-host";
import { adminAuthHostConfig, marketplaceAuthHostConfig } from "./host-config";

export const marketplaceAuthHost = defineAuthHost(marketplaceAuthHostConfig);
export const adminAuthHost = defineAuthHost(adminAuthHostConfig);
