export type PasskeyChallengeResponse = Readonly<{
  challengeId: string;
  challenge: string;
}>;

export type PasskeyCredentialPayload = Readonly<{
  challengeId: string;
  challenge: string;
  externalCredentialId: string;
  label: string;
  publicKey: string;
}>;

function base64UrlToBuffer(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = window.atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function textToBuffer(value: string) {
  return new TextEncoder().encode(value).buffer;
}

function assertPublicKeyCredential(value: Credential | null) {
  if (!(value instanceof PublicKeyCredential)) {
    throw new Error("No passkey credential was selected.");
  }

  return value;
}

function isPasskeyAvailable() {
  return Boolean(
    typeof window !== "undefined" &&
      "PublicKeyCredential" in window &&
      navigator.credentials,
  );
}

async function requestChallenge(
  purpose: "passkey-register" | "passkey-sign-in",
  email: string,
) {
  const response = await fetch("/api/auth/passkeys/challenge", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose, email }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(
      typeof error === "object" && error !== null && "error" in error
        ? String(error.error)
        : "Could not start passkey authentication.",
    );
  }

  return response.json() as Promise<PasskeyChallengeResponse>;
}

export async function createPasskeyCredential(params: Readonly<{
  displayName: string;
  email: string;
}>): Promise<PasskeyCredentialPayload> {
  if (!isPasskeyAvailable()) {
    throw new Error("Passkeys are not available in this browser.");
  }

  const challenge = await requestChallenge("passkey-register", params.email);
  const credential = assertPublicKeyCredential(
    await navigator.credentials.create({
      publicKey: {
        challenge: base64UrlToBuffer(challenge.challenge),
        rp: { name: "Chase Sets" },
        user: {
          id: textToBuffer(params.email),
          name: params.email,
          displayName: params.displayName,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
        timeout: 60_000,
        attestation: "none",
      },
    }),
  );

  return {
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    externalCredentialId: credential.id,
    label: "Passkey",
    publicKey: JSON.stringify({
      id: credential.id,
      type: credential.type,
    }),
  };
}

export async function getPasskeyCredential(email: string): Promise<PasskeyCredentialPayload> {
  if (!isPasskeyAvailable()) {
    throw new Error("Passkeys are not available in this browser.");
  }

  const challenge = await requestChallenge("passkey-sign-in", email);
  const credential = assertPublicKeyCredential(
    await navigator.credentials.get({
      publicKey: {
        challenge: base64UrlToBuffer(challenge.challenge),
        timeout: 60_000,
        userVerification: "preferred",
      },
    }),
  );

  return {
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    externalCredentialId: credential.id,
    label: "Passkey",
    publicKey: JSON.stringify({
      id: credential.id,
      type: credential.type,
    }),
  };
}
