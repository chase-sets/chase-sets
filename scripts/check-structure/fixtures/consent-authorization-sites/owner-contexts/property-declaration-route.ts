function neutralRoute() {
  app.post("/neutral", () => {
    class NeutralBox {
      neutralWorker = () => authorizeConsentForActor(context);
    }
  });
}
