import { closedRecord, connectorValue } from "./extension-records";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "./identity";

export const pairingSessionKey = "channel-connector-pairing";
export const defaultPollWindowSeconds = 60;
export function pollWindow(value: number = defaultPollWindowSeconds) {
  if (!Number.isInteger(value) || value < 1 || value > 3600) throw new Error("invalid-poll-window");
  return { seconds: Math.max(30, value), clamped: value < 30 };
}
function randomValue() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function createPairingSession(now: number) {
  const verifier = randomValue();
  const challenge = btoa(
    String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return { verifier, challenge, state: randomValue(), expiresAt: now + 600_000 };
}
export function pairingCode(callback: string, session: Awaited<ReturnType<typeof createPairingSession>>, now: number) {
  const url = new URL(callback);
  if (callback.split("?")[0] !== TCGPLAYER_CONNECTOR_REDIRECT_URI || url.hash || now >= session.expiresAt)
    throw new Error("pairing-refused");
  const query = url.searchParams;
  if (query.getAll("state").length !== 1 || query.get("state") !== session.state) throw new Error("pairing-refused");
  if ([...query.keys()].some((key) => !["code", "state"].includes(key)) || query.getAll("code").length !== 1)
    throw new Error("pairing-refused");
  return connectorValue(query.get("code"));
}
export function parsePairingSession(value: unknown) {
  const row = closedRecord(value, ["verifier", "challenge", "state", "expiresAt"]);
  if (typeof row.expiresAt !== "number" || !Number.isSafeInteger(row.expiresAt)) throw new Error("pairing-refused");
  return {
    verifier: connectorValue(row.verifier),
    challenge: connectorValue(row.challenge),
    state: connectorValue(row.state),
    expiresAt: row.expiresAt,
  };
}
