import { defineAuthHost, type AuthHostConfig } from "./server";

export type AuthHostDefinition = AuthHostConfig &
  Readonly<{
    hostLabel: string;
    titles: Readonly<{
      signIn: string;
      accountSelection: string;
      register?: string;
      sessions?: string;
      sessionDetail?: string;
    }>;
  }>;

export const marketplaceAuthHostConfig = {
  hostLabel: "Marketplace",
  signInPath: "/sign-in",
  fallbackPath: "/account",
  defaultSuccessPath: "/account",
  accountSelectionPath: "/account/select",
  signedOutReturnTo: "/search",
  titles: {
    signIn: "Sign In | Marketplace",
    accountSelection: "Select Account | Marketplace",
    register: "Register | Marketplace",
  },
} satisfies AuthHostDefinition;

export const catalogAdminAuthHostConfig = {
  hostLabel: "Catalog Admin",
  signInPath: "/sign-in",
  fallbackPath: "/dimensions",
  defaultSuccessPath: "/dimensions",
  accountSelectionPath: "/account-select",
  requiredPermission: "catalog.view",
  signedOutReturnTo: "/sign-in",
  titles: {
    signIn: "Sign In | Catalog Admin",
    accountSelection: "Select Account | Catalog Admin",
  },
} satisfies AuthHostDefinition;

export const identityAdminAuthHostConfig = {
  hostLabel: "Identity Admin",
  signInPath: "/sign-in",
  fallbackPath: "/accounts",
  defaultSuccessPath: "/accounts",
  accountSelectionPath: "/account-select",
  requiredPermission: "security.manage",
  signedOutReturnTo: "/sign-in",
  titles: {
    signIn: "Sign In | Identity Admin",
    accountSelection: "Select Account | Identity Admin",
    sessions: "Sessions | Identity Admin",
    sessionDetail: "Session Detail | Identity Admin",
  },
} satisfies AuthHostDefinition;

export const marketplaceAuthHost = defineAuthHost(marketplaceAuthHostConfig);
export const catalogAdminAuthHost = defineAuthHost(catalogAdminAuthHostConfig);
export const identityAdminAuthHost = defineAuthHost(identityAdminAuthHostConfig);
