import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const prohibitedLayoutTagPattern = /<(div|section|main|header|footer|aside|article|nav)\b/g;
const classNamePattern = /\bclassName\s*=/g;
const stylesheetImportPattern =
  /import\s+"@chase-sets\/design-system\/styles\.css";/g;

export async function collectShowcaseSourceViolations(showcaseSourceDirectory) {
  if (!showcaseSourceDirectory) {
    throw new Error(
      "collectShowcaseSourceViolations requires a showcase source directory."
    );
  }

  const files = await listFiles(showcaseSourceDirectory);
  const findings = [];

  for (const file of files.filter((candidate) => candidate.endsWith(".tsx"))) {
    const source = await readFile(file, "utf8");
    findings.push(
      ...collectPatternFindings(file, source, classNamePattern, "Unexpected className usage")
    );
    findings.push(
      ...collectPatternFindings(
        file,
        source,
        prohibitedLayoutTagPattern,
        "Unexpected raw layout HTML"
      )
    );
  }

  const mainFilePath = join(showcaseSourceDirectory, "main.tsx");
  const mainFile = await readFile(mainFilePath, "utf8");
  const stylesheetImports = [...mainFile.matchAll(stylesheetImportPattern)];

  if (stylesheetImports.length !== 1) {
    findings.push(
      `Expected exactly one @chase-sets/design-system/styles.css import in ${mainFilePath}, found ${stylesheetImports.length}.`
    );
  }

  return findings;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function collectPatternFindings(file, source, pattern, label) {
  const findings = [];
  let match;

  while ((match = pattern.exec(source)) !== null) {
    findings.push(`${label} in ${file}:${resolveLineNumber(source, match.index)}`);
  }

  pattern.lastIndex = 0;

  return findings;
}

function resolveLineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}
