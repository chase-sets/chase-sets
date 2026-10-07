import { authorizeConsentForProvisioning } from "../../features/consents/domain/consent-recording-authorization";

async function provisionAdminQaActorFixture(userId: unknown, accountId: unknown) {
  return authorizeConsentForProvisioning(userId, accountId);
}

void provisionAdminQaActorFixture;
