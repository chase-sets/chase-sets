import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { parse } from "yaml";
import { assertPublicCopyGuard } from "../domain/public-copy-guard.mjs";
import { publicPolicyValueKeys, publicPolicyValueWhitelist } from "../domain/public-policy-value-whitelist.mjs";

const integrationsDirectory = dirname(fileURLToPath(import.meta.url));
const helpDirectory = resolve(integrationsDirectory, "..");
const articlesDirectory = join(helpDirectory, "domain", "articles");
const generatedFile = join(helpDirectory, "domain", "generated", "articles.ts");
const citationContractFile = resolve(
  integrationsDirectory,
  "../../../../..",
  "contracts",
  "public-docs",
  "generated",
  "help-article-policy-citations.ts",
);
const validAudiences = new Set(["buyer", "seller", "developer"]);
const validCategories = new Set(["getting-started", "buying", "selling"]);
const validClaimCategories = new Set(["protection", "fees", "payouts", "shipping"]);
const allowedFrontmatter = new Set([
  "slug",
  "title",
  "description",
  "audience",
  "category",
  "reviewedAt",
  "citedPolicies",
  "relatedFlows",
  "claimCategories",
  "promiseTable",
  "path",
]);
const publicPolicyPermissionsByKey = new Map(
  publicPolicyValueWhitelist.map((permission) => [permission.key, permission]),
);

