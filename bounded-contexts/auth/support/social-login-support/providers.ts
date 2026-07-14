import type { SocialLoginProviderKey } from "@chase-sets/auth-context";

export type SocialLoginProviderName = SocialLoginProviderKey;

export type SocialLoginProfile = Readonly<{
  providerName: SocialLoginProviderName;
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
  hostedDomain?: string | null;
  displayName: string | null;
  givenName?: string | null;
  familyName?: string | null;
}>;

export type SocialLoginProvider = Readonly<{
  providerName: SocialLoginProviderName;
  createAuthorizationUrl: (
    params: Readonly<{
      state: string;
      redirectUri: string;
      hostedDomain?: string;
    }>,
  ) => string;
  exchangeCallback: (
    params: Readonly<{
      code: string;
      redirectUri: string;
    }>,
  ) => Promise<SocialLoginProfile>;
}>;

type OAuthProviderConfig = Readonly<{
  providerName: SocialLoginProviderName;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scopes: readonly string[];
  profileMapper: (
    value: unknown,
    context: Readonly<{
      token: Readonly<Record<string, unknown>>;
    }>,
  ) => SocialLoginProfile;
  fetch?: typeof globalThis.fetch;
}>;

function requireText(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Social login profile is missing ${fieldName}.`);
  }

  return value.trim();
}

function getRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeJwtPayload(value: unknown) {
  const token = readString(value);
  if (!token) {
    return {};
  }

  const [, payload] = token.split(".");
  if (!payload) {
    return {};
  }

  try {
    return getRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

async function parseOAuthJson(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error("Social login provider request failed.");
  }

  return body;
}

export function createOAuthSocialLoginProvider(config: OAuthProviderConfig): SocialLoginProvider {
  const fetchImpl = config.fetch ?? globalThis.fetch;

  return {
    providerName: config.providerName,
    createAuthorizationUrl({ state, redirectUri, hostedDomain }) {
      const url = new URL(config.authorizationUrl);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", config.scopes.join(" "));
      url.searchParams.set("state", state);
      if (hostedDomain) {
        url.searchParams.set("hd", hostedDomain);
      }
      return url.toString();
    },
    async exchangeCallback({ code, redirectUri }) {
      const tokenBody = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });
      const token = getRecord(
        await parseOAuthJson(
          await fetchImpl(config.tokenUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: tokenBody,
          }),
        ),
      );
      const accessToken = requireText(token.access_token, "access token");
      const profileUrl = new URL(config.profileUrl);

      return config.profileMapper(
        await parseOAuthJson(
          await fetchImpl(profileUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }),
        ),
        { token },
      );
    },
  };
}

export function createGoogleSocialLoginProvider(
  params: Readonly<{
    clientId: string;
    clientSecret: string;
    fetch?: typeof globalThis.fetch;
  }>,
) {
  return createOAuthSocialLoginProvider({
    providerName: "google",
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    fetch: params.fetch,
    profileMapper(value, context) {
      const profile = getRecord(value);
      const idToken = decodeJwtPayload(context.token.id_token);
      return {
        providerName: "google",
        providerSubject: requireText(profile.sub, "subject"),
        email: typeof profile.email === "string" ? profile.email : null,
        emailVerified: profile.email_verified === true,
        hostedDomain: readString(idToken.hd) ?? readString(profile.hd),
        displayName: typeof profile.name === "string" ? profile.name : null,
        givenName: typeof profile.given_name === "string" ? profile.given_name : null,
        familyName: typeof profile.family_name === "string" ? profile.family_name : null,
      };
    },
  });
}

export function createFacebookSocialLoginProvider(
  params: Readonly<{
    clientId: string;
    clientSecret: string;
    fetch?: typeof globalThis.fetch;
  }>,
) {
  return createOAuthSocialLoginProvider({
    providerName: "facebook",
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    authorizationUrl: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
    profileUrl: "https://graph.facebook.com/me?fields=id,name,email,first_name,last_name",
    scopes: ["email", "public_profile"],
    fetch: params.fetch,
    profileMapper(value) {
      const profile = getRecord(value);
      return {
        providerName: "facebook",
        providerSubject: requireText(profile.id, "subject"),
        email: typeof profile.email === "string" ? profile.email : null,
        emailVerified: false,
        displayName: typeof profile.name === "string" ? profile.name : null,
        givenName: typeof profile.first_name === "string" ? profile.first_name : null,
        familyName: typeof profile.last_name === "string" ? profile.last_name : null,
      };
    },
  });
}
