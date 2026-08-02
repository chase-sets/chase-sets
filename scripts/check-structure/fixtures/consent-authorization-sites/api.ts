import { authorizeConsentForSelfRegistration } from "./features/consents/domain/consent-recording-authorization";

async function planPersonalIdentityRegistration(userId: unknown, accountId: unknown) {
  return authorizeConsentForSelfRegistration(userId, accountId);
}

void planPersonalIdentityRegistration;
