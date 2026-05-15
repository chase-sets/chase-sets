# Social Login Journey Policy

Auth owns Social Login as an authentication journey. Identity owns the durable User fact that a provider identity is linked to that User.

## Supported Providers

- Google
- Facebook

Providers are composed into Auth through provider-neutral ports. Deployables supply configured provider adapters from environment-derived secrets. Auth stores only redirect state and session facts; Identity stores only the user-level provider link fact.

## Journey Rules

1. Auth creates a short-lived Social Login state token before redirecting to the provider.
2. Auth consumes the state token exactly once on callback.
3. Auth exchanges the callback code through the configured provider adapter.
4. Auth requires a provider-verified email before creating or linking a user.
5. Auth first resolves by provider subject, then by verified email.
6. If the verified email matches an existing user, Identity links the provider identity to that user and Auth starts the normal session journey.
7. If no matching user exists, Auth asks Identity to create a personal user/account/membership and then links the provider identity.
8. If the user has more than one active membership, Auth uses the existing account-selection continuation.

## Stored Facts

Auth stores:

- short-lived state hashes
- provider name for the pending redirect
- journey name
- safe return path
- session method after callback

Identity stores:

- provider name
- provider subject
- normalized email used for linking
- linked timestamp

Provider access tokens, refresh tokens, raw profile payloads, and provider secrets are not stored as domain facts.

## Failure Policy

Missing provider configuration, invalid state, provider callback failure, missing verified email, and suspended users return to the Auth fallback journey. Users can continue with passkey, magic link, or password.

## Security Notes

Automatic existing-user linking is allowed only when the provider returns a verified email address. This preserves the fast returning-user path while keeping account takeover risk tied to provider email ownership.
