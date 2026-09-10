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

function isInertDeclarationContentLine(line, ignoredLines = new Set(), index = -1) {
  return ignoredLines.has(index) || /^(?: {4}|\t)/.test(line) || /^\s{0,3}>/.test(line);
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
    if (isInertDeclarationContentLine(line)) {
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

const QUALITY_DECLARATIONS = Object.freeze({
  profile: {
    code: "BRIEF_QUALITY_PROFILE",
    label: "QUALITY_PROFILE",
    candidate: /^QUALITY_PROFILE\s*:/i,
    pattern: /^QUALITY_PROFILE:\s*(prototype|product-feature|core-library|hot-path|migration|contract)$/,
  },
  intent: {
    heading: "intent surfaces",
    code: "BRIEF_QUALITY_INTENT_SURFACES",
    headers: ["acceptance criterion", "exercised surface"],
  },
  ui: {
    heading: "ui states and design system sources",
    code: "BRIEF_QUALITY_UI_STATES",
    headers: ["ui surface", "loading", "empty", "error", "success", "design system component source"],
    none: "none — no UI surface changes.",
  },
  data: {
    heading: "data path envelope",
    code: "BRIEF_QUALITY_DATA_PATH",
    headers: ["data path", "bound", "index expectation", "per item i o"],
    none: "none — no data path changes.",
  },
  glossary: {
    heading: "glossary impact",
    code: "BRIEF_QUALITY_GLOSSARY_IMPACT",
    headers: ["public term", "owning glossary or contract"],
    none: "none — no new or renamed public names.",
  },
  compatibility: {
    heading: "contract compatibility",
    code: "BRIEF_QUALITY_CONTRACT_COMPATIBILITY",
    headers: ["changed contract", "compatibility posture", "removed path"],
    none: "none — no schema, event, or contract changes.",
  },
});

function matchingSections(markdown, normalizedHeading) {
  return markdown.headings
    .map((heading, headingIndex) => ({ heading, headingIndex }))
    .filter(({ heading }) => normalizeHeading(heading.text) === normalizedHeading);
}

function sectionContentLines(markdown, section) {
  const end = sectionEnd(markdown.headings, section.headingIndex, markdown.lines.length);
  const headingLines = new Set(markdown.headings.map((heading) => heading.index));
  return markdown.lines
    .slice(section.heading.index + 1, end)
    .filter((_line, offset) => {
      const index = section.heading.index + 1 + offset;
      return (
        !headingLines.has(index) && !isInertDeclarationContentLine(markdown.lines[index], markdown.ignoredLines, index)
      );
    })
    .map((line) => line.trim())
    .filter(Boolean);
}

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function hasCompleteTable(lines, expectedHeaders) {
  for (let index = 0; index + 2 < lines.length; index += 1) {
    const headers = tableCells(lines[index]);
    const separator = tableCells(lines[index + 1]);
    if (!headers || !separator || headers.length !== expectedHeaders.length || separator.length !== headers.length) {
      continue;
    }
    if (!headers.every((header, cell) => normalizeHeading(header) === expectedHeaders[cell])) continue;
    if (!separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    let rowCount = 0;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = tableCells(lines[rowIndex]);
      if (!row) break;
      if (row.length !== headers.length || row.some((cell) => !cell)) return false;
      rowCount += 1;
    }
    if (rowCount > 0) return true;
  }
  return false;
}

function declarationFinding(markdown, declaration) {
  if (declaration.pattern) {
    const declarations = markdown.lines
      .map((line, index) => ({ index, line: line.trim() }))
      .filter(
        ({ index, line }) =>
          !isInertDeclarationContentLine(markdown.lines[index], markdown.ignoredLines, index) &&
          declaration.candidate.test(line),
      );
    if (declarations.length !== 1) {
      return {
        code: declaration.code,
        line: declarations[0]?.index + 1,
        message: `${declaration.label} must appear exactly once as a standalone declaration.`,
      };
    }
    if (!declaration.pattern.test(declarations[0].line)) {
      return {
        code: declaration.code,
        line: declarations[0].index + 1,
        message: `${declaration.label} must name one installed quality-v2 profile exactly.`,
      };
    }
    return null;
  }

  const sections = matchingSections(markdown, declaration.heading);
  if (sections.length !== 1) {
    return {
      code: declaration.code,
      line: sections[0]?.heading.index + 1,
      message: `The ${declaration.heading} declaration must appear exactly once.`,
    };
  }

  const lines = sectionContentLines(markdown, sections[0]);
  const text = lines.join("\n");
  if (declaration.none && text === declaration.none) return null;
  if (declaration.none && lines.some((line) => /^none\b/i.test(line))) {
    return {
      code: declaration.code,
      line: sections[0].heading.index + 1,
      message: `The ${declaration.heading} explicit none form must be exact and cannot accompany other content.`,
    };
  }
  if (hasCompleteTable(lines, declaration.headers)) return null;
  return {
    code: declaration.code,
    line: sections[0].heading.index + 1,
    message: declaration.none
      ? `The ${declaration.heading} declaration needs its complete required table or the exact explicit none form.`
      : `The ${declaration.heading} declaration needs its complete required table.`,
  };
}

function footprintShapeFindings(markdown) {
  const findings = [];
  const simplest = matchingSections(markdown, "simplest shape");
  const notBuilt = matchingSections(markdown, "not built");
  const simplestLines = simplest.length === 1 ? sectionContentLines(markdown, simplest[0]) : [];
  const notBuiltLines = notBuilt.length === 1 ? sectionContentLines(markdown, notBuilt[0]) : [];
  if (
    simplest.length !== 1 ||
    simplestLines.length !== 1 ||
    /^none\b/i.test(simplestLines[0] ?? "") ||
    notBuilt.length !== 1 ||
    !hasCompleteTable(notBuiltLines, ["not built", "reason"])
  ) {
    findings.push({
      code: "BRIEF_QUALITY_G0",
      line: simplest[0]?.heading.index + 1 ?? notBuilt[0]?.heading.index + 1,
      message: "G0 needs one non-empty simplest-shape line and one complete Not built | Reason table.",
    });
  }

  const footprint = matchingSections(markdown, "footprint chain");
  const scope = matchingSections(markdown, "scope fence");
  if (footprint.length !== 1 || scope.length !== 1) {
    findings.push({
      code: "BRIEF_QUALITY_FOOTPRINT_SHAPE",
      line: footprint[0]?.heading.index + 1 ?? scope[0]?.heading.index + 1,
      message: "Footprint & chain and Scope fence must each appear exactly once.",
    });
    return findings;
  }

  const footprintLines = sectionContentLines(markdown, footprint[0]);
  const scopeEnd = sectionEnd(markdown.headings, scope[0].headingIndex, markdown.lines.length);
  const scopeLines = markdown.lines.slice(scope[0].heading.index + 1, scopeEnd);
  const inlineNonGoals = scopeLines.some(
    (line, offset) =>
      !isInertDeclarationContentLine(line, markdown.ignoredLines, scope[0].heading.index + 1 + offset) &&
      /^\s*(?:[-+*]\s*)?(?:\*\*|__)?non-goals?(?:\*\*|__)?\s*:\s*\S/i.test(line),
  );
  const labeledNonGoals = markdown.headings.some(
    (heading, headingIndex) =>
      heading.index > scope[0].heading.index &&
      heading.index < scopeEnd &&
      normalizeHeading(heading.text) === "non goals" &&
      sectionContentLines(markdown, { heading, headingIndex }).length > 0,
  );
  if (
    footprintLines.length === 0 ||
    /^none\b/i.test(footprintLines.join(" ")) ||
    (!inlineNonGoals && !labeledNonGoals)
  ) {
    findings.push({
      code: "BRIEF_QUALITY_FOOTPRINT_SHAPE",
      line: footprint[0].heading.index + 1,
      message: "Declare a non-empty footprint and a non-empty Non-goals: fence.",
    });
  }
  return findings;
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
  findings.push(
    ...[
      declarationFinding(markdown, QUALITY_DECLARATIONS.profile),
      declarationFinding(markdown, QUALITY_DECLARATIONS.intent),
      ...footprintShapeFindings(markdown),
      declarationFinding(markdown, QUALITY_DECLARATIONS.ui),
      declarationFinding(markdown, QUALITY_DECLARATIONS.data),
      declarationFinding(markdown, QUALITY_DECLARATIONS.compatibility),
      declarationFinding(markdown, QUALITY_DECLARATIONS.glossary),
    ].filter(Boolean),
  );
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
