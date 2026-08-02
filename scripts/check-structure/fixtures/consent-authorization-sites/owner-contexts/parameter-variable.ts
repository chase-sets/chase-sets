function neutralHarness(neutralWorker = () => authorizeConsentForActor(context)) {
  return neutralWorker;
}