export function compileHelpArticleSource(fileName, source, options = {}) {
  const match = /^(.+)\.([a-z]{2}(?:-[A-Z]{2})?)\.md$/.exec(fileName);
  assert(match, fileName, "file name must be <slug>.<locale>.md");
  const [, fileSlug, locale] = match;
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  assert(frontmatterMatch, fileName, "must begin with YAML frontmatter enclosed by --- lines");

  let frontmatter;
  try {
    frontmatter = parse(frontmatterMatch[1]);
  } catch (error) {
    throw articleError(fileName, `contains invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  assertPlainObject(frontmatter, fileName, "frontmatter");
  for (const key of Object.keys(frontmatter)) {
    assert(allowedFrontmatter.has(key), fileName, `frontmatter contains unsupported field '${key}'`);
  }

  const slug = requiredString(frontmatter.slug, fileName, "slug");
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), fileName, "slug must be kebab-case");
  assert(slug === fileSlug, fileName, `frontmatter slug '${slug}' must match file name '${fileSlug}'`);
  const title = requiredString(frontmatter.title, fileName, "title");
  const description = requiredString(frontmatter.description, fileName, "description");
  const audience = requiredString(frontmatter.audience, fileName, "audience");
  assert(validAudiences.has(audience), fileName, `audience must be one of ${[...validAudiences].join(", ")}`);
  const category = requiredString(frontmatter.category, fileName, "category");
  assert(validCategories.has(category), fileName, `category must be one of ${[...validCategories].join(", ")}`);
  const reviewedAt = requiredString(frontmatter.reviewedAt, fileName, "reviewedAt");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt), fileName, "reviewedAt must use YYYY-MM-DD");
  const parsedReviewedAt = new Date(`${reviewedAt}T00:00:00Z`);
  assert(
    !Number.isNaN(parsedReviewedAt.valueOf()) && parsedReviewedAt.toISOString().slice(0, 10) === reviewedAt,
    fileName,
    "reviewedAt must be a real date",
  );
  const citedPolicies = stringArray(frontmatter.citedPolicies, fileName, "citedPolicies");
  const relatedFlows = stringArray(frontmatter.relatedFlows, fileName, "relatedFlows");
  const claimCategories = stringArray(frontmatter.claimCategories, fileName, "claimCategories");
  for (const claimCategory of claimCategories) {
    assert(
      validClaimCategories.has(claimCategory),
      fileName,
      `claimCategories must contain only ${[...validClaimCategories].join(", ")}`,
    );
  }
  const promiseTable = compilePromiseTable(frontmatter.promiseTable, fileName);
  assert(
    claimCategories.length === 0 || promiseTable.length > 0,
    fileName,
    `claim-bearing article categories (${claimCategories.join(", ")}) require promiseTable entries`,
  );
  const blocks = compileMarkdown(frontmatterMatch[2], fileName);
  const headings = blocks
    .filter((block) => block.type === "heading")
    .map(({ level, id, text }) => ({ level, id, text }));

  const path =
    frontmatter.path === undefined
      ? (options.defaultPath?.({ category, slug }) ?? `/help/${category}/${slug}`)
      : requiredString(frontmatter.path, fileName, "path");
  assert(/^\/[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(path), fileName, "path must be an absolute kebab-case public path");
  const policyValueKeys = [...new Set(blocks.flatMap(blockPolicyValueKeys))];
  for (const key of policyValueKeys) {
    const permission = publicPolicyPermissionsByKey.get(key);
    assert(permission, fileName, `policy value token '${key}' has no public permission`);
    assert(
      citedPolicies.includes(permission.policyKey),
      fileName,
      `citedPolicies must include '${permission.policyKey}' for policy value token '${key}'`,
    );
  }

  return {
    slug,
    locale,
    title,
    description,
    audience,
    category,
    reviewedAt,
    citedPolicies,
    relatedFlows,
    claimCategories,
    promiseTable,
    href: path,
    headings,
    blocks,
    policyValueKeys,
  };
}

export function compileHelpArticleCorpus(sources, options = {}) {
  assert(sources.length > 0, "help corpus", "must contain at least one article");
  const articles = sources
    .map(({ fileName, source }) => compileHelpArticleSource(fileName, source, options))
    .sort((left, right) => left.href.localeCompare(right.href) || left.locale.localeCompare(right.locale));
  const identities = new Set();
  for (const article of articles) {
    if (options.expectedAudience) {
      assert(
        article.audience === options.expectedAudience,
        article.href,
        `audience must be '${options.expectedAudience}' for this corpus`,
      );
    }
    if (options.allowedAudiences) {
      assert(
        options.allowedAudiences.includes(article.audience),
        article.href,
        `audience must be one of ${options.allowedAudiences.join(", ")} for this corpus`,
      );
    }
    const identity = `${article.locale}:${article.href}`;
    assert(!identities.has(identity), article.href, `duplicates article identity '${identity}'`);
    identities.add(identity);
  }

  const rootPath = options.rootPath ?? "/help";
  const validCorpusPaths = new Set([rootPath]);
  for (const article of articles) {
    if (options.includeCategoryPaths !== false) validCorpusPaths.add(`${rootPath}/${article.category}`);
    validCorpusPaths.add(article.href);
  }
  for (const article of articles) {
    const headingIds = new Set(article.headings.map((heading) => heading.id));
    for (const link of article.blocks.flatMap(blockLinks)) {
      validateLink(article, link, validCorpusPaths, headingIds, rootPath);
    }
  }
  return articles;
}

function compilePromiseTable(value, fileName) {
  assert(Array.isArray(value), fileName, "promiseTable must be an array");
  return value.map((entry, index) => {
    assertPlainObject(entry, fileName, `promiseTable[${index}]`);
    for (const key of Object.keys(entry)) {
      assert(["claim", "issues", "tests"].includes(key), fileName, `promiseTable[${index}] has unsupported '${key}'`);
    }
    const claim = requiredString(entry.claim, fileName, `promiseTable[${index}].claim`);
    const issues = stringArray(entry.issues ?? [], fileName, `promiseTable[${index}].issues`);
    const tests = stringArray(entry.tests ?? [], fileName, `promiseTable[${index}].tests`);
    assert(issues.length + tests.length > 0, fileName, `promiseTable[${index}] needs an issue or test reference`);
    for (const issue of issues) {
      assert(/^#\d+$/.test(issue), fileName, `promiseTable issue '${issue}' must look like #4352`);
    }
    for (const test of tests) {
      assert(
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(test),
        fileName,
        `promiseTable test '${test}' must name a test file`,
      );
    }
    return { claim, issues, tests };
  });
}

