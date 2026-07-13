import { appendFileSync } from "node:fs";
import process from "node:process";
import { compileRepositoryCorpus } from "../bounded-contexts/public-presence/features/help/integrations/compile-help-articles.mjs";

export const DEFAULT_PUBLIC_DOC_REVIEW_MAX_AGE_DAYS = 90;

export function buildPublicDocsStaleReviewReport(articles, options = {}) {
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_PUBLIC_DOC_REVIEW_MAX_AGE_DAYS;
  const stale = articles
    .map((article) => ({
      ...article,
      ageDays: Math.floor((now.getTime() - new Date(`${article.reviewedAt}T00:00:00Z`).getTime()) / 86_400_000),
    }))
    .filter((article) => article.ageDays > maxAgeDays)
    .sort((left, right) => right.ageDays - left.ageDays || left.href.localeCompare(right.href));
  const lines = [
    "## Public docs stale-review report",
    "",
    `Review threshold: more than ${maxAgeDays} days. Stale articles: ${stale.length}.`,
    "",
  ];
  if (stale.length === 0) {
    lines.push("All public Help Articles are within the review window.");
  } else {
    lines.push("| Article | Locale | Last reviewed | Age |", "| --- | --- | --- | ---: |");
    for (const article of stale) {
      lines.push(
        `| [${article.title}](${article.href}) | ${article.locale} | ${article.reviewedAt} | ${article.ageDays} days |`,
      );
    }
  }
  return { stale, markdown: lines.join("\n") };
}

async function main() {
  const maxAgeDays = Number.parseInt(
    process.env.PUBLIC_DOC_REVIEW_MAX_AGE_DAYS ?? String(DEFAULT_PUBLIC_DOC_REVIEW_MAX_AGE_DAYS),
    10,
  );
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
    throw new Error("PUBLIC_DOC_REVIEW_MAX_AGE_DAYS must be a positive integer.");
  }
  const report = buildPublicDocsStaleReviewReport(await compileRepositoryCorpus(), { maxAgeDays });
  console.log(report.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.markdown}\n`);
  return report.stale.length > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith("public-docs-stale-review.mjs")) {
  process.exitCode = await main();
}
