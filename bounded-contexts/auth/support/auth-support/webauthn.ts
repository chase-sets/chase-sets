import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";

export type VerifiedPasskeyRegistration = Readonly<{
  externalCredentialId: string;
  publicKey: string;
  signCount: number;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
}>;

export type VerifiedPasskeyAuthentication = Readonly<{
  externalCredentialId: string;
  newSignCount: number;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWebAuthnResponse(value: unknown) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return isRecord(value) ? value : null;
}

export function readWebAuthnCredentialId(value: unknown) {
  const response = parseWebAuthnResponse(value);
  return typeof response?.id === "string" && response.id ? response.id : null;
}

function bufferToBase64Url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlToBuffer(value: string) {
  try {
    return new Uint8Array(Buffer.from(value, "base64url"));
  } catch {
    return null;
  }
}

function resolvePublicOrigin(request: Request) {
  return resolvePublicRequestOrigin(request);
}

export function resolveWebAuthnRelyingParty(request: Request) {
  const publicOrigin = resolvePublicOrigin(request);
  const originHeader = request.headers.get("origin")?.trim();
  const expectedOrigin = originHeader || publicOrigin;

  try {
    const publicUrl = new URL(publicOrigin);
    const originUrl = new URL(expectedOrigin);
    if (originHeader && (originUrl.protocol !== publicUrl.protocol || originUrl.host !== publicUrl.host)) {
      return null;
    }

    return {
      origin: originUrl.origin,
      rpId: originUrl.hostname,
    };
  } catch {
    return null;
  }
}

export async function verifyPasskeyRegistration(
  request: Request,
  params: Readonly<{
    webauthnResponse: unknown;
    expectedChallenge: string;
    externalCredentialId?: string | null;
  }>,
): Promise<VerifiedPasskeyRegistration | null> {
  const relyingParty = resolveWebAuthnRelyingParty(request);
  const response = parseWebAuthnResponse(params.webauthnResponse);
  if (!relyingParty || !response) {
    return null;
  }
  if (params.externalCredentialId && response.id !== params.externalCredentialId) {
    return null;
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
      expectedType: "webauthn.create",
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return null;
    }

    return {
      externalCredentialId: verification.registrationInfo.credential.id,
      publicKey: bufferToBase64Url(verification.registrationInfo.credential.publicKey),
      signCount: verification.registrationInfo.credential.counter,
      credentialDeviceType: verification.registrationInfo.credentialDeviceType,
      credentialBackedUp: verification.registrationInfo.credentialBackedUp,
    };
  } catch {
    return null;
  }
}

export async function verifyPasskeyAuthentication(
  request: Request,
  params: Readonly<{
    webauthnResponse: unknown;
    expectedChallenge: string;
    externalCredentialId: string;
    publicKey: string;
    signCount: number;
  }>,
): Promise<VerifiedPasskeyAuthentication | null> {
  const relyingParty = resolveWebAuthnRelyingParty(request);
  const response = parseWebAuthnResponse(params.webauthnResponse);
  const publicKey = base64UrlToBuffer(params.publicKey);
  if (!relyingParty || !response || !publicKey || response.id !== params.externalCredentialId) {
    return null;
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
      expectedType: "webauthn.get",
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: "required" },
      credential: {
        id: params.externalCredentialId,
        publicKey,
        counter: params.signCount,
      },
    });
    if (!verification.verified || verification.authenticationInfo.credentialID !== params.externalCredentialId) {
      return null;
    }

    return {
      externalCredentialId: verification.authenticationInfo.credentialID,
      newSignCount: verification.authenticationInfo.newCounter,
      credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
      credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
    };
  } catch {
    return null;
  }
}
