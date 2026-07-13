import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const baselineDisplayPath = "scripts/check-structure/glossary-coverage-baseline.json";
const masterGlossaryPath = "docs/GLOSSARY.md";
const disambiguationSectionHeading = "Cross-Context Disambiguation";
const requiredMasterSectionHeadings = [
  "Language Constitution",
  "Adaptation Rules",
  "Ratchet Rules",
  disambiguationSectionHeading,
];
const requiredDisambiguationFamilies = ["Hold family", "Policy family", "Channel family"];
const eventDeclarationFields = new Set(["eventTypes", "publishedEvents", "events"]);
const structuralGlossaryHeadings = new Set([
  "account address book",
  "account lifecycle",
  "alias model",
  "api and technical documentation",
  "api guidance",
  "auditing and events",
  "authoring model",
  "boundary",
  "catalog glossary",
  "catalog sync decision vocabulary",
  "copy guidance",
  "core model",
  "credential model",
  "discovery concepts",
  "domain invariants",
  "identity and ids",
  "identity concepts",
  "internal tools",
  "language rules",
  "local glossaries",
  "modeling rules",
  "one-line summary",
  "permission model",
  "purpose",
  "relationships",
  "representation and communication",
  "rich reference model",
  "scope registry model",
  "term ownership",
  "ui copy",
]);

