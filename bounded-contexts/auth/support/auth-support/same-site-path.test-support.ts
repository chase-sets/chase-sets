export const SAME_SITE_TEST_ORIGIN = "https://marketplace.example.test";

export const UNSAFE_AUTH_PATHS = [
  "/\\outside.example.test/collect",
  "//outside.example.test/collect",
  "https://outside.example.test/collect",
  "account",
  "",
  "/account\\settings",
  "/account?next=\\outside",
  "/account#\\outside",
  ...Array.from({ length: 33 }, (_, index) => {
    const control = String.fromCharCode(index === 32 ? 0x7f : index);
    return `/account${control}/settings`;
  }),
  "\t/account",
  "/account\n",
];

export const VALID_AUTH_PATHS = [
  "/",
  "/account/settings?tab=security&next=%2Faccount#devices",
  "/account/%5Csettings?literal=%255C#fragment",
  "/account/../orders?status=open#recent",
];
