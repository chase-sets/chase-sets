function neutralRoute() {
  app.post("/neutral", () => {
    const { neutralWorker = () => authorizeConsentForActor(context) } = source;
    return neutralWorker;
  });
}
