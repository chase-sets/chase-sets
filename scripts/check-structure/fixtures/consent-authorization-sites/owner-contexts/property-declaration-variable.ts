function neutralHarness() {
  class NeutralBox {
    neutralWorker = () => authorizeConsentForActor(context);
  }
  return NeutralBox;
}
