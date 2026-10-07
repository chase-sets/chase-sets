import { CHANNEL_CONNECTOR_SCOPE_FAMILY } from "@chase-sets/auth-context";
import {
  closedRecord,
  connectorValue,
  ExtensionCredentialError,
  parseExtensionCredential,
  type ExtensionCredential,
  type ExtensionProfile,
} from "./extension-records";

export function admitConnectorTokens(
  value: unknown,
  profile: ExtensionProfile,
  binding: Readonly<{ issuer: string; clientId: string; now: string; previous?: ExtensionCredential }>,
): ExtensionCredential {
  try {
    const wire = closedRecord(value, [
      "access_token",
      "refresh_token",
      "token_type",
      "expires_in",
      "scope",
      "connection_id",
    ]);
    const connectionId = connectorValue(wire.connection_id);
    if (
      wire.token_type !== "Bearer" ||
      wire.scope !== CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" ") ||
      typeof wire.expires_in !== "number" ||
      !Number.isSafeInteger(wire.expires_in) ||
      wire.expires_in <= 0 ||
      connectionId !== profile.connectionId ||
      (binding.previous &&
        (binding.previous.connectionId !== connectionId ||
          binding.previous.issuer !== binding.issuer ||
          binding.previous.clientId !== binding.clientId ||
          binding.previous.refreshToken === wire.refresh_token ||
          binding.previous.accessToken === wire.access_token))
    )
      throw new ExtensionCredentialError("invalid-token-response");
    return parseExtensionCredential({
      schemaVersion: 1,
      issuer: binding.issuer,
      clientId: binding.clientId,
      connectionId,
      accessToken: wire.access_token,
      refreshToken: wire.refresh_token,
      accessExpiresAt: new Date(new Date(binding.now).getTime() + wire.expires_in * 1000).toISOString(),
      rotatedAt: binding.now,
      boundProfileRevision: profile.revision,
      boundProfileState: profile.state,
    });
  } catch {
    throw new ExtensionCredentialError("invalid-token-response");
  }
}
