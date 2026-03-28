import type { NavigationItem } from "@chase-sets/design-system";

export const identityAdminNavItems: NavigationItem[] = [
  { key: "accounts", label: "Accounts", icon: "package", href: "/accounts" },
  { key: "users", label: "Users", icon: "user", href: "/users" },
  { key: "memberships", label: "Memberships", icon: "settings", href: "/memberships" },
  { key: "invitations", label: "Invitations", icon: "info", href: "/invitations" },
  { key: "sessions", label: "Sessions", icon: "clock", href: "/sessions" },
  { key: "api-keys", label: "API Keys", icon: "settings", href: "/api-keys" },
];

export const identityMarketplaceNavItems: NavigationItem[] = [
  { key: "profile", label: "Profile", icon: "user", href: "/account" },
  { key: "team", label: "Team", icon: "settings", href: "/account/team" },
  { key: "security", label: "Security", icon: "settings", href: "/account/security" },
  { key: "consents", label: "Consents", icon: "info", href: "/account/consents" },
];