function normalizeRelative(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normalizeTerm(value) {
  return String(value ?? "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/&/g, " and ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-zA-Z0-9\s]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function headingText(rawHeading) {
  return rawHeading
    .replace(/\s+#+\s*$/, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function parseGlossary(content) {
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  const rawHeadings = [...content.matchAll(headingPattern)].map((match) => ({
    level: match[1].length,
    term: headingText(match[2]),
    normalizedTerm: normalizeTerm(headingText(match[2])),
    line: content.slice(0, match.index).split(/\r?\n/).length,
    start: match.index ?? 0,
    afterHeading: (match.index ?? 0) + match[0].length,
  }));

  return rawHeadings.map((heading, index) => {
    const nextPeerOrParent = rawHeadings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const end = nextPeerOrParent?.start ?? content.length;
    return {
      ...heading,
      body: content.slice(heading.afterHeading, end).trim(),
    };
  });
}

function glossaryTermsByNormalizedHeading(content) {
  const terms = new Map();
  for (const heading of parseGlossary(content)) {
    if (heading.level === 1 || structuralGlossaryHeadings.has(heading.normalizedTerm)) {
      continue;
    }
    const entries = terms.get(heading.normalizedTerm) ?? [];
    entries.push(heading);
    terms.set(heading.normalizedTerm, entries);
  }
  return terms;
}

function resolveContextByName(contextManifests) {
  return new Map(
    [...contextManifests.values()]
      .filter((context) => isNonEmptyString(context.manifest.contextName))
      .map((context) => [context.manifest.contextName, context]),
  );
}

function readGlossary(repoRoot, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return { content: "", headings: new Map(), missing: true };
  }
  const content = readFileSync(absolutePath, "utf8");
  return {
    content,
    headings: glossaryTermsByNormalizedHeading(content),
    missing: false,
  };
}

function defaultBaseline() {
  return {
    issue: "#4419",
    owner: "bounded context owners",
    reviewBy: "2026-08-31",
    reason:
      "Initial glossary-coverage ratchet. Existing gaps are explicit here and must be removed when the glossary catches up; net-new gaps fail check:structure.",
    aliases: [],
    allowlist: [],
  };
}

function readBaseline(repoRoot, baselinePath) {
  const absolutePath = path.resolve(repoRoot, baselinePath);
  if (!existsSync(absolutePath)) {
    return defaultBaseline();
  }
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function validateBaselineShape(baseline, violations, baselinePath) {
  if (!isPlainObject(baseline)) {
    violations.push(`${baselinePath}: baseline must be an object`);
    return { aliases: [], allowlist: [] };
  }

  if (!Array.isArray(baseline.aliases)) {
    violations.push(`${baselinePath}: aliases must be an array`);
  }
  if (!Array.isArray(baseline.allowlist)) {
    violations.push(`${baselinePath}: allowlist must be an array`);
  }

  const aliases = Array.isArray(baseline.aliases) ? baseline.aliases : [];
  const allowlist = Array.isArray(baseline.allowlist) ? baseline.allowlist : [];
  const aliasKeys = new Set();
  const allowlistIds = new Set();

  for (const [index, alias] of aliases.entries()) {
    const label = `${baselinePath} aliases[${index}]`;
    if (!isPlainObject(alias)) {
      violations.push(`${label}: alias entry must be an object`);
      continue;
    }
    for (const field of ["contextName", "noun", "reason"]) {
      if (!isNonEmptyString(alias[field])) {
        violations.push(`${label}: ${field} must be a non-empty string`);
      }
    }
    if (!isStringArray(alias.terms) || alias.terms.length === 0) {
      violations.push(`${label}: terms must be a non-empty array of strings`);
    }

    const aliasKey = `${alias.contextName ?? ""}:${normalizeTerm(alias.noun)}`;
    if (aliasKeys.has(aliasKey)) {
      violations.push(`${baselinePath}: duplicate alias entry '${aliasKey}'`);
    }
    aliasKeys.add(aliasKey);
  }

  for (const [index, entry] of allowlist.entries()) {
    const label = `${baselinePath} allowlist[${index}]`;
    if (!isPlainObject(entry)) {
      violations.push(`${label}: allowlist entry must be an object`);
      continue;
    }
    for (const field of ["id", "kind", "issue", "justification"]) {
      if (!isNonEmptyString(entry[field])) {
        violations.push(`${label}: ${field} must be a non-empty string`);
      }
    }
    if (isNonEmptyString(entry.id)) {
      if (allowlistIds.has(entry.id)) {
        violations.push(`${baselinePath}: duplicate allowlist id '${entry.id}'`);
      }
      allowlistIds.add(entry.id);
    }
    if (isNonEmptyString(entry.issue) && !/^#\d+/.test(entry.issue)) {
      violations.push(`${label}: issue must start with a GitHub issue reference like #4419`);
    }
  }

  return { aliases, allowlist };
}

function aliasTermsForContext(aliases, contextName, noun) {
  const normalizedNoun = normalizeTerm(noun);
  return aliases
    .filter((alias) => alias.contextName === contextName && normalizeTerm(alias.noun) === normalizedNoun)
    .flatMap((alias) => alias.terms.map(normalizeTerm));
}

function findHeadingForNoun({ glossary, aliases, contextName, noun }) {
  const candidates = [normalizeTerm(noun), ...aliasTermsForContext(aliases, contextName, noun)];
  for (const candidate of candidates) {
    const [heading] = glossary.headings.get(candidate) ?? [];
    if (heading) {
      return heading;
    }
  }
  return null;
}

function issueForMissingOwnedNoun(context, noun) {
  return {
    id: `owned-noun:${context.manifest.contextName}:${normalizeTerm(noun).replaceAll(" ", "-")}`,
    kind: "owned-noun",
    contextName: context.manifest.contextName,
    noun,
    message:
      `${context.root}/context.json ownedNouns '${noun}' is not defined by a term heading in ` +
      `${context.root}/GLOSSARY.md`,
  };
}

function eventNounFromEventType(eventType, contextNames, sourceContextNameOverride = null) {
  if (!isNonEmptyString(eventType)) {
    return null;
  }

  const parts = eventType.split(".");
  if (parts.length >= 3 && sourceContextNameOverride && contextNames.has(sourceContextNameOverride)) {
    return { sourceContextName: sourceContextNameOverride, noun: parts[1], eventType };
  }
  if (parts.length >= 3 && contextNames.has(parts[0])) {
    return { sourceContextName: parts[0], noun: parts[1], eventType };
  }

  if (parts.length === 2 && contextNames.has(parts[0])) {
    const [sourceContextName, eventName] = parts;
    const noun = eventName.replace(
      /-(?:accepted|authorized|cancelled|captured|created|disputed|failed|issued|published|recorded|refunded|requested|resolved|submitted|updated)$/i,
      "",
    );
    return { sourceContextName, noun, eventType };
  }

  if (parts.length >= 3) {
    return { sourceContextName: parts[0], noun: parts[1], eventType };
  }

  return null;
}

function collectEventTypes(value, eventTypes = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectEventTypes(entry, eventTypes);
    }
    return eventTypes;
  }

  if (!isPlainObject(value)) {
    return eventTypes;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (eventDeclarationFields.has(key) && Array.isArray(entry)) {
      for (const eventType of entry) {
        if (isNonEmptyString(eventType)) {
          eventTypes.add(eventType);
        }
      }
      continue;
    }
    collectEventTypes(entry, eventTypes);
  }

  return eventTypes;
}

function issueForMissingEventNoun({ eventTypes, sourceContextName, noun, consumerContextNames, reason }) {
  const normalizedNoun = normalizeTerm(noun).replaceAll(" ", "-");
  return {
    id: `event-noun:${sourceContextName}:${normalizedNoun}`,
    kind: "event-noun",
    contextName: sourceContextName,
    noun,
    eventTypes: [...eventTypes].sort(),
    message:
      `${sourceContextName}.${noun} event noun is referenced by ${[...consumerContextNames].sort().join(", ")} ` +
      `(${[...eventTypes].sort().join(", ")}) but ${reason}; ` +
      "event noun segments must resolve to the source context glossary",
  };
}

function definitionBodyIsPresent(heading) {
  return heading.body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
}

function findBrokenWikiReferences({ relativePath, content, knownTerms }) {
  const issues = [];
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = match[1].split("|")[0].trim();
    if (!knownTerms.has(normalizeTerm(target))) {
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      issues.push({
        id: `broken-reference:${relativePath}:${line}:${normalizeTerm(target).replaceAll(" ", "-")}`,
        kind: "broken-reference",
        message: `${relativePath}:${line}: glossary cross-reference [[${match[1]}]] does not resolve to a known glossary term`,
      });
    }
  }
  return issues;
}

