export const helpAudiences = ["buyer", "seller", "developer"] as const;
export type HelpAudience = (typeof helpAudiences)[number];

export const helpCategories = ["getting-started", "buying", "selling"] as const;
export type HelpCategory = (typeof helpCategories)[number];

export const helpClaimCategories = ["protection", "fees", "payouts", "shipping"] as const;
export type HelpClaimCategory = (typeof helpClaimCategories)[number];

export type HelpArticleInline =
  | Readonly<{ type: "text"; value: string }>
  | Readonly<{ type: "emphasis"; value: string }>
  | Readonly<{ type: "strong"; value: string }>
  | Readonly<{ type: "code"; value: string }>
  | Readonly<{ type: "link"; label: string; href: string }>
  | Readonly<{ type: "policy-value"; key: string }>;

export type HelpArticleBlock =
  | Readonly<{ type: "paragraph"; content: readonly HelpArticleInline[] }>
  | Readonly<{ type: "heading"; level: 2 | 3; id: string; content: readonly HelpArticleInline[]; text: string }>
  | Readonly<{ type: "list"; ordered: boolean; items: readonly (readonly HelpArticleInline[])[] }>;

export type HelpArticlePromise = Readonly<{
  claim: string;
  issues: readonly string[];
  tests: readonly string[];
}>;

export type HelpArticle = Readonly<{
  slug: string;
  locale: string;
  title: string;
  description: string;
  audience: HelpAudience;
  category: HelpCategory;
  reviewedAt: string;
  citedPolicies: readonly string[];
  relatedFlows: readonly string[];
  claimCategories: readonly HelpClaimCategory[];
  promiseTable: readonly HelpArticlePromise[];
  href: string;
  headings: readonly Readonly<{ level: 2 | 3; id: string; text: string }>[];
  blocks: readonly HelpArticleBlock[];
  policyValueKeys: readonly string[];
  policyChanges?: readonly Readonly<{ effectiveFrom: string; description: string }>[];
}>;
