import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractQualityPacketSection,
  MAX_QUALITY_PACKET_SECTION_BYTES,
  qualityPacketSectionErrors,
} from "./quality-packet-section-contract.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const skillPaths = [".agents/skills/delivery/SKILL.md", ".claude/skills/delivery/SKILL.md"];
const skills = skillPaths.map((path) => [path, readFileSync(`${repoRoot}/${path}`, "utf8")]);
const section = extractQualityPacketSection(skills[0][1]);

function scopesQualityPacketToFullPath(skill) {
  return /For full-path work,[^\n]*Quality Packet|Quality Packet is required only (?:on|for) the full path/i.test(
    skill,
  );
}

const densePacket = `## Quality Packet
G0: PASS — smallest shape is the existing money projection; not built: a Price value object (Money models it), a currency cache (no measured cost), a flag (render is backward-safe).
QUALITY_PROFILE: product-feature
QUALITY_VERDICT:
SCOPE [High]: little=PASS AC1-AC4 → listing-card.test.tsx rows 1-9 ; much=PASS diff == brief footprint, 4 files
ROBUSTNESS [Med]: little=PASS loading/empty/error/success in listing-card.test.tsx::states ; much=PASS no guard added
DEPTH [Med]: little=PASS no internal crosses a context edge; props narrowed to amount+currency ; much=PASS no new abstraction
READABILITY [Med]: little=PASS trace ListingCard → formatMoney, 2 files; names state behavior ; much=PASS no restating comment, no new identifier
TESTS [Med]: little=PASS ListingCard and formatMoney each pinned ; much=PASS asserts rendered text, survives refactor
OBSERVABILITY [Med]: little=PASS missing currency logs listing.price.currency_missing ; much=PASS no success-path log
SECURITY [High]: little=PASS no input, auth, secret, or personal datum crosses a boundary ; much=PASS no check added inside trusted code
PERFORMANCE [Low]: little=PASS no new query; render is O(page items) ; much=PASS no optimisation added
ROLLOUT [Med]: little=PASS column additive, nullable, reversible ; much=PASS legacy priceCents read path removed
CONSISTENCY [Med]: little=PASS follows marketplace/ui conventions ; much=NOTE brief called for a shared formatter; deferred, N2
EXPERIENCE [High]: little=PASS 4 states render; design-system Money slot ; much=PASS no local override
LANGUAGE [High]: little=PASS listingPrice, currency → marketplace GLOSSARY.md ; much=PASS no coined term, no synonym
Edits per key: ROBUSTNESS added the empty state; ROLLOUT deleted the legacy read; others no edit, checks re-run after each.
Enforcement pairs checked: price-pair rule → marketplace-listing-price-pair-callers.test.mjs; states rule → listing-card.test.tsx::states.
Unverifiable assumptions: none.`;

function withoutLine(source, prefix) {
  return source
    .split("\n")
    .filter((line) => !line.startsWith(prefix))
    .join("\n");
}

function replaceLine(source, prefix, replacement) {
  return source
    .split("\n")
    .map((line) => (line.startsWith(prefix) ? replacement : line))
    .join("\n");
}

function errorsFor(source) {
  return qualityPacketSectionErrors(source);
}

