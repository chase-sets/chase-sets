export type StripeKeyCase = Readonly<{
  family: string;
  prefix: string;
  mode: string;
  keyClass: string;
}>;

export const STRIPE_KEY_CASES: readonly StripeKeyCase[];
export function isStripePublishableKeyForMode(value: unknown, expectedMode: "test" | "live"): boolean;
