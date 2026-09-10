const REQUIRED_KEYS = [
  "SCOPE",
  "ROBUSTNESS",
  "DEPTH",
  "READABILITY",
  "TESTS",
  "OBSERVABILITY",
  "SECURITY",
  "PERFORMANCE",
  "ROLLOUT",
  "CONSISTENCY",
  "EXPERIENCE",
  "LANGUAGE",
];
const PROFILES = ["prototype", "product-feature", "core-library", "hot-path", "migration", "contract"];
const WEIGHTS = ["High", "Med", "Low"];
const REQUIRED_TRAILING_FIELDS = ["Edits per key", "Enforcement pairs checked", "Unverifiable assumptions"];
const TEMPLATE_TOKENS = new Set([
  "not built, one reason each",
  "prototype|product-feature|core-library|hot-path|migration|contract",
  "pass|note",
  "payload",
  "absent surface",
  "edit made, or no-change reason for each key",
  "changed rule/contract/prose → test/check/inspection",
  "bounded assumptions, or none",
]);

export const MAX_QUALITY_PACKET_SECTION_BYTES = 2048;

export function extractQualityPacketSection(skill) {
  const lines = skill.match(/.*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  const headingIndex = lines.findIndex((line) => /^### Quality Packet snippet[ \t]*(?:\r?\n|$)/.test(line));
  if (headingIndex === -1) return "";

  let inFence = false;
  let fenceCharacter = "";
  const subsectionLines = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const character = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceCharacter = character;
      } else if (character === fenceCharacter) {
        inFence = false;
        fenceCharacter = "";
      }
    } else if (!inFence && /^(#{1,3})[ \t]+/.test(line)) {
      break;
    }
    subsectionLines.push(line);
  }

  const subsection = subsectionLines.join("");
  const match = /^```markdown[ \t]*\r?\n([\s\S]*?)\r?\n^```[ \t]*(?:\r?\n|$)/m.exec(subsection);
  return match?.[1] ?? "";
}

function containsUnsubstitutedPlaceholder(value) {
  return [...value.matchAll(/<([^>\r\n]+)>/g)].some((match) => TEMPLATE_TOKENS.has(match[1].trim().toLowerCase()));
}

function payloadErrors(value, label) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || containsUnsubstitutedPlaceholder(trimmed)) return [`empty or placeholder payload for ${label}`];
  if (/^(?:PASS|NOTE|N\/A)$/i.test(trimmed) || /^see tests[.!]?$/i.test(trimmed)) {
    return [`unbounded evidence payload for ${label}`];
  }
  return [];
}