describe("delivery Quality Packet section contract", () => {
  it.each(skills)("pins the universal author loop and reviewer rule in %s", (_path, skill) => {
    expect(skill).toContain("Before the implementation head is dispatched for independent review");
    expect(skill).toContain("Answer G0 first");
    expect(skill).toContain(
      "SCOPE, ROBUSTNESS, DEPTH, READABILITY, TESTS, OBSERVABILITY, SECURITY, PERFORMANCE, ROLLOUT, CONSISTENCY, EXPERIENCE, and LANGUAGE",
    );
    expect(skill).toContain("For every changed rule, contract, or prose claim, check an enforcement pair");
    expect(skill).toContain("Re-run the scoped check after each fix");
    expect(skill).toContain("verify every Quality Packet claim and never adopt one");
    expect(skill).toContain("Changed a service function's signature?");
    expect(skill).toContain("Added validation to a command handler?");
    expect(skill).toContain("at or below 2,048 UTF-8 bytes");
    expect(skill).toContain("Unverifiable assumptions:");
  });

  it.each(skills)("publishes one section for every PR and retires both old packet sections in %s", (_path, skill) => {
    expect(skill).not.toMatch(/^## Review Packet$/m);
    expect(skill).not.toMatch(/^## Self-review$/m);
    expect(skill).not.toMatch(/review packet/i);
    expect(scopesQualityPacketToFullPath(skill)).toBe(false);
    expect(scopesQualityPacketToFullPath("For full-path work, add a Quality Packet.")).toBe(true);
    expect(skill).toContain("Every PR on every path must carry one `## Quality Packet`");
    expect(skill).toContain("6. Quality Packet");

    const prTemplate = /## PR & Readiness[\s\S]*?```markdown\r?\n([\s\S]*?)\r?\n```/.exec(skill)?.[1] ?? "";
    expect(prTemplate.match(/^## Quality Packet$/gm)).toHaveLength(1);
  });

  it("extracts and validates the named worked-example snippet instead of the earlier PR template", () => {
    expect(section).not.toBe("");
    expect(errorsFor(section)).toEqual([]);
    expect(section).toBe(extractQualityPacketSection(skills[1][1]));
    expect(skills[0][1].indexOf("## Quality Packet")).toBeLessThan(skills[0][1].indexOf("### Quality Packet snippet"));
  });

  it("accepts a dense packet with both sides present and zero N/A lines", () => {
    expect(densePacket).not.toContain(": N/A ");
    expect(errorsFor(densePacket)).toEqual([]);
  });

  it("accepts the exact UTF-8 boundary and rejects 2,049 bytes", () => {
    const exactSize = `${section}${" ".repeat(MAX_QUALITY_PACKET_SECTION_BYTES - Buffer.byteLength(section, "utf8"))}`;
    expect(Buffer.byteLength(exactSize, "utf8")).toBe(MAX_QUALITY_PACKET_SECTION_BYTES);
    expect(errorsFor(exactSize)).toEqual([]);
    expect(errorsFor(`${exactSize}x`)).toContain("section exceeds 2048 bytes");
  });

  const rejectMatrix = [
    ["missing heading", (value) => value.replace("## Quality Packet", "## Arbitrary"), "missing heading"],
    ["missing G0", (value) => withoutLine(value, "G0:"), "missing required field: G0"],
    [
      "duplicate G0",
      (value) => value.replace(/^G0:.*$/m, (line) => `${line}\n${line}`),
      "duplicate required field: G0",
    ],
    [
      "invalid G0 verdict",
      (value) => value.replace("G0: PASS", "G0: BLOCK_REPLAN"),
      "invalid G0 verdict: BLOCK_REPLAN",
    ],
    [
      "empty G0 payload",
      (value) => replaceLine(value, "G0:", "G0: PASS — "),
      "empty or placeholder payload for G0 not-built list",
    ],
    ["G0 without separator space", (value) => replaceLine(value, "G0:", "G0: PASS —not built: none."), "malformed G0"],
    [
      "placeholder G0 payload",
      (value) => replaceLine(value, "G0:", "G0: PASS — <not built, one reason each>"),
      "empty or placeholder payload for G0 not-built list",
    ],
    ["missing profile", (value) => withoutLine(value, "QUALITY_PROFILE:"), "missing required field: QUALITY_PROFILE"],
    [
      "duplicate profile",
      (value) => value.replace(/^QUALITY_PROFILE:.*$/m, (line) => `${line}\n${line}`),
      "duplicate required field: QUALITY_PROFILE",
    ],
    [
      "invalid profile",
      (value) => value.replace("QUALITY_PROFILE: contract", "QUALITY_PROFILE: full-path"),
      "invalid profile: full-path",
    ],
    [
      "missing QUALITY_VERDICT",
      (value) => withoutLine(value, "QUALITY_VERDICT:"),
      "missing required field: QUALITY_VERDICT",
    ],
    [
      "duplicate QUALITY_VERDICT",
      (value) => value.replace("QUALITY_VERDICT:", "QUALITY_VERDICT:\nQUALITY_VERDICT:"),
      "duplicate required field: QUALITY_VERDICT",
    ],
    [
      "nonempty QUALITY_VERDICT",
      (value) => value.replace("QUALITY_VERDICT:", "QUALITY_VERDICT: PASS"),
      "malformed required field: QUALITY_VERDICT",
    ],
    ["missing key", (value) => withoutLine(value, "TESTS ["), "missing key: TESTS"],
    ["duplicate key", (value) => value.replace(/^DEPTH .*$/m, (line) => `${line}\n${line}`), "duplicate key: DEPTH"],
    [
      "extra key",
      (value) =>
        value.replace(/^LANGUAGE /m, "ELEGANCE [Low]: little=PASS named probe ; much=PASS no excess\nLANGUAGE "),
      "unknown key: ELEGANCE",
    ],
    [
      "out-of-order keys",
      (value) => {
        const scope = value.match(/^SCOPE .*$/m)[0];
        const robustness = value.match(/^ROBUSTNESS .*$/m)[0];
        return value.replace(scope, "__SWAP__").replace(robustness, scope).replace("__SWAP__", robustness);
      },
      "keys out of canonical order",
    ],
    ["lowercase key", (value) => value.replace(/^SCOPE /m, "scope "), "unknown key: scope"],
    [
      "invalid weight",
      (value) => value.replace("SCOPE [High]", "SCOPE [Critical]"),
      "invalid weight for SCOPE: Critical",
    ],
    [
      "invalid verdict",
      (value) => value.replace("little=PASS AC1-AC4", "little=BLOCK AC1-AC4"),
      "invalid verdict for SCOPE.little: BLOCK",
    ],
    [
      "N/A side token",
      (value) => value.replace("little=PASS AC1-AC4", "little=N/A AC1-AC4"),
      "invalid verdict for SCOPE.little: N/A",
    ],
    [
      "missing much side",
      (value) => replaceLine(value, "SCOPE [", "SCOPE [High]: little=PASS AC1-AC4 → named test"),
      "malformed sides: SCOPE",
    ],
    [
      "empty side payload",
      (value) => replaceLine(value, "SCOPE [", "SCOPE [High]: little=PASS ; much=PASS named diff"),
      "empty or placeholder payload for SCOPE.little",
    ],
    [
      "placeholder side payload",
      (value) => replaceLine(value, "SCOPE [", "SCOPE [High]: little=PASS <payload> ; much=PASS named diff"),
      "empty or placeholder payload for SCOPE.little",
    ],
    [
      "bare side verdict",
      (value) => replaceLine(value, "SCOPE [", "SCOPE [High]: little=PASS PASS ; much=PASS named diff"),
      "unbounded evidence payload for SCOPE.little",
    ],
    [
      "unnamed tests reference",
      (value) => replaceLine(value, "SCOPE [", "SCOPE [High]: little=PASS see tests ; much=PASS named diff"),
      "unbounded evidence payload for SCOPE.little",
    ],
    [
      "empty absent surface",
      (value) => replaceLine(value, "EXPERIENCE [", "EXPERIENCE [Low]: N/A "),
      "empty or placeholder payload for EXPERIENCE absent surface",
    ],
    [
      "N/A table syntax",
      (value) => replaceLine(value, "EXPERIENCE [", "| EXPERIENCE [Low]: N/A no UI surface |"),
      "missing key: EXPERIENCE",
    ],
    [
      "list-item syntax",
      (value) => replaceLine(value, "SCOPE [", `- ${value.match(/^SCOPE .*$/m)[0]}`),
      "key is out of position: SCOPE",
    ],
    [
      "missing trailing field",
      (value) => withoutLine(value, "Unverifiable assumptions:"),
      "missing required field: Unverifiable assumptions",
    ],
    [
      "empty trailing field",
      (value) => replaceLine(value, "Edits per key:", "Edits per key: "),
      "empty or placeholder payload for Edits per key",
    ],
    [
      "placeholder trailing field",
      (value) => replaceLine(value, "Edits per key:", "Edits per key: <edit made, or no-change reason for each key>"),
      "empty or placeholder payload for Edits per key",
    ],
    [
      "duplicate trailing field",
      (value) => value.replace(/^Edits per key:.*$/m, (line) => `${line}\n${line}`),
      "duplicate required field: Edits per key",
    ],
    [
      "unexpected line",
      (value) => value.replace("QUALITY_VERDICT:", "QUALITY_VERDICT:\nprose outside the grammar"),
      "unexpected packet line",
    ],
  ];

  it.each(rejectMatrix)("rejects %s through the exported checker", (_name, mutate, expectedError) => {
    expect(errorsFor(mutate(section))).toContain(expectedError);
  });

  it("rejects a malformed packet nested under an arbitrary skill section", () => {
    const arbitrarySkill = `### Arbitrary snippet\n\n\`\`\`markdown\n${section}\n\`\`\``;
    const extracted = extractQualityPacketSection(arbitrarySkill);
    expect(extracted).toBe("");
    expect(errorsFor(extracted)).not.toEqual([]);
  });

  it("does not cross a following heading to find the worked-example fence", () => {
    const crossHeadingSkill = `### Quality Packet snippet

The required worked example is missing here.

## Unrelated section

\`\`\`markdown
${section}
\`\`\``;
    expect(extractQualityPacketSection(crossHeadingSkill)).toBe("");
  });

  it("does not treat an inline snippet-name mention as the structural selector", () => {
    const inlineOnlySkill = `Use ### Quality Packet snippet here.\n\n\`\`\`markdown\n${section}\n\`\`\``;
    expect(extractQualityPacketSection(inlineOnlySkill)).toBe("");
  });

  it("treats only known template tokens as placeholders, preserving legitimate generic type text", () => {
    const withGenericType = densePacket.replace(
      "much=PASS no coined term, no synonym",
      "much=PASS Money<Currency> matches the marketplace contract",
    );
    expect(errorsFor(withGenericType)).toEqual([]);
    expect(errorsFor(densePacket.replace("much=PASS no coined term, no synonym", "much=PASS <payload>"))).not.toEqual(
      [],
    );
  });
});
