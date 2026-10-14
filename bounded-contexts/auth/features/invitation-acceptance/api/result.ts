export type InvitationAttemptResult = Readonly<{
  type: "accepted-reauth-required" | "confirming" | "ambiguous";
  attemptId: string;
}>;
