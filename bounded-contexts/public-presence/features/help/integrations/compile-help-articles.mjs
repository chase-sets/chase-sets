import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { parse } from "yaml";

const integrationsDirectory = dirname(fileURLToPath(import.meta.url));
const helpDirectory = resolve(integrationsDirectory, "..");
const articlesDirectory = join(helpDirectory, "domain", "articles");
const generatedFile = join(helpDirectory, "domain", "generated", "articles.ts");
const validAudiences = new Set(["buyer", "seller", "developer"]);
const validCategories = new Set(["getting-started", "buying", "selling"]);
const allowedFrontmatter = new Set([
  "slug",
  "title",
  "description",
  "audience",
  "category",
  "revisionDate",
  "citedPolicies",
  "relatedFlows",
  "promiseTable",
]);

export function compileHelpArticleSource(fileName, source) {
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
  const revisionDate = requiredString(frontmatter.revisionDate, fileName, "revisionDate");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(revisionDate), fileName, "revisionDate must use YYYY-MM-DD");
  const parsedRevisionDate = new Date(`${revisionDate}T00:00:00Z`);
  assert(
    !Number.isNaN(parsedRevisionDate.valueOf()) && parsedRevisionDate.toISOString().slice(0, 10) === revisionDate,
    fileName,
    "revisionDate must be a real date",
  );
  const citedPolicies = stringArray(frontmatter.citedPolicies, fileName, "citedPolicies");
  const relatedFlows = stringArray(frontmatter.relatedFlows, fileName, "relatedFlows");
  const promiseTable = compilePromiseTable(frontmatter.promiseTable, fileName);
  const blocks = compileMarkdown(frontmatterMatch[2], fileName);
  const headings = blocks
    .filter((block) => block.type === "heading")
    .map(({ level, id, text }) => ({ level, id, text }));

  return {
    slug,
    locale,
    title,
    description,
    audience,
    category,
    revisionDate,
    citedPolicies,
    relatedFlows,
    promiseTable,
    href: `/help/${category}/${slug}`,
    headings,
    blocks,
  };
}

export function compileHelpArticleCorpus(sources) {
  assert(sources.length > 0, "help corpus", "must contain at least one article");
  const articles = sources
    .map(({ fileName, source }) => compileHelpArticleSource(fileName, source))
    .sort((left, right) => left.href.localeCompare(right.href) || left.locale.localeCompare(right.locale));
  const identities = new Set();
  for (const article of articles) {
    const identity = `${article.locale}:${article.href}`;
    assert(!identities.has(identity), article.href, `duplicates article identity '${identity}'`);
    identities.add(identity);
  }

  const validHelpPaths = new Set(["/help"]);
  for (const article of articles) {
    validHelpPaths.add(`/help/${article.category}`);
    validHelpPaths.add(article.href);
  }
  for (const article of articles) {
    const headingIds = new Set(article.headings.map((heading) => heading.id));
    for (const link of article.blocks.flatMap(blockLinks)) {
      validateLink(article, link, validHelpPaths, headingIds);
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
  const tokens = [];
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ type: "text", value: value.slice(cursor, match.index) });
    const token = match[0];
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
    if (link) tokens.push({ type: "link", label: link[1], href: link[2] });
    else if (token.startsWith("**")) tokens.push({ type: "strong", value: token.slice(2, -2) });
    else if (token.startsWith("*")) tokens.push({ type: "emphasis", value: token.slice(1, -1) });
    else if (token.startsWith("`")) tokens.push({ type: "code", value: token.slice(1, -1) });
    cursor = match.index + token.length;
  }
  if (cursor < value.length) tokens.push({ type: "text", value: value.slice(cursor) });
  assert(tokens.length > 0, fileName, "inline content must not be empty");
  return tokens;
}

function blockLinks(block) {
  const inlineGroups = block.type === "list" ? block.items : [block.content];
  return inlineGroups.flatMap((group) => group.filter((inline) => inline.type === "link"));
}

function validateLink(article, link, validHelpPaths, headingIds) {
  if (/^https:\/\//.test(link.href) || /^mailto:/.test(link.href)) return;
  if (link.href.startsWith("#")) {
    assert(headingIds.has(link.href.slice(1)), article.href, `broken heading link '${link.href}'`);
    return;
  }
  assert(link.href.startsWith("/"), article.href, `relative link '${link.href}' is not allowed`);
  if (link.href.startsWith("/help")) {
    const [path, hash] = link.href.split("#");
    assert(validHelpPaths.has(path), article.href, `broken help link '${link.href}'`);
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

async function renderGeneratedManifest(articles) {
  return format(
    `// Generated by features/help/integrations/compile-help-articles.mjs. Do not edit by hand.\n\nimport type { HelpArticle } from "../article-model";\n\nexport const helpArticles = ${JSON.stringify(articles, null, 2)} as const satisfies readonly HelpArticle[];\n`,
    { parser: "typescript", printWidth: 120 },
  );
}

async function compileRepositoryCorpus() {
  const fileNames = (await readdir(articlesDirectory)).filter((fileName) => fileName.endsWith(".md")).sort();
  const sources = await Promise.all(
    fileNames.map(async (fileName) => ({
      fileName,
      source: await readFile(join(articlesDirectory, fileName), "utf8"),
    })),
  );
  return renderGeneratedManifest(compileHelpArticleCorpus(sources));
}

async function main() {
  const generated = await compileRepositoryCorpus();
  if (process.argv.includes("--check")) {
    const current = await readFile(generatedFile, "utf8").catch(() => "");
    if (current !== generated) {
      throw new Error(
        `${relative(process.cwd(), generatedFile)} is stale; run pnpm --filter @chase-sets/public-presence run compile:help-articles`,
      );
    }
    return;
  }
  await mkdir(dirname(generatedFile), { recursive: true });
  await writeFile(generatedFile, generated, "utf8");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