function compileMarkdown(markdown, fileName) {
  assert(!/<\/?[A-Za-z][^>]*>/.test(markdown), fileName, "raw HTML is not supported");
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  const usedHeadingIds = new Set();
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", content: compileInline(paragraph.join(" "), fileName) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    assert(!/^#\s/.test(line), fileName, "level-one headings are not supported; use frontmatter title");
    const heading = /^(##|###)\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const text = inlinePlainText(heading[2]);
      const baseId = slugify(text);
      assert(baseId, fileName, `heading '${heading[2]}' must contain URL-safe text`);
      let id = baseId;
      let suffix = 2;
      while (usedHeadingIds.has(id)) id = `${baseId}-${suffix++}`;
      usedHeadingIds.add(id);
      blocks.push({
        type: "heading",
        level: heading[1].length,
        id,
        text,
        content: compileInline(heading[2], fileName),
      });
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) flushList();
      list ??= { type: "list", ordered: isOrdered, items: [] };
      list.items.push(compileInline((ordered ?? unordered)[1], fileName));
      continue;
    }
    assert(!/^#{4,}\s/.test(line), fileName, "only level-two and level-three headings are supported");
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  assert(blocks.length > 0, fileName, "article body must not be empty");
  return blocks;
}

function compileInline(value, fileName) {
  const policyMarkers = [...value.matchAll(/\{\{policy:([^{}]+)\}\}/g)];
  if (value.includes("{{policy:")) {
    assert(policyMarkers.length > 0, fileName, "policy value token is malformed");
  }
  for (const marker of policyMarkers) {
    assert(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(marker[1]), fileName, `policy value token '${marker[1]}' is malformed`);
    assert(
      publicPolicyValueKeys.has(marker[1]),
      fileName,
      `policy value token '${marker[1]}' is not publicly whitelisted`,
    );
  }
  const tokens = [];
  const pattern = /(\{\{policy:[a-z0-9]+(?:[.-][a-z0-9]+)*\}\}|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ type: "text", value: value.slice(cursor, match.index) });
    const token = match[0];
    const policyValue = /^\{\{policy:([^}]+)\}\}$/.exec(token);
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
    if (policyValue) {
      assert(
        publicPolicyValueKeys.has(policyValue[1]),
        fileName,
        `policy value token '${policyValue[1]}' is not publicly whitelisted`,
      );
      tokens.push({ type: "policy-value", key: policyValue[1] });
    } else if (link) tokens.push({ type: "link", label: link[1], href: link[2] });
    else if (token.startsWith("**")) tokens.push({ type: "strong", value: token.slice(2, -2) });
    else if (token.startsWith("*")) tokens.push({ type: "emphasis", value: token.slice(1, -1) });
    else if (token.startsWith("`")) tokens.push({ type: "code", value: token.slice(1, -1) });
    cursor = match.index + token.length;
  }
  if (cursor < value.length) tokens.push({ type: "text", value: value.slice(cursor) });
  assert(tokens.length > 0, fileName, "inline content must not be empty");
  assert(
    tokens.filter(({ type }) => type === "policy-value").length === policyMarkers.length,
    fileName,
    "policy value tokens cannot be nested inside links, emphasis, strong text, or code",
  );
  return tokens;
}

function blockLinks(block) {
  const inlineGroups = block.type === "list" ? block.items : [block.content];
  return inlineGroups.flatMap((group) => group.filter((inline) => inline.type === "link"));
}

function blockPolicyValueKeys(block) {
  const inlineGroups = block.type === "list" ? block.items : [block.content];
  return inlineGroups.flatMap((group) =>
    group.filter((inline) => inline.type === "policy-value").map(({ key }) => key),
  );
}

