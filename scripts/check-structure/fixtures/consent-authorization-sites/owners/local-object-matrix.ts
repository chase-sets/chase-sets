const neutralBox = {
  inner: {
    authorization: () => authorizeConsentForActor(context),
    method() {
      authorizeConsentForActor(context);
    },
  },
};
