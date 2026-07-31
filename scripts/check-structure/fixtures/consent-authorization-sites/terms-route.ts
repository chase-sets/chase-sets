import { authorizeConsentForActor } from "../domain/consent-recording-authorization";

export function termsOfServiceConsentRoutes(app: { post: Function }) {
  app.post("/accept", (context: unknown) => authorizeConsentForActor(context));
}