function validateLink(article, link, validCorpusPaths, headingIds, rootPath) {
  if (/^https:\/\//.test(link.href) || /^mailto:/.test(link.href)) return;
  if (link.href.startsWith("#")) {
    assert(headingIds.has(link.href.slice(1)), article.href, `broken heading link '${link.href}'`);
    return;
  }
  assert(link.href.startsWith("/"), article.href, `relative link '${link.href}' is not allowed`);
  if (link.href === rootPath || link.href.startsWith(`${rootPath}/`)) {
    const [path, hash] = link.href.split("#");
    const linkKind = rootPath === "/help" ? "help" : "corpus";
    assert(validCorpusPaths.has(path), article.href, `broken ${linkKind} link '${link.href}'`);
    if (hash && path === article.href) assert(headingIds.has(hash), article.href, `broken heading link '#${hash}'`);
  }
}

function inlinePlainText(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function requiredString(value, fileName, field) {
  assert(typeof value === "string" && value.trim(), fileName, `${field} must be a non-empty string`);
  return value.trim();
}

function stringArray(value, fileName, field) {
  assert(Array.isArray(value), fileName, `${field} must be an array`);
  return value.map((entry, index) => requiredString(entry, fileName, `${field}[${index}]`));
}

function assertPlainObject(value, fileName, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), fileName, `${field} must be an object`);
}

function assert(condition, fileName, message) {
  if (!condition) throw articleError(fileName, message);
}

function articleError(fileName, message) {
  return new Error(`${fileName}: ${message}`);
}

export async function renderGeneratedManifest(articles) {
  return format(
    `// Generated by features/help/integrations/compile-help-articles.mjs. Do not edit by hand.\n\nimport type { HelpArticle } from "../article-model";\n\nexport const helpArticles = ${JSON.stringify(articles, null, 2)} as const satisfies readonly HelpArticle[];\n`,
    { parser: "typescript", printWidth: 120 },
  );
}

export async function renderCitationContract(articles) {
  const citations = articles
    .filter((article) => article.citedPolicies.length > 0)
    .map(({ slug, locale, title, href, citedPolicies }) => ({ slug, locale, title, href, citedPolicies }));
  return format(
    `// Generated by bounded-contexts/public-presence/features/help/integrations/compile-help-articles.mjs. Do not edit by hand.\n\nimport type { PublicHelpArticlePolicyCitation } from "../index";\n\nexport const publicHelpArticlePolicyCitations = ${JSON.stringify(citations, null, 2)} as const satisfies readonly PublicHelpArticlePolicyCitation[];\n`,
    { parser: "typescript", printWidth: 120 },
  );
}

export async function compileRepositoryCorpus() {
  const fileNames = (await readdir(articlesDirectory)).filter((fileName) => fileName.endsWith(".md")).sort();
  const sources = await Promise.all(
    fileNames.map(async (fileName) => ({
      fileName,
      source: await readFile(join(articlesDirectory, fileName), "utf8"),
    })),
  );
  const articles = compileHelpArticleCorpus(sources, { allowedAudiences: ["buyer", "seller"] });
  const copy = JSON.stringify(articles);
  assertPublicCopyGuard({ corpus: "consumer", copy, guard: "launch-language" });
  assertPublicCopyGuard({ corpus: "consumer", copy, guard: "agent-commerce" });
  return articles;
}

async function main() {
  const articles = await compileRepositoryCorpus();
  const outputs = [
    { file: generatedFile, content: await renderGeneratedManifest(articles) },
    { file: citationContractFile, content: await renderCitationContract(articles) },
  ];
  if (process.argv.includes("--check")) {
    for (const output of outputs) {
      const current = await readFile(output.file, "utf8").catch(() => "");
      if (current !== output.content) {
        throw new Error(
          `${relative(process.cwd(), output.file)} is stale; run pnpm --filter @chase-sets/public-presence run compile:help-articles`,
        );
      }
    }
    return;
  }
  for (const output of outputs) {
    await mkdir(dirname(output.file), { recursive: true });
    await writeFile(output.file, output.content, "utf8");
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
