import { authorizeConsentForProvisioning } from "../../features/consents/domain/consent-recording-authorization";

declare function createSeedAggregateReconciler(options: {
  send: (streamId: string, command: unknown) => unknown;
}): unknown;
declare const services: { consents: { commandHandler: (input: unknown) => unknown } };

function buildScenarioIdentityReconcilers() {
  const consentReconciler = (userId: unknown, accountId: unknown) =>
    createSeedAggregateReconciler({
      send: (streamId, command) =>
        services.consents.commandHandler({
          streamId,
          command,
          authorization: authorizeConsentForProvisioning(userId, accountId),
        }),
    });
  return consentReconciler;
}

async function reconcileRepresentativeConsent(userId: unknown, accountId: unknown) {
  return authorizeConsentForProvisioning(userId, accountId);
}

void buildScenarioIdentityReconcilers;
void reconcileRepresentativeConsent;
