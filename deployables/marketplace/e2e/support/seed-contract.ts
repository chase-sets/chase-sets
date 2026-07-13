export const marketplaceBrowserE2eSeedContract = {
  buyer: {
    email: "collector@chasesets.test",
    password: "collector1234",
  },
  cart: {
    lineCount: 2,
    startedSessionId: "chk_seed_started_cart",
  },
} as const;

export function marketplaceBrowserE2eBuyerCredentials() {
  const email = process.env.MARKETPLACE_E2E_EMAIL?.trim() || marketplaceBrowserE2eSeedContract.buyer.email;
  const password = process.env.MARKETPLACE_E2E_PASSWORD?.trim() || marketplaceBrowserE2eSeedContract.buyer.password;

  if (!email || !password) {
    throw new Error(
      "Marketplace buyer journey requires MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD or the browser-e2e seed buyer contract.",
    );
  }

  return { email, password };
}