function findSectionByHeading(content, sectionHeading) {
  const headings = parseGlossary(content);
  return headings.find(
    (heading) => heading.level === 2 && normalizeTerm(heading.term) === normalizeTerm(sectionHeading),
  );
}

function masterDisambiguatesTerm(masterContent, term) {
  const section = findSectionByHeading(masterContent, disambiguationSectionHeading);
  if (!section) {
    return false;
  }
  return section.body.toLowerCase().includes(normalizeTerm(term));
}

function markdownTableRows(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length > 0 && !cells.every((cell) => /^-+$/.test(cell.replaceAll(" ", ""))));
}

function collectMasterGlossaryConstitutionIssues(masterGlossary) {
  const issues = [];

  for (const sectionHeading of requiredMasterSectionHeadings) {
    const section = findSectionByHeading(masterGlossary.content, sectionHeading);
    if (!section) {
      issues.push({
        id: `master-glossary-section:${normalizeTerm(sectionHeading).replaceAll(" ", "-")}`,
        kind: "master-glossary-section",
        message: `${masterGlossaryPath} must define a '${sectionHeading}' section for the ubiquitous-language constitution`,
      });
      continue;
    }
    if (!definitionBodyIsPresent(section)) {
      issues.push({
        id: `master-glossary-section-body:${normalizeTerm(sectionHeading).replaceAll(" ", "-")}`,
        kind: "master-glossary-section-body",
        message: `${masterGlossaryPath}:${section.line}: '${sectionHeading}' must document the ubiquitous-language constitution rule`,
      });
    }
  }

  const disambiguation = findSectionByHeading(masterGlossary.content, disambiguationSectionHeading);
  const rowTerms = new Set(markdownTableRows(disambiguation?.body ?? "").map(([term]) => normalizeTerm(term)));
  for (const family of requiredDisambiguationFamilies) {
    if (!rowTerms.has(normalizeTerm(family))) {
      issues.push({
        id: `master-glossary-family:${normalizeTerm(family).replaceAll(" ", "-")}`,
        kind: "master-glossary-family",
        message: `${masterGlossaryPath} ${disambiguationSectionHeading} must disambiguate the ${family}`,
      });
    }
  }

  return issues;
}

