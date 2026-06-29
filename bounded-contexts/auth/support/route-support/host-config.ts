import type { AuthHostConfig } from "./auth-host";

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
  signInMethods: ["password", "phone-code", "magic-link", "passkey"],
  allowManualMagicLinkTokenEntry: false,
  titles: {
    signIn: "Sign In | Marketplace",
    accountSelection: "Select Account | Marketplace",
    register: "Register | Marketplace",
  },
} satisfies AuthHostDefinition;

export const adminAuthHostConfig = {
  hostLabel: "Admin",
  signInPath: "/access/sign-in",
  fallbackPath: "/",
  defaultSuccessPath: "/",
  accountSelectionPath: "/access/account-select",
  signedOutReturnTo: "/access/sign-in",
  signInMethods: ["password", "phone-code", "magic-link", "passkey"],
  allowManualMagicLinkTokenEntry: false,
  titles: {
    signIn: "Sign In | Admin",
    accountSelection: "Select Account | Admin",
    sessions: "Sessions | Access Admin",
    sessionDetail: "Session Detail | Access Admin",
  },
} satisfies AuthHostDefinition;
