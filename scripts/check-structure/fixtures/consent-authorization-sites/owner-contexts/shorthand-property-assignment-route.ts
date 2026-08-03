function neutralRoute() {
  app.post("/neutral", () => {
    ({ neutralWorker = () => authorizeConsentForActor(context) } = source);
  });
}