function collectCollisionIssues({ contextGlossaries, masterGlossary }) {
  const termContexts = new Map();

  for (const [contextName, glossary] of contextGlossaries.entries()) {
    for (const [normalizedTerm, headings] of glossary.headings.entries()) {
      if (structuralGlossaryHeadings.has(normalizedTerm) || headings.length === 0) {
        continue;
      }
      const contexts = termContexts.get(normalizedTerm) ?? new Set();
      contexts.add(contextName);
      termContexts.set(normalizedTerm, contexts);
    }
  }

  const issues = [];
  for (const [normalizedTerm, contexts] of termContexts.entries()) {
    if (contexts.size < 2) {
      continue;
    }
    const term = [...contextGlossaries.values()]
      .flatMap((glossary) => glossary.headings.get(normalizedTerm) ?? [])
      .find(Boolean)?.term;
    if (!term || masterDisambiguatesTerm(masterGlossary.content, term)) {
      continue;
    }
    issues.push({
      id: `cross-context-collision:${normalizedTerm.replaceAll(" ", "-")}`,
      kind: "cross-context-collision",
      term,
      contexts: [...contexts].sort(),
      message:
        `${term} appears in multiple context glossaries (${[...contexts].sort().join(", ")}) but ` +
        `${masterGlossaryPath} has no ${disambiguationSectionHeading} entry for it`,
    });
  }

  return issues;
}

