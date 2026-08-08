function neutralHarness() {
  const { neutralWorker = () => authorizeConsentForActor(context) } = source;
  return neutralWorker;
}
