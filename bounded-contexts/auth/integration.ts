export type AuthContextBoundary = Readonly<{
  ownership: "authentication";
  owns: readonly [
    "sign-in",
    "registration",
    "account-selection",
    "sign-out",
    "browser-session-resolution",
  ];
  delegatesTo: readonly ["identity-management"];
}>;

export const authContextBoundary: AuthContextBoundary = {
  ownership: "authentication",
  owns: [
    "sign-in",
    "registration",
    "account-selection",
    "sign-out",
    "browser-session-resolution",
  ],
  delegatesTo: ["identity-management"],
};
