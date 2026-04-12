import type { AuthHostConfig } from "./server";

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
  signInPath: "/catalog/sign-in",
  fallbackPath: "/catalog/dimensions",
  defaultSuccessPath: "/catalog/dimensions",
  accountSelectionPath: "/catalog/account-select",
  requiredPermission: "catalog.view",
  signedOutReturnTo: "/catalog/sign-in",
  titles: {
    signIn: "Sign In | Catalog Admin",
    accountSelection: "Select Account | Catalog Admin",
  },
} satisfies AuthHostDefinition;

export const identityAdminAuthHostConfig = {
  hostLabel: "Identity Admin",
  signInPath: "/identity/sign-in",
  fallbackPath: "/identity/accounts",
  defaultSuccessPath: "/identity/accounts",
  accountSelectionPath: "/identity/account-select",
  requiredPermission: "security.manage",
  signedOutReturnTo: "/identity/sign-in",
  titles: {
    signIn: "Sign In | Identity Admin",
    accountSelection: "Select Account | Identity Admin",
    sessions: "Sessions | Identity Admin",
    sessionDetail: "Session Detail | Identity Admin",
  },
} satisfies AuthHostDefinition;
