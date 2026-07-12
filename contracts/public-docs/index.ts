export type PublicHelpArticlePolicyCitation = Readonly<{
  slug: string;
  locale: string;
  title: string;
  href: string;
  citedPolicies: readonly string[];
}>;

export { publicHelpArticlePolicyCitations } from "./generated/help-article-policy-citations";
