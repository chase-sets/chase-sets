export type PublicPolicyValueType = "bps" | "money" | "days" | "hours" | "minutes" | "number";
export type PublicPolicyScalarContract =
  | Readonly<{ primitive: "integer"; minimum: number; maximum: number }>
  | Readonly<{ primitive: "money"; minimumCents: number }>;
export type PublicPolicyValueWhitelistEntry = Readonly<{
  key: string;
  policyKey: string;
  type: PublicPolicyValueType;
  currency?: string;
  valueContract: PublicPolicyScalarContract;
  selector: Readonly<Record<string, unknown>>;
}>;
export const publicPolicyValueWhitelist: readonly PublicPolicyValueWhitelistEntry[];
export const publicPolicyValueKeys: ReadonlySet<string>;
