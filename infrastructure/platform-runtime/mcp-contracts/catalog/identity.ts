import {
  type McpServiceDescriptor,
  booleanProperty,
  idempotencyKeyProperty,
  integerProperty,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const optionalListSchema = objectSchema({
  search: stringProperty("Optional search term."),
  status: stringProperty("Optional status filter."),
  limit: integerProperty("Maximum number of records to return."),
  offset: integerProperty("Number of records to skip."),
});
const idempotent = {
  idempotencyKey: idempotencyKeyProperty(),
  confirmed: booleanProperty("Explicit confirmation that the requested action is intended."),
  confirmationText: stringProperty("Exact tool title confirmation text."),
} as const;
const operatorRead = (name: string, title: string, description: string, permission: string, inputSchema: ReturnType<typeof objectSchema>, targetType: string) => ({
  ...readTool("identity", name, title, description, permission, inputSchema, targetType, [], "operator"),
  availability: "available" as const,
});
const operatorWrite = (name: string, title: string, description: string, permission: string, inputSchema: ReturnType<typeof objectSchema>, targetType: string, risk: "sensitive" | "destructive" = "sensitive") => ({
  ...writeTool("identity", name, title, description, permission, inputSchema, targetType, [], risk, "operator"),
  availability: "available" as const,
});
const accountId = stringProperty("Target account identifier.");
const userId = stringProperty("Target user identifier.");
const membershipId = stringProperty("Target membership identifier.");
const invitationId = stringProperty("Target invitation identifier.");

export const identityService = {
  ...service("identity", "Identity", "bounded-contexts/identity", "Accounts, users, memberships, invitations, consent, and API keys.", "accounts.view", ["account"], { packageName: "@chase-sets/identity" }),
  tools: [
    { ...readTool("identity", "get-account", "Get Account", "Read account profile, status, and membership summary.", "accounts.view", objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]), "account", ["Use when an agent needs account profile facts or status."]), availability: "available" as const },
    readTool("identity", "list-memberships", "List Memberships", "List account memberships and role permissions.", "memberships.view", objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]), "membership", ["Use before inviting, changing, or revoking team access."]),
    operatorRead("list-accounts", "List Accounts", "List accounts visible to an operator.", "accounts.view", optionalListSchema, "account"),
    operatorRead("list-users", "List Users", "List users visible to an operator.", "security.manage", optionalListSchema, "user"),
    operatorRead("get-account-access-hub", "Get Account Access Hub", "Read the account administration access hub.", "accounts.view", objectSchema({ accountId }, ["accountId"]), "account"),
    operatorRead("get-user-account-link", "Get User Account Link", "Read the accounts linked to a user.", "accounts.view", objectSchema({ userId }, ["userId"]), "user"),
    operatorWrite("update-account-profile", "Update Account Profile", "Update an account profile.", "accounts.manage", objectSchema({ accountId, name: stringProperty("Account legal name."), displayName: stringProperty("Account display name."), ...idempotent }, ["accountId", "name", "displayName", "idempotencyKey", "confirmed", "confirmationText"]), "account"),
    operatorWrite("suspend-account", "Suspend Account", "Suspend an account with an enforcement reason.", "accounts.manage", objectSchema({ accountId, reason: stringProperty("Enforcement reason."), reference: stringProperty("Optional supporting reference."), ...idempotent }, ["accountId", "reason", "reference", "idempotencyKey", "confirmed", "confirmationText"]), "account", "destructive"),
    operatorWrite("reactivate-account", "Reactivate Account", "Reactivate a suspended account.", "accounts.manage", objectSchema({ accountId, reason: stringProperty("Reversal reason."), reference: stringProperty("Optional supporting reference."), ...idempotent }, ["accountId", "reason", "reference", "idempotencyKey", "confirmed", "confirmationText"]), "account"),
    operatorWrite("close-account", "Close Account", "Close an account with an enforcement reason.", "accounts.manage", objectSchema({ accountId, reason: stringProperty("Enforcement reason."), reference: stringProperty("Optional supporting reference."), ...idempotent }, ["accountId", "reason", "reference", "idempotencyKey", "confirmed", "confirmationText"]), "account", "destructive"),
    operatorWrite("assign-account-badge", "Assign Account Badge", "Assign a supported badge to an account.", "accounts.manage", objectSchema({ accountId, badgeKey: stringProperty("Supported account badge key."), ...idempotent }, ["accountId", "badgeKey", "idempotencyKey", "confirmed", "confirmationText"]), "account"),
    operatorWrite("remove-account-badge", "Remove Account Badge", "Remove a supported badge from an account.", "accounts.manage", objectSchema({ accountId, badgeKey: stringProperty("Supported account badge key."), ...idempotent }, ["accountId", "badgeKey", "idempotencyKey", "confirmed", "confirmationText"]), "account", "destructive"),
    operatorWrite("create-invitation", "Create Invitation", "Create a membership invitation.", "memberships.manage", objectSchema({ accountId, email: stringProperty("Invitee email address."), roleKey: stringProperty("Role to grant."), ...idempotent }, ["accountId", "email", "roleKey", "idempotencyKey", "confirmed", "confirmationText"]), "invitation"),
    operatorWrite("change-membership-role", "Change Membership Role", "Change a membership role.", "memberships.manage", objectSchema({ membershipId, roleKey: stringProperty("Role to grant."), ...idempotent }, ["membershipId", "roleKey", "idempotencyKey", "confirmed", "confirmationText"]), "membership"),
    operatorWrite("revoke-membership", "Revoke Membership", "Revoke a membership.", "memberships.manage", objectSchema({ membershipId, ...idempotent }, ["membershipId", "idempotencyKey", "confirmed", "confirmationText"]), "membership", "destructive"),
    operatorWrite("reinstate-membership", "Reinstate Membership", "Reinstate a membership.", "memberships.manage", objectSchema({ membershipId, ...idempotent }, ["membershipId", "idempotencyKey", "confirmed", "confirmationText"]), "membership"),
    operatorWrite("resend-invitation", "Resend Invitation", "Resend a pending invitation.", "memberships.manage", objectSchema({ invitationId, expiresAt: stringProperty("New invitation expiry instant."), ...idempotent }, ["invitationId", "expiresAt", "idempotencyKey", "confirmed", "confirmationText"]), "invitation"),
    operatorWrite("cancel-invitation", "Cancel Invitation", "Cancel a pending invitation.", "memberships.manage", objectSchema({ invitationId, ...idempotent }, ["invitationId", "idempotencyKey", "confirmed", "confirmationText"]), "invitation", "destructive"),
    operatorWrite("decline-invitation", "Decline Invitation", "Decline an invitation.", "memberships.manage", objectSchema({ invitationId, ...idempotent }, ["invitationId", "idempotencyKey", "confirmed", "confirmationText"]), "invitation", "destructive"),
    operatorWrite("update-user-profile", "Update User Profile", "Update a user profile.", "security.manage", objectSchema({ userId, displayName: stringProperty("User display name."), givenName: stringProperty("User given name."), familyName: stringProperty("User family name."), ...idempotent }, ["userId", "displayName", "givenName", "familyName", "idempotencyKey", "confirmed", "confirmationText"]), "user"),
    operatorWrite("suspend-user", "Suspend User", "Suspend a user.", "security.manage", objectSchema({ userId, ...idempotent }, ["userId", "idempotencyKey", "confirmed", "confirmationText"]), "user", "destructive"),
    operatorWrite("reactivate-user", "Reactivate User", "Reactivate a suspended user.", "security.manage", objectSchema({ userId, ...idempotent }, ["userId", "idempotencyKey", "confirmed", "confirmationText"]), "user"),
    operatorWrite("add-user-contact-method", "Add User Contact Method", "Add a contact method to a user.", "security.manage", objectSchema({ userId, contactMethodType: stringProperty("Contact method type.", ["email", "phone"]), value: stringProperty("Contact method value."), ...idempotent }, ["userId", "contactMethodType", "value", "idempotencyKey", "confirmed", "confirmationText"]), "user"),
    operatorWrite("verify-user-contact-method", "Verify User Contact Method", "Verify an existing user contact method.", "security.manage", objectSchema({ userId, contactMethodId: stringProperty("Contact method identifier."), ...idempotent }, ["userId", "contactMethodId", "idempotencyKey", "confirmed", "confirmationText"]), "user"),
    operatorWrite("enable-user-auth-method", "Enable User Auth Method", "Enable a non-secret authentication method.", "security.manage", objectSchema({ userId, authMethod: stringProperty("Authentication method.", ["password", "magic-link", "passkey", "sms-code", "social-login"]), ...idempotent }, ["userId", "authMethod", "idempotencyKey", "confirmed", "confirmationText"]), "user"),
    operatorWrite("disable-user-auth-method", "Disable User Auth Method", "Disable a user authentication method.", "security.manage", objectSchema({ userId, authMethod: stringProperty("Authentication method.", ["password", "magic-link", "passkey", "sms-code", "social-login"]), ...idempotent }, ["userId", "authMethod", "idempotencyKey", "confirmed", "confirmationText"]), "user", "destructive"),
    operatorWrite("revoke-api-key", "Revoke API Key", "Revoke an account API key.", "security.manage", objectSchema({ apiKeyId: stringProperty("API key to revoke."), ...idempotent }, ["apiKeyId", "idempotencyKey", "confirmed", "confirmationText"]), "api-key", "destructive"),
  ],
  resources: [
    { ...resource("identity", "chase-sets://identity/{accountId}/account", "Account", "Account profile, badge, and lifecycle read model.", "accounts.view", ["Use when an agent needs account profile facts or status."]), availability: "available" as const },
    resource("identity", "chase-sets://identity/{accountId}/memberships", "Memberships", "Account membership and permission read model.", "memberships.view", ["Use before any team or role mutation."]),
  ],
} as const satisfies McpServiceDescriptor;
