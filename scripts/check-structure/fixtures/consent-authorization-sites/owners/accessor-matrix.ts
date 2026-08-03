class AccessorMatrix {
  get authorization() {
    authorizeConsentForActor(context);
    return value;
  }
  set authorization(value) {
    authorizeConsentForActor(context);
  }
}
