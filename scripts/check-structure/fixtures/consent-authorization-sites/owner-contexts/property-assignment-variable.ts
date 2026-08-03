function neutralHarness() {
  const neutralBox = { member: () => authorizeConsentForActor(context) };
  return neutralBox;
}
