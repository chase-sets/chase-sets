import { authorizeConsentForProvisioning } from "../../features/consents/domain/consent-recording-authorization";

function buildScenarioIdentityReconcilers() {
  const consentReconciler = (userId: unknown, accountId: unknown) => authorizeConsentForProvisioning(userId, accountId);
  return consentReconciler;
}

async function reconcileRepresentativeConsent(userId: unknown, accountId: unknown) {
  return authorizeConsentForProvisioning(userId, accountId);
}

void buildScenarioIdentityReconcilers;
void reconcileRepresentativeConsent;
