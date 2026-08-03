function namedDeclaration() {
  authorizeConsentForActor(context);
}
const namedExpression = function explicitExpression() {
  authorizeConsentForActor(context);
};
const directArrow = () => authorizeConsentForActor(context);
class NeutralClass {
  constructor() {
    authorizeConsentForActor(context);
  }
  method() {
    authorizeConsentForActor(context);
  }
  get value() {
    authorizeConsentForActor(context);
    return 1;
  }
  set value(next) {
    authorizeConsentForActor(context);
  }
  static staticMethod() {
    authorizeConsentForActor(context);
  }
}
const wrapper = {
  inner: {
    authorization: () => authorizeConsentForActor(context),
    method() {
      authorizeConsentForActor(context);
    },
    get value() {
      authorizeConsentForActor(context);
      return 1;
    },
    set value(next) {
      authorizeConsentForActor(context);
    },
  },
};
