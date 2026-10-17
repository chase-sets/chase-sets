import { isIP } from "node:net";
import { CHANNELS_EBAY_ACCOUNT_DELETION_PATH } from "../api/provider-webhook-paths";

export type EbayAccountDeletionConfiguration = Readonly<{
  verificationToken: string;
  endpoint: string;
}>;

export function parseEbayAccountDeletionConfiguration(
  endpoint: string | undefined,
  verificationToken: string | undefined,
): EbayAccountDeletionConfiguration | null {
  if (!endpoint && !verificationToken) return null;
  const invalid = () => new Error("ebay_account_deletion_configuration_invalid");
  if (!endpoint || !verificationToken || !/^[A-Za-z0-9_-]{32,80}$/.test(verificationToken)) throw invalid();
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid();
  }
  const hostname = url.hostname.replace(/\.$/, "");
  if (
    endpoint !== endpoint.trim() ||
    /[\s\\?#]/.test(endpoint) ||
    !endpoint.endsWith(CHANNELS_EBAY_ACCOUNT_DELETION_PATH) ||
    endpoint.slice("https://".length, -CHANNELS_EBAY_ACCOUNT_DELETION_PATH.length).includes("/") ||
    endpoint.includes("@") ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.length > 253 ||
    !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    url.pathname !== CHANNELS_EBAY_ACCOUNT_DELETION_PATH
  )
    throw invalid();
  return { endpoint, verificationToken };
}
