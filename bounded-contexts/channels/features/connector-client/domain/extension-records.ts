export const extensionProfileStates = [
  "unpaired",
  "pairing-pending",
  "paired-idle",
  "paused",
  "unpairing",
  "revoked",
  "cleanup-pending",
  "re-pair-required",
  "upgrade-required",
] as const;
export type ExtensionProfileState = (typeof extensionProfileStates)[number];
export const extensionPauseReasons = [
  "operator",
  "cleanup-failed",
  "protocol-violation",
  "unsupported-operation",
] as const;
export type ExtensionPauseReason = (typeof extensionPauseReasons)[number];
export type ExtensionProfile = Readonly<{
  schemaVersion: 1;
  revision: number;
  state: ExtensionProfileState;
  connectionId: string | null;
  servedPollWindowSeconds: number | null;
  pauseReason: ExtensionPauseReason | null;
}>;
export type ExtensionCredential = Readonly<{
  schemaVersion: 1;
  issuer: string;
  clientId: string;
  connectionId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  rotatedAt: string;
  boundProfileRevision: number;
  boundProfileState: ExtensionProfileState;
}>;

export class ExtensionCredentialError extends Error {
  constructor(readonly code: "invalid-record" | "invalid-token-response" | "unavailable" | "revision-exhausted") {
    super(code);
  }
}

export function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ExtensionCredentialError("invalid-record");
  return value as Record<string, unknown>;
}

// Same lexical admission as Auth's connectorString, without its server dependency.
export function connectorValue(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\s\x00-\x1f\x7f]/.test(value))
    throw new ExtensionCredentialError("invalid-record");
  return value;
}
export function safeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function utcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 19) === value.slice(0, 19);
}
export function credentialState(state: ExtensionProfileState): boolean {
  return state === "paired-idle" || state === "paused" || state === "unpairing";
}
export function parseExtensionProfile(value: unknown): ExtensionProfile {
  const row = closedRecord(value, [
    "schemaVersion",
    "revision",
    "state",
    "connectionId",
    "servedPollWindowSeconds",
    "pauseReason",
  ]);
  if (
    row.schemaVersion !== 1 ||
    !safeRevision(row.revision) ||
    !extensionProfileStates.some((state) => state === row.state)
  )
    throw new ExtensionCredentialError("invalid-record");
  const state = row.state as ExtensionProfileState;
  if (credentialState(state)) {
    connectorValue(row.connectionId);
    if (
      typeof row.servedPollWindowSeconds !== "number" ||
      !Number.isInteger(row.servedPollWindowSeconds) ||
      row.servedPollWindowSeconds < 30 ||
      row.servedPollWindowSeconds > 86400 ||
      (state === "paused"
        ? !extensionPauseReasons.some((reason) => reason === row.pauseReason)
        : row.pauseReason !== null && !(state === "unpairing" && row.pauseReason === "protocol-violation"))
    )
      throw new ExtensionCredentialError("invalid-record");
  } else if (
    row.connectionId !== null ||
    row.servedPollWindowSeconds !== null ||
    (row.pauseReason !== null && row.pauseReason !== "protocol-violation")
  ) {
    throw new ExtensionCredentialError("invalid-record");
  }
  return { ...row } as ExtensionProfile;
}
export function parseExtensionCredential(value: unknown): ExtensionCredential {
  const row = closedRecord(value, [
    "schemaVersion",
    "issuer",
    "clientId",
    "connectionId",
    "accessToken",
    "refreshToken",
    "accessExpiresAt",
    "rotatedAt",
    "boundProfileRevision",
    "boundProfileState",
  ]);
  for (const key of ["clientId", "connectionId", "accessToken", "refreshToken"]) connectorValue(row[key]);
  connectorValue(row.issuer, 2048);
  let issuer: URL;
  try {
    issuer = new URL(row.issuer as string);
  } catch {
    throw new ExtensionCredentialError("invalid-record");
  }
  if (
    issuer.username ||
    issuer.password ||
    issuer.hash ||
    (issuer.protocol !== "https:" &&
      !(issuer.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname))) ||
    row.schemaVersion !== 1 ||
    !safeRevision(row.boundProfileRevision) ||
    !credentialState(row.boundProfileState as ExtensionProfileState) ||
    !utcInstant(row.accessExpiresAt) ||
    !utcInstant(row.rotatedAt) ||
    !(row.accessToken as string).startsWith("cc_at_") ||
    !(row.refreshToken as string).startsWith("cc_rt_")
  )
    throw new ExtensionCredentialError("invalid-record");
  return { ...row } as ExtensionCredential;
}
export function boundCredential(profile: ExtensionProfile, value: unknown): ExtensionCredential {
  const credential = parseExtensionCredential(value);
  if (
    !credentialState(profile.state) ||
    profile.connectionId !== credential.connectionId ||
    profile.revision !== credential.boundProfileRevision ||
    profile.state !== credential.boundProfileState
  )
    throw new ExtensionCredentialError("invalid-record");
  return credential;
}
