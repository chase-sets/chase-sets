function neutralRoute() {
  app.post("/neutral", () => {
    function neutralBoundary(neutralWorker = () => authorizeConsentForActor(context)) {
      return neutralWorker;
    }
  });
}
