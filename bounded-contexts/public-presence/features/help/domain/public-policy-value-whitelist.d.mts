export type PublicPolicyValueType = "bps" | "money" | "days" | "minutes" | "number";
export type PublicPolicyValueWhitelistEntry = Readonly<{
  key: string;
  policyKey: string;
  type: PublicPolicyValueType;
  currency?: string;
  selector: Readonly<Record<string, unknown>>;
}>;
export const publicPolicyValueWhitelist: readonly PublicPolicyValueWhitelistEntry[];
export const publicPolicyValueKeys: ReadonlySet<string>;