export function collectGlossaryCoverageIssues(options) {
  const { repoRoot, contextManifests, baselinePath = baselineDisplayPath } = options;
  const violations = [];
  const baseline = readBaseline(repoRoot, baselinePath);
  const { aliases, allowlist } = validateBaselineShape(baseline, violations, baselinePath);
  const allowlistIds = new Set(allowlist.filter(isPlainObject).map((entry) => entry.id));
  const contextsByName = resolveContextByName(contextManifests);
  const contextGlossaries = new Map();
  const rawGlossaries = new Map();
  const issues = [];

  for (const context of contextManifests.values()) {
    const glossaryPath = `${context.root}/GLOSSARY.md`;
    const glossary = readGlossary(repoRoot, glossaryPath);
    contextGlossaries.set(context.manifest.contextName, glossary);
    rawGlossaries.set(glossaryPath, glossary);

    for (const noun of context.manifest.ownedNouns ?? []) {
      const heading = findHeadingForNoun({
        glossary,
        aliases,
        contextName: context.manifest.contextName,
        noun,
      });
      if (!heading) {
        issues.push(issueForMissingOwnedNoun(context, noun));
        continue;
      }
      if (!definitionBodyIsPresent(heading)) {
        issues.push({
          id: `definition:${context.manifest.contextName}:${normalizeTerm(heading.term).replaceAll(" ", "-")}`,
          kind: "definition",
          contextName: context.manifest.contextName,
          term: heading.term,
          message: `${context.root}/GLOSSARY.md:${heading.line}: glossary term heading '${heading.term}' must have a definition body`,
        });
      }
    }
  }

  const eventConsumers = new Map();
  const eventSourceContextOverrides = new Map();
  for (const context of contextManifests.values()) {
    for (const eventType of collectEventTypes(context.manifest)) {
      const consumers = eventConsumers.get(eventType) ?? new Set();
      consumers.add(context.manifest.contextName);
      eventConsumers.set(eventType, consumers);
    }
    for (const subscription of context.manifest.eventSubscriptions ?? []) {
      if (!isPlainObject(subscription) || !isNonEmptyString(subscription.sourceContextName)) continue;
      for (const eventType of subscription.eventTypes ?? []) {
        if (!isNonEmptyString(eventType) || contextsByName.has(eventType.split(".")[0])) continue;
        const sourceContexts = eventSourceContextOverrides.get(eventType) ?? new Set();
        sourceContexts.add(subscription.sourceContextName);
        eventSourceContextOverrides.set(eventType, sourceContexts);
      }
    }
  }

  const eventNounReferences = new Map();
  for (const [eventType, consumerContextNames] of eventConsumers.entries()) {
    const sourceOverrides = eventSourceContextOverrides.get(eventType);
    const parsedReferences = sourceOverrides?.size
      ? [...sourceOverrides].map((sourceContextName) =>
          eventNounFromEventType(eventType, contextsByName, sourceContextName),
        )
      : [eventNounFromEventType(eventType, contextsByName)];
    for (const parsed of parsedReferences) {
      if (!parsed) continue;
      const key = `${parsed.sourceContextName}:${normalizeTerm(parsed.noun)}`;
      const reference = eventNounReferences.get(key) ?? {
        sourceContextName: parsed.sourceContextName,
        noun: parsed.noun,
        eventTypes: new Set(),
        consumerContextNames: new Set(),
      };
      reference.eventTypes.add(eventType);
      for (const consumerContextName of consumerContextNames) {
        reference.consumerContextNames.add(consumerContextName);
      }
      eventNounReferences.set(key, reference);
    }
  }

  for (const reference of eventNounReferences.values()) {
    const sourceContext = contextsByName.get(reference.sourceContextName);
    if (!sourceContext) {
      issues.push(
        issueForMissingEventNoun({
          eventTypes: reference.eventTypes,
          sourceContextName: reference.sourceContextName,
          noun: reference.noun,
          consumerContextNames: reference.consumerContextNames,
          reason: `source context '${reference.sourceContextName}' has no bounded context glossary`,
        }),
      );
      continue;
    }
    const sourceGlossary = contextGlossaries.get(reference.sourceContextName);
    if (
      !findHeadingForNoun({
        glossary: sourceGlossary,
        aliases,
        contextName: reference.sourceContextName,
        noun: reference.noun,
      })
    ) {
      issues.push(
        issueForMissingEventNoun({
          eventTypes: reference.eventTypes,
          sourceContextName: reference.sourceContextName,
          noun: reference.noun,
          consumerContextNames: reference.consumerContextNames,
          reason: `${sourceContext.root}/GLOSSARY.md has no term heading for '${reference.noun}'`,
        }),
      );
    }
  }

  const masterGlossary = readGlossary(repoRoot, masterGlossaryPath);
  rawGlossaries.set(masterGlossaryPath, masterGlossary);
  issues.push(...collectMasterGlossaryConstitutionIssues(masterGlossary));
  issues.push(...collectCollisionIssues({ contextGlossaries, masterGlossary }));

  const knownTerms = new Set();
  for (const glossary of rawGlossaries.values()) {
    for (const term of glossary.headings.keys()) {
      knownTerms.add(term);
    }
  }
  for (const [relativePath, glossary] of rawGlossaries.entries()) {
    issues.push(...findBrokenWikiReferences({ relativePath, content: glossary.content, knownTerms }));
  }

  const currentIssueIds = new Set(issues.map((issue) => issue.id));
  for (const entry of allowlist) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.id)) {
      continue;
    }
    if (!currentIssueIds.has(entry.id)) {
      violations.push(
        `${baselinePath}: stale glossary coverage allowlist entry '${entry.id}' no longer matches a current gap; remove it as the ratchet shrinks`,
      );
    }
  }

  for (const issue of issues) {
    if (allowlistIds.has(issue.id)) {
      continue;
    }
    violations.push(issue.message);
  }

  return {
    ok: violations.length === 0,
    baselineEntries: allowlist,
    aliases,
    issues,
    violations,
    warnings: [],
  };
}

export function validateGlossaryCoverage(options) {
  const { repoRoot, contextManifests, baselinePath = baselineDisplayPath } = options;
  return collectGlossaryCoverageIssues({
    repoRoot,
    contextManifests,
    baselinePath,
  });
}

export const glossaryCoverageInternals = {
  normalizeTerm,
  parseGlossary,
  eventNounFromEventType,
};