export function qualityPacketSectionErrors(section) {
  const errors = [];
  const normalized = section.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");

  if (lines[0] !== "## Quality Packet") errors.push("missing heading");
  if (Buffer.byteLength(section, "utf8") > MAX_QUALITY_PACKET_SECTION_BYTES) {
    errors.push("section exceeds 2048 bytes");
  }

  const g0Lines = lines.filter((line) => line.startsWith("G0:"));
  if (g0Lines.length === 0) errors.push("missing required field: G0");
  if (g0Lines.length > 1) errors.push("duplicate required field: G0");
  if (g0Lines.length === 1) {
    const match = /^G0: (\S+) — (.*)$/.exec(g0Lines[0]);
    if (!match) errors.push("malformed G0");
    else {
      if (match[1] !== "PASS") errors.push(`invalid G0 verdict: ${match[1]}`);
      errors.push(...payloadErrors(match[2], "G0 not-built list"));
    }
  }

  const profileLines = lines.filter((line) => line.startsWith("QUALITY_PROFILE:"));
  if (profileLines.length === 0) errors.push("missing required field: QUALITY_PROFILE");
  if (profileLines.length > 1) errors.push("duplicate required field: QUALITY_PROFILE");
  if (profileLines.length === 1) {
    const profile = /^QUALITY_PROFILE: (.+)$/.exec(profileLines[0])?.[1].trim() ?? "";
    if (!PROFILES.includes(profile)) errors.push(`invalid profile: ${profile}`);
  }

  const qualityVerdictLines = lines.filter((line) => line.startsWith("QUALITY_VERDICT"));
  if (!qualityVerdictLines.includes("QUALITY_VERDICT:")) errors.push("missing required field: QUALITY_VERDICT");
  if (qualityVerdictLines.length > 1) errors.push("duplicate required field: QUALITY_VERDICT");
  if (qualityVerdictLines.length === 1 && qualityVerdictLines[0] !== "QUALITY_VERDICT:") {
    errors.push("malformed required field: QUALITY_VERDICT");
  }

  const seenKeys = [];
  for (const line of lines) {
    const keyLine = /^(?:[-*] )?\|?([A-Za-z][A-Za-z_]*) \[([^\]]*)\]: (.*)$/.exec(line);
    if (!keyLine) continue;
    const [, key, weight, rest] = keyLine;
    if (!REQUIRED_KEYS.includes(key)) {
      errors.push(`unknown key: ${key}`);
      continue;
    }
    if (seenKeys.includes(key)) errors.push(`duplicate key: ${key}`);
    seenKeys.push(key);
    if (!WEIGHTS.includes(weight)) errors.push(`invalid weight for ${key}: ${weight}`);

    const absent = /^N\/A(?: (.*))?$/.exec(rest);
    if (absent) {
      errors.push(...payloadErrors(absent[1], `${key} absent surface`));
      continue;
    }

    const sides = /^little=(\S+)(?: (.*))? ; much=(\S+)(?: (.*))?$/.exec(rest);
    if (!sides) {
      errors.push(`malformed sides: ${key}`);
      continue;
    }
    for (const [verdict, payload, side] of [
      [sides[1], sides[2], "little"],
      [sides[3], sides[4], "much"],
    ]) {
      if (!["PASS", "NOTE"].includes(verdict)) errors.push(`invalid verdict for ${key}.${side}: ${verdict}`);
      errors.push(...payloadErrors(payload, `${key}.${side}`));
    }
  }

  for (const key of REQUIRED_KEYS) {
    if (!seenKeys.includes(key)) errors.push(`missing key: ${key}`);
  }
  if (seenKeys.join() !== REQUIRED_KEYS.join()) errors.push("keys out of canonical order");

  for (const field of REQUIRED_TRAILING_FIELDS) {
    const fieldLines = lines.filter((line) => line.startsWith(`${field}:`));
    if (fieldLines.length === 0) errors.push(`missing required field: ${field}`);
    if (fieldLines.length > 1) errors.push(`duplicate required field: ${field}`);
    if (fieldLines.length === 1) {
      const value = fieldLines[0].slice(field.length + 1);
      errors.push(...payloadErrors(value, field));
    }
  }

  const expectedLineCount = 4 + REQUIRED_KEYS.length + REQUIRED_TRAILING_FIELDS.length;
  if (lines.length !== expectedLineCount) errors.push("unexpected packet line");
  if (lines[1]?.startsWith("G0:") !== true) errors.push("G0 is out of order");
  if (lines[2]?.startsWith("QUALITY_PROFILE:") !== true) errors.push("QUALITY_PROFILE is out of order");
  if (lines[3] !== "QUALITY_VERDICT:") errors.push("QUALITY_VERDICT is out of order");
  REQUIRED_KEYS.forEach((key, index) => {
    if (!lines[index + 4]?.startsWith(`${key} [`)) errors.push(`key is out of position: ${key}`);
  });
  REQUIRED_TRAILING_FIELDS.forEach((field, index) => {
    if (!lines[index + 4 + REQUIRED_KEYS.length]?.startsWith(`${field}:`)) {
      errors.push(`trailing field is out of position: ${field}`);
    }
  });

  if (lines.filter((line) => line === "## Quality Packet").length > 1) errors.push("duplicate heading");
  return [...new Set(errors)];
}
