function neutralHarness() {
  ({ neutralWorker = () => authorizeConsentForActor(context) } = source);
}
