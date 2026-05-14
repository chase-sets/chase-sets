# Social Login Operations

This runbook covers Google and Facebook Social Login setup for the marketplace sign-in and registration journeys.

## Environment

Configure provider credentials on the Platform API deployable:

- `GOOGLE_SOCIAL_LOGIN_CLIENT_ID`
- `GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET`
- `FACEBOOK_SOCIAL_LOGIN_CLIENT_ID`
- `FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET`

Configure each provider as a pair. If one side of a pair is missing, the provider is disabled outside production and rejected in production.

Staging deploys read the same values from GitHub environment secrets:

- `GOOGLE_SOCIAL_LOGIN_CLIENT_ID`
- `GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET`
- `FACEBOOK_SOCIAL_LOGIN_CLIENT_ID`
- `FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET`

Use non-production provider apps or documented safe provider test credentials for staging. When all four staging secrets are present, the deployment workflow sets `SMOKE_REQUIRE_SOCIAL_LOGIN=true` during the staging smoke check and verifies both providers are returned by `/api/auth/social/providers` and visible on marketplace sign-in and registration. If those secrets are absent, staging deploys still run with Social Login disabled and explicitly skip the Social Login smoke assertions.

## Callback URLs

Use the Platform API origin for provider callbacks:

- Google: `https://<platform-api-origin>/api/auth/social/google/callback`
- Facebook: `https://<platform-api-origin>/api/auth/social/facebook/callback`

Local sandbox callback examples:

- `http://localhost:7712/api/auth/social/google/callback`
- `http://localhost:7712/api/auth/social/facebook/callback`

## Smoke Test

1. Open marketplace registration.
2. Select Continue with Google or Continue with Facebook.
3. Confirm the provider redirect starts from `/api/auth/social/<provider>/start`.
4. Complete provider authentication with a verified email.
5. Confirm Chase Sets redirects to the intended marketplace return path.
6. For a user with multiple active memberships, confirm account selection appears before the final return path.
7. Repeat with the same provider account and confirm no duplicate user is created.
8. Remove provider credentials in a non-production environment and confirm the provider start route reports the provider is not configured.

## Failure Handling

If callback completion fails:

- Check provider credentials and callback URL registration.
- Check that the provider returned an email.
- Check that the provider considers the email verified.
- Check Auth state expiration; state tokens expire after 10 minutes and are single-use.
- Ask the user to continue with passkey, magic link, or password when provider email verification is unavailable.

## Secret Rotation

1. Create the replacement provider secret in Google or Facebook.
2. Update the Platform API secret store.
3. Restart or redeploy Platform API.
4. Smoke test provider start and callback.
5. Revoke the old provider secret after the new secret is verified.

Never log provider client secrets, callback codes, access tokens, refresh tokens, raw provider payloads, session tokens, or state tokens.
