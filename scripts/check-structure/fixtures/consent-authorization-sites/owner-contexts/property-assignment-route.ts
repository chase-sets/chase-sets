function neutralRoute() {
  const neutralBox = { member: () => authorizeConsentForActor(context) };
  return neutralBox;
}
