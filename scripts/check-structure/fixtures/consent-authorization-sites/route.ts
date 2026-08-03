import { authorizeConsentForActor } from "../domain/consent-recording-authorization";

export function consentRoutes(app: { post: Function }) {
  app.post("/:id/withdraw", (context: unknown) => authorizeConsentForActor(context));
}
