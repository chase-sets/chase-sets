import type { RouteAuthorization, RouteAvailability } from "./index";

export type LinkParameterRule = Readonly<{
  values?: readonly string[];
  maxLength: number;
  kind: "value" | "return-target";
}>;

export type LinkParameterSchema = Readonly<{ query: Readonly<Record<string, LinkParameterRule>> }>;
export type LinkParameters = Readonly<{
  path: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
}>;
export type LinkIntent = Readonly<{
  id: string;
  owner: string;
  routeId: string;
  host: "marketplace-web" | "admin-web" | "public-web";
  path: string;
  pathParameters: readonly string[];
  queryParameters: Readonly<Record<string, LinkParameterRule>>;
  authorization: RouteAuthorization;
  availability: RouteAvailability;
  webFallback: "same-route";
  missingTarget: "not-found";
  retiredTarget: "reject";
}>;

export type LinkIntentPartitionRow = Readonly<
  { owner: string; routeId: string; host: LinkIntent["host"] } & (
    | { kind: "intent"; intentId: string }
    | { kind: "indeterminate"; reason: string }
  )
>;
export type LinkIntentCatalog = Readonly<{
  intents: readonly LinkIntent[];
  partition: readonly LinkIntentPartitionRow[];
}>;
export type LinkEnvironment = "production" | "staging";
export type ParsedLinkIntent = Readonly<
  | { kind: "intent"; intent: LinkIntent; parameters: LinkParameters; environment: LinkEnvironment }
  | { kind: "rejected"; reason: string }
>;
