import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { derivePublicWebRouteInventory, generatedHelpCatalogPath } from "./public-web-route-inventory.mjs";
import { repoRoot } from "./lib/repo.mjs";

const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");
const source = readFileSync(path.join(repoRoot, generatedHelpCatalogPath), "utf8");
const inventory = derivePublicWebRouteInventory({ rootDir: repoRoot });

function property(object, name) {
  return object.properties.find((node) => ts.isPropertyAssignment(node) && node.name.getText() === name)?.initializer;
}

function scanCatalog(sourceText) {
  const file = ts.createSourceFile(generatedHelpCatalogPath, sourceText, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, "catalog must parse");
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((node) => node.name.getText() === "helpArticles");
  let array = declaration?.initializer;
  while (
    array &&
    (ts.isAsExpression(array) || ts.isSatisfiesExpression(array) || ts.isParenthesizedExpression(array))
  ) {
    array = array.expression;
  }
  assert.ok(array && ts.isArrayLiteralExpression(array), "helpArticles must be an array");
  return array.elements.map((article) => {
    assert.ok(ts.isObjectLiteralExpression(article));
    const slug = property(article, "slug");
    assert.ok(slug && ts.isStringLiteral(slug));
    const links = [];
    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const type = property(node, "type");
        if (type && ts.isStringLiteral(type) && type.text === "link") {
          const href = property(node, "href");
          assert.ok(href && ts.isStringLiteral(href), `${slug.text}: link href must be a string`);
          links.push({ href: href.text, start: href.getStart(file), end: href.end });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(article);
    return { slug: slug.text, links };
  });
}

function audit(sourceText, routeInventory, rejectUnknown = true) {
  const articles = scanCatalog(sourceText);
  const allowed = new Set(
    routeInventory.members
      .filter((member) => member.kind === "CONCRETE" || member.kind === "EXPANDED")
      .map((member) => member.path),
  );
  let scannedLinks = 0;
  for (const article of articles) {
    for (const { href } of article.links) {
      scannedLinks += 1;
      if (!href.startsWith("/")) continue;
      const pathname = new URL(href, "https://help-audit.test").pathname;
      const known =
        !href.startsWith("//") &&
        (pathname === "/account" || pathname.startsWith("/account/") || allowed.has(pathname));
      if (!known && rejectUnknown)
        throw new Error(`help article '${article.slug}': unknown root-relative href '${href}'`);
    }
  }
  return {
    scannedArticles: articles.length,
    totalArticles: articles.length,
    scannedLinks,
    totalLinks: articles.reduce((count, article) => count + article.links.length, 0),
  };
}

function replaceHref(articleSlug, href) {
  const article = scanCatalog(source).find((candidate) => candidate.slug === articleSlug);
  assert.ok(article);
  const link = article.links[0];
  assert.ok(link);
  return source.slice(0, link.start) + JSON.stringify(href) + source.slice(link.end);
}

describe("help article link audit", () => {
  it("does not authorize links from ignored or untracked build manifests", () => {
    const scratch = path.join(repoRoot, "artifacts");
    mkdirSync(scratch, { recursive: true });
    const rootDir = mkdtempSync(path.join(scratch, "help-link-audit-"));
    const write = (relativePath, content) => {
      const target = path.join(rootDir, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });
    try {
      for (const relativePath of [
        "bounded-contexts/pricing/context.json",
        "bounded-contexts/public-presence/context.json",
        generatedHelpCatalogPath,
      ])
        write(relativePath, readFileSync(path.join(repoRoot, relativePath), "utf8"));
      write(".gitignore", "bounded-contexts/ignored-build/\n");
      git("init", "--quiet");
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "tracked fixture");
      const baseline = derivePublicWebRouteInventory({ rootDir });
      const manifest = JSON.stringify({
        deployableContributions: [
          { deployable: "public-web", routes: [{ routeId: "build-only", routePath: "build-only" }] },
        ],
      });
      write("bounded-contexts/ignored-build/context.json", manifest);
      write("bounded-contexts/untracked-build/context.json", manifest);
      assert.deepEqual(derivePublicWebRouteInventory({ rootDir }), baseline);
      assert.throws(
        () => audit(replaceHref("seller-migration-tcgplayer-ebay", "/build-only"), baseline),
        /\/build-only/,
      );
    } finally {
      assert.ok(path.resolve(rootDir).startsWith(`${path.resolve(scratch)}${path.sep}`));
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("audits every article and compiled link in the real tracked catalog", () => {
    const counts = audit(source, inventory);
    assert.deepEqual(counts, { scannedArticles: 17, totalArticles: 17, scannedLinks: 70, totalLinks: 70 });
  });

  it("rejects the historical seller-migration /compare#calculator defect", () => {
    const broken = replaceHref("seller-migration-tcgplayer-ebay", "/compare#calculator");
    assert.throws(() => audit(broken, inventory), /seller-migration-tcgplayer-ebay.*\/compare#calculator/);
    // Removing rejection must break the exact same negative-control assertion.
    assert.throws(() => assert.throws(() => audit(broken, inventory, false)), assert.AssertionError);
  });

  it("rejects the same historical href in a copy of the real sibling article", () => {
    assert.throws(
      () => audit(replaceHref("inventory-csv-import", "/compare#calculator"), inventory),
      /inventory-csv-import.*\/compare#calculator/,
    );
  });

  for (const block of [
    '{ type: "heading", content: LINKS }',
    '{ type: "paragraph", content: LINKS }',
    '{ type: "list", items: [LINKS] }',
  ]) {
    it(`discovers unknown hrefs by code shape in a sibling ${block}`, () => {
      const sibling = `export const helpArticles = [{ slug: "inventory-csv-import", blocks: [${block.replace("LINKS", '[{ type: "link", href: "/compare#calculator" }]')}]}];`;
      assert.throws(() => audit(sibling, inventory), /inventory-csv-import.*\/compare#calculator/);
    });
  }

  for (const href of [
    "/unknown",
    "/accounting",
    "/market/concrete",
    "/developers/concrete",
    "//unknown.test/account",
  ]) {
    it(`fails closed for ${href}`, () => {
      assert.throws(
        () => audit(replaceHref("seller-migration-tcgplayer-ebay", href), inventory),
        /unknown root-relative href/,
      );
    });
  }

  for (const href of [
    "/account",
    "/account?tab=listings#new",
    "/account/listings?status=draft#new",
    "/compare/tcgplayer#fee-calculator",
    "/help/selling?view=all#top",
  ]) {
    it(`classifies the pathname without discarding diagnostic query/hash: ${href}`, () => {
      assert.equal(audit(replaceHref("seller-migration-tcgplayer-ebay", href), inventory).scannedLinks, 70);
    });
  }
});
