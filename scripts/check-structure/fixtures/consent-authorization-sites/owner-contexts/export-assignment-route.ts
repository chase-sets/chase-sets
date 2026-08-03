function neutralRoute() {
  app.post("/neutral", () => authorizeConsentForActor(context));
}
export default () => authorizeConsentForActor(context);
