import type { ChannelConnectionSetupDeclaration } from "../../connections/domain/contracts";

export type EbayOAuthConfiguration = Readonly<{
  environment: "sandbox";
  clientId: string;
  clientSecret: string;
  ruName: string;
}>;

export function parseEbayOAuthConfiguration(
  environment: string,
  clientId: string | undefined,
  clientSecret: string | undefined,
  ruName: string | undefined,
): EbayOAuthConfiguration | null {
  if (environment !== "sandbox" || !clientId?.trim() || !clientSecret?.trim() || !ruName?.trim()) return null;
  if ([clientId, clientSecret, ruName].some((value) => value.length > 2048 || /[\r\n\u0000]/u.test(value))) return null;
  return { environment: "sandbox", clientId, clientSecret, ruName };
}

export const ebaySetupDeclaration: ChannelConnectionSetupDeclaration = {
  providerKey: "ebay",
  environment: "sandbox",
  requirements: {
    credential: "required",
    requiredPolicyKeys: ["ebay.fulfillment", "ebay.payment", "ebay.return"],
    binding: "one-or-more-current",
  },
};
