import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const BRIEF_MAX_BYTES = 12 * 1024;
export const BRIEF_MAX_DONT_REBUILD_POINTERS = 5;

const REPOSITORY_PATH = /^(?!.*\.\.)(?:\.?[A-Za-z0-9][A-Za-z0-9._@-]*)(?:\/(?:\.?[A-Za-z0-9][A-Za-z0-9._@-]*))*$/;
const SYMBOL_POINTER = /^[A-Za-z_$][\w$]*(?:(?:\.|#|::)[A-Za-z_$][\w$]*)*(?:\(\))?$/;

function isPointerValue(value) {
  if (SYMBOL_POINTER.test(value)) return true;
  const repositoryPath = value.startsWith("./") ? value.slice(2) : value;
  return REPOSITORY_PATH.test(repositoryPath);
}

function normalizeHeading(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[*_`~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .trim();
}

function isDontRebuildHeading(value) {
  const normalized = normalizeHeading(value);
  return /\b(?:don't|do not)\b.*\brebuild\b.*\bpointers?\b/.test(normalized);
}

function isCollisionCensusHeading(value) {
  const normalized = normalizeHeading(value);
  return /\bcollisions?\b/.test(normalized) && /\bcensus\b/.test(normalized);
}

function standaloneLabel(line) {
  let value = line
    .trim()
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
    .trim();
  const emphasized = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?$/.exec(value);
  if (emphasized) return emphasized[1].trim();
  if (!value.endsWith(":")) return null;
  value = value.slice(0, -1).trim();
  return value.length <= 100 ? value : null;
}

function scanMarkdown(body) {
  const lines = String(body).replace(/\r\n?/g, "\n").split("\n");
  const headings = [];
  const ignoredLines = new Set();
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const closesFence =
        fence &&
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(line.slice(fenceMatch[0].length));
      if (closesFence) fence = null;
      else if (!fence) fence = { character: marker[0], length: marker.length };
      ignoredLines.add(index);
      continue;
    }
    if (fence) {
      ignoredLines.add(index);
      continue;
    }

    const atx = /^\s{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    if (atx) {
      headings.push({ index, level: atx[1].length, text: atx[2].trim() });
      continue;
    }

    if (line.trim() && index + 1 < lines.length && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[index + 1])) {
      headings.push({ index, level: lines[index + 1].trim()[0] === "=" ? 1 : 2, text: line.trim() });
      ignoredLines.add(index + 1);
      continue;
    }

    const label = /^\S/.test(line) ? standaloneLabel(line) : null;
    if (label) {
      headings.push({ index, level: 7, text: label });
    }
  }

  return { headings, ignoredLines, lines };
}

function sectionEnd(headings, headingIndex, lineCount) {
  const heading = headings[headingIndex];
  for (let index = headingIndex + 1; index < headings.length; index += 1) {
    if (headings[index].level <= heading.level) return headings[index].index;
  }
  return lineCount;
}

function pointerFindings(markdown) {
  const findings = [];
  const pointersByLine = new Map();
  let firstHeadingLine = null;
  for (let headingIndex = 0; headingIndex < markdown.headings.length; headingIndex += 1) {
    const heading = markdown.headings[headingIndex];
    if (!isDontRebuildHeading(heading.text)) continue;
    firstHeadingLine ??= heading.index + 1;

    const end = sectionEnd(markdown.headings, headingIndex, markdown.lines.length);
    let item = null;
    for (let index = heading.index + 1; index < end; index += 1) {
      if (markdown.ignoredLines.has(index)) continue;
      const itemStart = /^\s{0,3}(?:[-+*]|\d+[.)])\s+(.+?)\s*$/.exec(markdown.lines[index]);
      if (itemStart) {
        item = { line: index + 1, value: itemStart[1] };
        pointersByLine.set(item.line, item);
      } else if (item && markdown.lines[index].trim()) {
        item.value += ` ${markdown.lines[index].trim()}`;
      }
    }
  }

  if (pointersByLine.size > BRIEF_MAX_DONT_REBUILD_POINTERS) {
    findings.push({
      code: "BRIEF_DONT_REBUILD_POINTER_COUNT",
      line: firstHeadingLine,
      message: `Don't-rebuild pointers total ${pointersByLine.size}; the maximum is ${BRIEF_MAX_DONT_REBUILD_POINTERS}.`,
    });
  }

  for (const [line, item] of pointersByLine) {
    const match = /^`([^`]+)`$/.exec(item.value.trim());
    if (!match || !isPointerValue(match[1])) {
      findings.push({
        code: "BRIEF_DONT_REBUILD_POINTER_FORMAT",
        line,
        message: "A don't-rebuild pointer must be one backticked repository path or symbol, with no narrative.",
      });
    }
  }
  return findings;
}

function proseSegments(markdown) {
  const segments = [];
  let current = [];
  let startLine = 1;
  const flush = () => {
    if (current.length > 0) segments.push({ line: startLine, text: current.join(" ").trim() });
    current = [];
  };

  for (let index = 0; index < markdown.lines.length; index += 1) {
    const line = markdown.lines[index];
    if (markdown.ignoredLines.has(index) || !line.trim()) {
      flush();
      continue;
    }
    if (current.length === 0) startLine = index + 1;
    current.push(line.trim());
  }
  flush();
  return segments;
}

function proseClauses(markdown) {
  return proseSegments(markdown).flatMap((segment) =>
    segment.text
      .split(/(?<=[.!?;])\s+/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ line: segment.line, text })),
  );
}

function salvageFindings(markdown) {
  const findings = [];
  const draftPr = String.raw`(?:(?:live|reviewed)\s+)?draft\s+(?:pr|pull request)(?:\s*#?\d+)?|(?:pr|pull request)\s*#?\d+\s*\(draft\)`;
  const salvageArtifact = String.raw`(?:read[- ]only(?:\s+salvage)?|salvage)`;
  const forbiddenDesignations = [
    new RegExp(
      String.raw`\b(?:use|treat|designate|mark|keep|preserve)\b[^.!?]{0,100}\b(?:${draftPr})\b[^.!?]{0,30}\bas\s+(?:a\s+)?${salvageArtifact}\b`,
      "i",
    ),
    new RegExp(
      String.raw`\b(?:${draftPr})\b[^.!?]{0,50}\b(?:is|becomes?|serves?\s+as|is\s+designated\s+as)\s+(?:a\s+)?${salvageArtifact}\b`,
      "i",
    ),
    new RegExp(String.raw`\b${salvageArtifact}\b\s*:\s*(?:${draftPr})\b`, "i"),
    new RegExp(String.raw`\b(?:${draftPr})\b\s*(?:—|–|-|:)\s*(?:a\s+)?${salvageArtifact}\b`, "i"),
    new RegExp(String.raw`\b(?:${draftPr})\b\s*\(\s*(?:a\s+)?${salvageArtifact}\s*\)`, "i"),
  ];

  for (const segment of proseClauses(markdown)) {
    const isNegated = /\b(?:do\s+not|don't|never)\b/i.test(segment.text);
    if (!isNegated && forbiddenDesignations.some((pattern) => pattern.test(segment.text))) {
      findings.push({
        code: "BRIEF_LIVE_DRAFT_SALVAGE",
        line: segment.line,
        message: "A live draft PR cannot be designated as read-only salvage; it remains the implementation head.",
      });
    }

    const designatesBranch =
      /^\s*(?:[-+*]\s*)?(?:\*\*|__)?salvage(?:\s+branch)?(?:\*\*|__)?\s*:/i.test(segment.text) ||
      /\b(?:use|treat|designate|mark|preserve)\b[^.!?]{0,100}\bbranch\b[^.!?]{0,50}\bas\s+(?:read[- ]only\s+)?salvage\b/i.test(
        segment.text,
      ) ||
      /\bbranch\b[^.!?]{0,100}\b(?:is|as)\s+(?:a\s+)?(?:read[- ]only\s+)?salvage\b/i.test(segment.text) ||
      /`[^`]+`[^.!?]{0,100}\bas\s+(?:a\s+)?(?:read[- ]only\s+)?salvage\s+branch\b/i.test(segment.text);
    const emptyDesignation = /\bsalvage(?:\s+branch)?\s*:\s*(?:none|not applicable)\b/i.test(segment.text);
    if (isNegated || !designatesBranch || emptyDesignation) continue;

    const namesBranch = /\bbranch\b|`[^`]+`/i.test(segment.text);
    const noPush = /\b(?:no\s+(?:new\s+)?push(?:es)?|without\s+(?:a\s+)?push(?:es)?|not\s+been\s+pushed)\b/i.test(
      segment.text,
    );
    const sevenDays = /\b(?:7|seven)\s+days?\b/i.test(segment.text);
    if (!namesBranch || !noPush || !sevenDays) {
      findings.push({
        code: "BRIEF_SALVAGE_BRANCH_STALENESS",
        line: segment.line,
        message: "A salvage designation must name a branch with no push in seven days.",
      });
    }
  }
  return findings;
}

export function lintBrief(body) {
  const text = String(body ?? "");
  const findings = [];
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > BRIEF_MAX_BYTES) {
    findings.push({
      code: "BRIEF_BODY_BYTES",
      message: `Brief body is ${bytes} UTF-8 bytes; the 12 × 1024 byte maximum is ${BRIEF_MAX_BYTES}.`,
    });
  }

  const markdown = scanMarkdown(text);
  for (const heading of markdown.headings) {
    if (isCollisionCensusHeading(heading.text)) {
      findings.push({
        code: "BRIEF_COLLISION_CENSUS",
        line: heading.index + 1,
        message: "Collision census sections are controller-owned and must not appear in a brief.",
      });
    }
  }
  findings.push(...pointerFindings(markdown), ...salvageFindings(markdown));
  return { bytes, findings, maxBytes: BRIEF_MAX_BYTES };
}

export function formatFinding(finding) {
  return `${finding.code}${finding.line ? `:${finding.line}` : ""}: ${finding.message}`;
}

async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function main({
  argv = process.argv.slice(2),
  load = (filePath) => readFile(filePath, "utf8"),
  loadStdin = () => readStdin(process.stdin),
  logger = console,
} = {}) {
  if (argv.length !== 1) {
    logger.error("Usage: node ./scripts/brief-lint.mjs <path-to-brief.md|->");
    return 2;
  }

  const body = argv[0] === "-" ? await loadStdin() : await load(argv[0]);
  const result = lintBrief(body);
  if (result.findings.length > 0) {
    for (const finding of result.findings) logger.error(formatFinding(finding));
    return 1;
  }
  logger.log(`Brief lint passed (${result.bytes}/${result.maxBytes} UTF-8 bytes).`);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) process.exitCode = await main();
