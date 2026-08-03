function neutralHarness() {
  const neutralWorker = () => {
    const neutralLocal = () => authorizeConsentForActor(context);
    return neutralLocal;
  };
  return neutralWorker;
}
