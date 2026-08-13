import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DISPATCH_BRIEF_COLLECTION_CODES,
  DISPATCH_BRIEF_GUARD_CODES,
  DISPATCH_BRIEF_MANIFEST_END,
  DISPATCH_BRIEF_MANIFEST_FIELDS,
  DISPATCH_BRIEF_MANIFEST_START,
  DISPATCH_BRIEF_PART_FIELDS,
  DISPATCH_BRIEF_REFUSAL_CODES,
  emitDispatchBriefManifest,
  emitDispatchBriefParts,
  resolveIssueDispatchBrief,
} from "./issue-dispatch-brief.mjs";
import { COMMENT_MARKER } from "./issue-readiness.mjs";

const REPOSITORY = "chase-sets/chase-sets";
const ISSUE_NUMBER = 6680;
const ISSUE_NODE_ID = "I_kwDORKgVcc8AAAABL9flsw";
const ISSUE_URL = `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`;
const CREATED_AT = "2026-08-12T14:10:31Z";
const SECTION_NAMES = Object.freeze([
  "Context",
  "Scope fence",
  "Decisions already made",
  "Acceptance criteria",
  "Verification plan",
  "Footprint & chain",
  "Operator actions",
  "Glossary impact",
  "External authority probe & evidence timing",
  "Review packet seed",
  "Tier + routing hint",
]);
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/canonical-record-v1.json", import.meta.url), "utf8"));
const MODULE_SOURCE = readFileSync(new URL("./issue-dispatch-brief.mjs", import.meta.url), "utf8");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function formBody(names = SECTION_NAMES) {
  return names.map((name, index) => `## ${name}\nvalue-${index + 1}`).join("\n");
}

function makePart(body = "continuation", index = 0, overrides = {}) {
  const bodyBytes = Buffer.from(body, "utf8");
  return {
    order: index + 1,
    databaseId: 5_300_000_000 + index,
    nodeId: `IC_synthetic${index + 1}`,
    issueUrl: ISSUE_URL,
    authorLogin: "todd-skelton",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    utf8Bytes: bodyBytes.length,
    sha256: digest(bodyBytes),
    ...overrides,
  };
}

function manifestFor(parts = [], overrides = {}) {
  const manifest = {
    schemaVersion: "dispatch-brief/v2",
    issue: { repository: REPOSITORY, number: ISSUE_NUMBER, nodeId: ISSUE_NODE_ID },
    parts,
    partsDigest: digest(emitDispatchBriefParts(parts)),
    ...overrides,
  };
  return manifest;
}

function bodyWithManifestText(manifestText, prefix = formBody(), suffix = "") {
  return `${prefix}\n${DISPATCH_BRIEF_MANIFEST_START}\n${manifestText}\n${DISPATCH_BRIEF_MANIFEST_END}\n${suffix}`;
}

function bodyWithManifest(manifest, prefix = formBody(), suffix = "") {
  return bodyWithManifestText(emitDispatchBriefManifest(manifest).toString("utf8"), prefix, suffix);
}

function restComment(part, body, overrides = {}) {
  return {
    id: part.databaseId,
    node_id: part.nodeId,
    issue_url: part.issueUrl,
    body,
    created_at: part.createdAt,
    updated_at: part.updatedAt,
    user: { login: part.authorLogin, type: "User" },
    ...overrides,
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function fixtureFor(partBodies = [], options = {}) {
  const parts = partBodies.map((body, index) => makePart(body, index, options.partOverrides?.[index]));
  const manifest = options.manifest ?? manifestFor(parts);
  const body =
    options.body ??
    bodyWithManifest(manifest, options.prefix ?? formBody(), options.suffix === undefined ? "" : options.suffix);
  const collected =
    options.collected ??
    parts.map((part, index) => ({
      id: part.databaseId,
      nodeId: part.nodeId,
      issueUrl: part.issueUrl,
      body: partBodies[index],
      createdAt: part.createdAt,
      updatedAt: part.updatedAt,
      author: { login: part.authorLogin, type: "User" },
    }));
  const authority = options.authority ?? {
    complete: true,
    issue: { body, nodeId: ISSUE_NODE_ID },
    comments: collected,
    reasonCodes: [],
  };
  const requests = [];
  const client = async (url, init = {}) => {
    requests.push({ url, init });
    const commentMatch = /\/issues\/comments\/(\d+)$/u.exec(url);
    if (commentMatch) {
      const index = parts.findIndex(({ databaseId }) => databaseId === Number(commentMatch[1]));
      const status = options.restStatuses?.[index] ?? 200;
      const raw = restComment(parts[index], partBodies[index], options.restOverrides?.[index]);
      return response(raw, status);
    }
    if (url === "https://api.github.com/graphql") {
      const { variables } = JSON.parse(init.body);
      const index = parts.findIndex(({ nodeId }) => nodeId === variables.id);
      const part = parts[index];
      const owner = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/u.exec(
        options.restOverrides?.[index]?.issue_url ?? part.issueUrl,
      );
      const node = {
        id: part.nodeId,
        databaseId: part.databaseId,
        author: { login: part.authorLogin },
        issue: { number: Number(owner?.[2] ?? ISSUE_NUMBER), repository: { nameWithOwner: owner?.[1] ?? REPOSITORY } },
        ...options.graphOverrides?.[index],
      };
      return response({ data: { node } }, options.graphStatuses?.[index] ?? 200);
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };
  const seams = {
    collectAuthority: async () => authority,
    ...options.seams,
  };
  return { authority, body, client, manifest, parts, requests, seams };
}

async function resolveFixture(fixture) {
  return resolveIssueDispatchBrief({
    repository: REPOSITORY,
    number: ISSUE_NUMBER,
    token: "test-token",
    client: fixture.client,
    seams: fixture.seams,
  });
}

async function resolveManifestText(text, options = {}) {
  return resolveFixture(fixtureFor([], { ...options, body: bodyWithManifestText(text, options.prefix ?? formBody()) }));
}

function expectUnknown(result, code) {
  expect(result).toEqual(expect.objectContaining({ status: "unknown", reasonCode: code }));
  expect(result).not.toHaveProperty("assembledBytes");
  expect(result).not.toHaveProperty("assembledSha256");
}

function clone(value) {
  return structuredClone(value);
}

describe("dispatch-brief manifest and canonical preimages", () => {
  it("defines each byte-exact line marker once without a transcribed length", () => {
    for (const [marker, boundary] of [
      [DISPATCH_BRIEF_MANIFEST_START, "start"],
      [DISPATCH_BRIEF_MANIFEST_END, "end"],
    ]) {
      const composed = `<!-- chase-sets:dispatch-brief-manifest:v2:${boundary} -->`;
      expect(marker).toBe(composed);
      expect(Buffer.byteLength(marker, "ascii")).toBe(Buffer.from(composed, "ascii").length);
      expect(Buffer.from(marker, "ascii").toString("ascii")).toBe(marker);
    }
  });

  it("resolves body-only and zero-part manifest briefs without inventing part bytes", async () => {
    const bodyOnly = `${formBody()}\n`;
    const bodyResult = await resolveFixture(fixtureFor([], { body: bodyOnly }));
    const manifestResult = await resolveFixture(fixtureFor([]));

    expect(bodyResult).toMatchObject({
      status: "resolved",
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      issueNodeId: ISSUE_NODE_ID,
      manifestSha256: null,
      parts: [],
    });
    expect(bodyResult.assembledBytes.equals(Buffer.from(bodyOnly))).toBe(true);
    expect(bodyResult.bodySha256).toBe(digest(Buffer.from(bodyOnly)));
    expect(manifestResult).toMatchObject({ status: "resolved", parts: [] });
    expect(manifestResult.manifestSha256).toBe(digest(emitDispatchBriefManifest(manifestFor())));
    expect(manifestResult.partsDigest).toBe(digest(Buffer.from("[]")));
  });

  it("manifest grammar refuses every one-variable mutant", async () => {
    const part = makePart("part");
    const valid = manifestFor([part]);
    const canonical = emitDispatchBriefManifest(valid).toString("utf8");
    const cases = [
      ["missing marker", `${formBody()}\n${DISPATCH_BRIEF_MANIFEST_START}\n${canonical}\n`, "MANIFEST_MARKER_INVALID"],
      [
        "duplicated marker",
        `${bodyWithManifestText(canonical)}${DISPATCH_BRIEF_MANIFEST_START}\n`,
        "MANIFEST_MARKER_INVALID",
      ],
      [
        "unanchored marker",
        bodyWithManifestText(canonical).replace(DISPATCH_BRIEF_MANIFEST_START, `x${DISPATCH_BRIEF_MANIFEST_START}`),
        "MANIFEST_MARKER_INVALID",
      ],
      [
        "empty region",
        `${formBody()}\n${DISPATCH_BRIEF_MANIFEST_START}\n${DISPATCH_BRIEF_MANIFEST_END}\n`,
        "MANIFEST_REGION_SHAPE_INVALID",
      ],
      ["two-line region", bodyWithManifestText(`${canonical}\n{}`), "MANIFEST_REGION_SHAPE_INVALID"],
      ["whitespace padding", bodyWithManifestText(` ${canonical}`), "MANIFEST_NOT_CANONICAL"],
      ["indentation", bodyWithManifestText(canonical.replace("{", "{ ")), "MANIFEST_NOT_CANONICAL"],
      [
        "top-level reordering",
        bodyWithManifestText(
          JSON.stringify({
            issue: valid.issue,
            schemaVersion: valid.schemaVersion,
            parts: valid.parts,
            partsDigest: valid.partsDigest,
          }),
        ),
        "MANIFEST_NOT_CANONICAL",
      ],
      [
        "nested reordering",
        bodyWithManifestText(
          JSON.stringify({
            ...valid,
            issue: { number: valid.issue.number, repository: valid.issue.repository, nodeId: valid.issue.nodeId },
          }),
        ),
        "MANIFEST_NOT_CANONICAL",
      ],
      [
        "part reordering",
        bodyWithManifestText(
          JSON.stringify({
            ...valid,
            parts: [
              {
                databaseId: part.databaseId,
                order: part.order,
                nodeId: part.nodeId,
                issueUrl: part.issueUrl,
                authorLogin: part.authorLogin,
                createdAt: part.createdAt,
                updatedAt: part.updatedAt,
                utf8Bytes: part.utf8Bytes,
                sha256: part.sha256,
              },
            ],
          }),
        ),
        "MANIFEST_NOT_CANONICAL",
      ],
      [
        "duplicate collapsed key",
        bodyWithManifestText(
          canonical.replace('{"schemaVersion":', '{"schemaVersion":"dispatch-brief/v2","schemaVersion":'),
        ),
        "MANIFEST_NOT_CANONICAL",
      ],
    ];
    for (const [name, body, code] of cases) {
      const result = await resolveFixture(fixtureFor(["part"], { body }));
      expectUnknown(result, code);
      expect(name).toBeTruthy();
    }

    for (const [depth, mutate] of [
      ["top", (value) => delete value.partsDigest],
      ["issue", (value) => delete value.issue.nodeId],
      ["part", (value) => delete value.parts[0].sha256],
    ]) {
      const mutant = clone(valid);
      mutate(mutant);
      expectUnknown(await resolveManifestText(JSON.stringify(mutant)), "MANIFEST_KEY_MISSING");
      expect(depth).toBeTruthy();
    }
    for (const [depth, mutate] of [
      ["top", (value) => (value.extra = "x")],
      ["issue", (value) => (value.issue.extra = "x")],
      ["part", (value) => (value.parts[0].extra = "x")],
    ]) {
      const mutant = clone(valid);
      mutate(mutant);
      expectUnknown(await resolveManifestText(JSON.stringify(mutant)), "MANIFEST_KEY_UNKNOWN");
      expect(depth).toBeTruthy();
    }
    for (const [depth, mutate] of [
      ["top-null", (value) => (value.parts = null)],
      ["top-boolean", (value) => (value.parts = true)],
      ["issue-object-for-scalar", (value) => (value.issue.number = {})],
      ["part-array-for-scalar", (value) => (value.parts[0].databaseId = [])],
    ]) {
      const mutant = clone(valid);
      mutate(mutant);
      expectUnknown(await resolveManifestText(JSON.stringify(mutant)), "MANIFEST_TYPE_INVALID");
      expect(depth).toBeTruthy();
    }

    const domainMutant = clone(valid);
    domainMutant.parts[0].authorLogin = "-invalid";
    expectUnknown(await resolveManifestText(JSON.stringify(domainMutant)), "MANIFEST_DOMAIN_INVALID");

    for (const token of ["1e0", "1.0", "+1", "01", "-0", "9007199254740992"]) {
      const numberText = emitDispatchBriefManifest(manifestFor())
        .toString("utf8")
        .replace(`"number":${ISSUE_NUMBER}`, `"number":${token}`);
      expectUnknown(await resolveManifestText(numberText), "MANIFEST_NUMBER_TOKEN_INVALID");
    }
  });

  it("schema validation precedes emission and no canonical code escapes", async () => {
    const unknownKey = { ...manifestFor(), unexpected: "value" };
    let emitterCalled = false;
    const result = await resolveManifestText(JSON.stringify(unknownKey), {
      seams: {
        emitManifest() {
          emitterCalled = true;
          throw new Error("CANONICAL_KEY_SET_MISMATCH");
        },
      },
    });
    expectUnknown(result, "MANIFEST_KEY_UNKNOWN");
    expect(emitterCalled).toBe(false);

    const emitterFault = fixtureFor([], {
      seams: {
        emitManifest: () => {
          throw new Error("CANONICAL_FAILURE");
        },
      },
    });
    expectUnknown(await resolveFixture(emitterFault), "INTERNAL_FAILURE");
    expect(DISPATCH_BRIEF_REFUSAL_CODES.some((code) => code.startsWith("CANONICAL_"))).toBe(false);
  });

  it("manifest canonicality is decided by the landed emitter", async () => {
    const canonical = emitDispatchBriefManifest(manifestFor());
    const result = await resolveFixture(
      fixtureFor([], { seams: { emitManifest: () => Buffer.concat([canonical, Buffer.from(" ")]) } }),
    );
    expectUnknown(result, "MANIFEST_NOT_CANONICAL");
    expect(MODULE_SOURCE.match(/JSON\.stringify/g)).toHaveLength(1);
    expect(MODULE_SOURCE).toContain("body: JSON.stringify({ query: COMMENT_OWNER_QUERY");
  });

  it("the declared manifest schema matches the committed golden vectors", () => {
    const vectors = FIXTURE.vectors.filter(({ id }) => /^V(?:5|6|7|8|9|10)-/u.test(id));
    expect(vectors).toHaveLength(6);
    for (const vector of vectors) {
      const expectedFields =
        vector.entryPoint === "emitRecord" ? DISPATCH_BRIEF_MANIFEST_FIELDS : DISPATCH_BRIEF_PART_FIELDS;
      const emitted =
        vector.entryPoint === "emitRecord"
          ? emitDispatchBriefManifest(vector.value)
          : emitDispatchBriefParts(vector.value);
      expect(expectedFields).toEqual(vector.fields);
      expect(emitted.toString("utf8")).toBe(vector.canonicalText);
      expect(emitted).toHaveLength(vector.utf8Bytes);
      expect(digest(emitted)).toBe(vector.sha256);
    }
    const empty = vectors.find(({ id }) => id === "V8-parts-array-zero");
    expect(empty.canonicalText).toBe("[]");
    expect(empty.utf8Bytes).toBe(2);
    expect(empty.sha256).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  });

  it("parts digest is closed at every part count", async () => {
    for (const count of [0, 1, 2]) {
      const manifestVector = FIXTURE.vectors.find(({ id }) => id.startsWith(`V${5 + count}-manifest-`));
      const partsVector = FIXTURE.vectors.find(({ id }) => id.startsWith(`V${8 + count}-parts-array-`));
      expect(manifestVector.value.partsDigest).toBe(partsVector.sha256);
      expect(digest(emitDispatchBriefParts(manifestVector.value.parts))).toBe(manifestVector.value.partsDigest);
    }
    const wrong = { ...manifestFor(), partsDigest: digest(Buffer.from("{}")) };
    expectUnknown(await resolveManifestText(JSON.stringify(wrong)), "MANIFEST_PARTS_DIGEST_MISMATCH");
  });
});

describe("dispatch-brief part binding, assembly, and segment grammar", () => {
  it("part set refuses reorder duplicate and omission", async () => {
    const bodies = ["first", "second"];
    const validFixture = fixtureFor(bodies);
    expect((await resolveFixture(validFixture)).status).toBe("resolved");

    const reorderedParts = [validFixture.parts[1], validFixture.parts[0]];
    const reordered = manifestFor(reorderedParts);
    expectUnknown(await resolveFixture(fixtureFor(bodies, { manifest: reordered })), "MANIFEST_DOMAIN_INVALID");

    for (const key of ["databaseId", "nodeId"]) {
      const duplicateParts = clone(validFixture.parts);
      duplicateParts[1][key] = duplicateParts[0][key];
      const duplicateManifest = manifestFor(duplicateParts);
      expectUnknown(await resolveFixture(fixtureFor(bodies, { manifest: duplicateManifest })), "PART_DUPLICATE");
    }
    expectUnknown(await resolveFixture(fixtureFor(["first"], { collected: [] })), "PART_NOT_FOUND");
    const mismatch = { ...manifestFor(validFixture.parts), partsDigest: "0".repeat(64) };
    expectUnknown(await resolveFixture(fixtureFor(bodies, { manifest: mismatch })), "MANIFEST_PARTS_DIGEST_MISMATCH");
  });

  it("unmanifested comments do not change the assembled digest", async () => {
    const fixture = fixtureFor(["selected"]);
    const first = await resolveFixture(fixture);
    const unmanifested = makePart("ignored", 9);
    const second = await resolveFixture(
      fixtureFor(["selected"], {
        collected: [
          ...fixture.authority.comments,
          {
            id: unmanifested.databaseId,
            nodeId: unmanifested.nodeId,
            issueUrl: unmanifested.issueUrl,
            body: "ignored",
            createdAt: unmanifested.createdAt,
            updatedAt: unmanifested.updatedAt,
            author: { login: unmanifested.authorLogin, type: "User" },
          },
        ],
      }),
    );
    expect(first.status).toBe("resolved");
    expect(second.status).toBe("resolved");
    expect(second.assembledSha256).toBe(first.assembledSha256);
    expect(second.parts).toEqual(first.parts);
  });

  it("part and aggregate ceilings are exact at the boundary", async () => {
    const emptyDeclared = makePart("", 0, { utf8Bytes: 1 });
    const emptyManifest = manifestFor([emptyDeclared]);
    expectUnknown(await resolveFixture(fixtureFor([""], { manifest: emptyManifest })), "PART_EMPTY");

    expect(await resolveFixture(fixtureFor(["x".repeat(60_000)]))).toMatchObject({ status: "resolved" });
    const largeDeclared = makePart("x".repeat(60_001), 0, { utf8Bytes: 60_000 });
    expectUnknown(
      await resolveFixture(fixtureFor(["x".repeat(60_001)], { manifest: manifestFor([largeDeclared]) })),
      "PART_TOO_LARGE",
    );

    const threeParts = ["a", "b", "c"].map((body, index) => makePart(body, index));
    expectUnknown(await resolveManifestText(JSON.stringify(manifestFor(threeParts))), "MANIFEST_DOMAIN_INVALID");

    const twoBodies = ["x".repeat(60_000), "y".repeat(60_000)];
    const aggregateFixture = fixtureFor(twoBodies);
    const exactBody = `${aggregateFixture.body}${"z".repeat(59_998 - Buffer.byteLength(aggregateFixture.body))}`;
    const exact = await resolveFixture(fixtureFor(twoBodies, { body: exactBody, manifest: aggregateFixture.manifest }));
    expect(exact.status).toBe("resolved");
    expect(exact.assembledBytes).toHaveLength(180_000);

    const tooLargeBody = `${exactBody}z`;
    expectUnknown(
      await resolveFixture(fixtureFor(twoBodies, { body: tooLargeBody, manifest: aggregateFixture.manifest })),
      "ASSEMBLED_TOO_LARGE",
    );
  });

  it("segment fence closure uses the trusted marker and length machine", async () => {
    const controls = [
      ["tilde cross-close", "~~~text", "~~~", 0],
      ["four versus three", "````text", "```", 0],
      ["backtick versus tilde", "```text", "~~~", 0],
      ["indented opener", "  ```text", "```", 0],
      ["part opens", "", "```text\ninside", 1],
    ];
    for (const [name, opener, partBody, segmentIndex] of controls) {
      const parts = [makePart(partBody)];
      const manifest = manifestFor(parts);
      const body = bodyWithManifest(manifest, formBody(), opener ? `\n${opener}\ninside` : "");
      const result = await resolveFixture(fixtureFor([partBody], { body, manifest }));
      expectUnknown(result, "SEGMENT_FENCE_UNCLOSED");
      expect(result.details).toEqual({ segmentIndex });
      expect(name).toBeTruthy();
    }

    const closedPart = "```text\npart\n```";
    const closedManifest = manifestFor([makePart(closedPart)]);
    const closedBody = bodyWithManifest(closedManifest, formBody(), "\n~~~text\nbody\n~~~");
    expect(
      (await resolveFixture(fixtureFor([closedPart], { body: closedBody, manifest: closedManifest }))).status,
    ).toBe("resolved");
  });

  it("assembled form validity refuses every reachable heading damage", async () => {
    const withoutScope = SECTION_NAMES.filter((name) => name !== "Scope fence");
    const splitPart = makePart("fence\ncontinued");
    const splitManifest = manifestFor([splitPart]);
    const splitBody = bodyWithManifest(splitManifest, formBody(withoutScope), "## Scope");
    expectUnknown(
      await resolveFixture(fixtureFor(["fence\ncontinued"], { body: splitBody, manifest: splitManifest })),
      "ASSEMBLED_HEADING_COUNT_INVALID",
    );

    const duplicatePartBody = "## Context\nduplicate";
    const duplicate = await resolveFixture(fixtureFor([duplicatePartBody]));
    expectUnknown(duplicate, "ASSEMBLED_FORM_INVALID");
    expect(duplicate.details.scannerReasonCodes).toEqual(["FORM_FIELD_DUPLICATE:Context"]);

    const swallowed = bodyWithManifest(manifestFor(), formBody(withoutScope), "```text\n## Scope fence\nhidden\n```\n");
    expectUnknown(await resolveFixture(fixtureFor([], { body: swallowed })), "ASSEMBLED_HEADING_COUNT_INVALID");
  });

  it("a displayed manifest is never a declared manifest", async () => {
    const partBody = "continuation";
    const part = makePart(partBody);
    const manifest = manifestFor([part]);
    const text = emitDispatchBriefManifest(manifest).toString("utf8");
    const fenced = `${formBody()}\n\`\`\`text\n${DISPATCH_BRIEF_MANIFEST_START}\n${text}\n${DISPATCH_BRIEF_MANIFEST_END}\n\`\`\`\n`;
    const fencedResult = await resolveFixture(fixtureFor([partBody], { body: fenced, manifest }));
    expectUnknown(fencedResult, "MANIFEST_MARKER_FENCED");
    expect(fencedResult.details.offset).toBe(Buffer.byteLength(`${formBody()}\n\`\`\`text\n`));

    const unfenced = await resolveFixture(fixtureFor([partBody]));
    expect(unfenced).toMatchObject({ status: "resolved", parts: [part] });

    const deletedG12 = await resolveFixture(
      fixtureFor([partBody], {
        body: fenced,
        manifest,
        seams: { disabledGuards: ["MANIFEST_MARKER_FENCED"] },
      }),
    );
    expect(deletedG12).toMatchObject({ status: "resolved", parts: [part] });

    const both = `${fenced}${bodyWithManifest(manifest)}`;
    expectUnknown(await resolveFixture(fixtureFor([partBody], { body: both, manifest })), "MANIFEST_MARKER_FENCED");

    const wrongManifest = { ...manifest, partsDigest: "0".repeat(64) };
    const wildWitness = `${formBody()}\n\`\`\`text\n${DISPATCH_BRIEF_MANIFEST_START}\n${JSON.stringify(wrongManifest)}\n${DISPATCH_BRIEF_MANIFEST_END}\n\`\`\`\n`;
    const wildResult = await resolveFixture(
      fixtureFor([partBody], {
        body: wildWitness,
        manifest: wrongManifest,
        seams: { disabledGuards: ["MANIFEST_MARKER_FENCED"] },
      }),
    );
    expectUnknown(wildResult, "MANIFEST_PARTS_DIGEST_MISMATCH");
    expect(wildResult.status).not.toBe("resolved");
  });

  it("individual comment probe binds every part to its exact owning issue", async () => {
    const base = fixtureFor(["bound part"]);
    expect((await resolveFixture(base)).status).toBe("resolved");

    for (const status of [404, 410]) {
      expectUnknown(await resolveFixture(fixtureFor(["bound part"], { restStatuses: [status] })), "PART_INACCESSIBLE");
    }
    expectUnknown(await resolveFixture(fixtureFor(["bound part"], { restStatuses: [500] })), "PART_READ_FAILED");
    expectUnknown(await resolveFixture(fixtureFor(["bound part"], { collected: [] })), "PART_NOT_FOUND");

    const crossRepositoryUrl = "https://api.github.com/repos/other-owner/other-repo/issues/6680";
    expectUnknown(
      await resolveFixture(fixtureFor(["bound part"], { restOverrides: [{ issue_url: crossRepositoryUrl }] })),
      "PART_CROSS_REPOSITORY",
    );
    const crossIssueUrl = `https://api.github.com/repos/${REPOSITORY}/issues/6681`;
    expectUnknown(
      await resolveFixture(fixtureFor(["bound part"], { restOverrides: [{ issue_url: crossIssueUrl }] })),
      "PART_CROSS_ISSUE",
    );

    for (const override of [
      { user: { login: "other-user", type: "User" } },
      { created_at: "2026-08-12T14:10:30Z" },
      { updated_at: "2026-08-12T14:10:32Z" },
      { body: "mutated" },
      { node_id: "IC_other" },
    ]) {
      expectUnknown(
        await resolveFixture(fixtureFor(["bound part"], { restOverrides: [override] })),
        "PART_IDENTITY_DRIFT",
      );
    }

    const receiptBody = `${COMMENT_MARKER}\nreceipt`;
    expectUnknown(await resolveFixture(fixtureFor([receiptBody])), "PART_IS_READINESS_RECEIPT");
    const nestedBody = `${DISPATCH_BRIEF_MANIFEST_START}\nnested`;
    expectUnknown(await resolveFixture(fixtureFor([nestedBody])), "PART_NESTED_MANIFEST");
    expectUnknown(
      await resolveFixture(
        fixtureFor(["bound part"], {
          graphOverrides: [{ issue: { number: ISSUE_NUMBER, repository: { nameWithOwner: "other/repo" } } }],
        }),
      ),
      "PART_OWNER_BINDING_DISAGREES",
    );
  });
});

describe("dispatch-brief refusal closure", () => {
  it("every declared refusal code has a one-predicate discriminating control", async () => {
    expect(DISPATCH_BRIEF_GUARD_CODES).toHaveLength(26);
    expect(DISPATCH_BRIEF_COLLECTION_CODES).toHaveLength(8);
    expect(DISPATCH_BRIEF_REFUSAL_CODES).toHaveLength(35);
    expect(new Set(DISPATCH_BRIEF_REFUSAL_CODES).size).toBe(35);
    expect(new Set(DISPATCH_BRIEF_GUARD_CODES)).toEqual(
      new Set(
        DISPATCH_BRIEF_REFUSAL_CODES.filter(
          (code) => !DISPATCH_BRIEF_COLLECTION_CODES.includes(code) && code !== "INTERNAL_FAILURE",
        ),
      ),
    );

    const zeroCanonical = emitDispatchBriefManifest(manifestFor()).toString("utf8");
    const missing = clone(manifestFor());
    delete missing.partsDigest;
    const unknownKey = { ...manifestFor(), extra: "x" };
    const wrongType = { ...manifestFor(), parts: null };
    const wrongDomain = { ...manifestFor(), schemaVersion: "dispatch-brief/v1" };
    const wrongDigest = { ...manifestFor(), partsDigest: "0".repeat(64) };
    const duplicateParts = [makePart("first", 0), makePart("second", 1)];
    duplicateParts[1].databaseId = duplicateParts[0].databaseId;
    const emptyPart = makePart("", 0, { utf8Bytes: 1 });
    const largeBody = "x".repeat(60_001);
    const largePart = makePart(largeBody, 0, { utf8Bytes: 60_000 });
    const segmentPart = makePart("```");
    const segmentManifest = manifestFor([segmentPart]);
    const segmentBody = bodyWithManifest(segmentManifest, formBody(), "```text\ninside");
    const aggregateBodies = ["x".repeat(60_000), "y".repeat(60_000)];
    const aggregate = fixtureFor(aggregateBodies);
    const exactAggregateBody = `${aggregate.body}${"z".repeat(59_998 - Buffer.byteLength(aggregate.body))}`;
    const fencedBody = `${formBody()}\n\`\`\`text\n${DISPATCH_BRIEF_MANIFEST_START}\n${zeroCanonical}\n${DISPATCH_BRIEF_MANIFEST_END}\n\`\`\`\n`;

    const controls = new Map([
      [
        "MANIFEST_MARKER_INVALID",
        [
          fixtureFor([], { body: `${formBody()}\n${DISPATCH_BRIEF_MANIFEST_START}\n${zeroCanonical}\n` }),
          fixtureFor([]),
        ],
      ],
      ["MANIFEST_MARKER_FENCED", [fixtureFor([], { body: fencedBody }), fixtureFor([])]],
      [
        "MANIFEST_REGION_SHAPE_INVALID",
        [
          fixtureFor([], {
            body: `${formBody()}\n${DISPATCH_BRIEF_MANIFEST_START}\n${DISPATCH_BRIEF_MANIFEST_END}\n`,
          }),
          fixtureFor([]),
        ],
      ],
      ["MANIFEST_NOT_CANONICAL", [fixtureFor([], { body: bodyWithManifestText(` ${zeroCanonical}`) }), fixtureFor([])]],
      [
        "MANIFEST_KEY_MISSING",
        [fixtureFor([], { body: bodyWithManifestText(JSON.stringify(missing)) }), fixtureFor([])],
      ],
      [
        "MANIFEST_KEY_UNKNOWN",
        [fixtureFor([], { body: bodyWithManifestText(JSON.stringify(unknownKey)) }), fixtureFor([])],
      ],
      [
        "MANIFEST_TYPE_INVALID",
        [fixtureFor([], { body: bodyWithManifestText(JSON.stringify(wrongType)) }), fixtureFor([])],
      ],
      [
        "MANIFEST_DOMAIN_INVALID",
        [fixtureFor([], { body: bodyWithManifestText(JSON.stringify(wrongDomain)) }), fixtureFor([])],
      ],
      [
        "MANIFEST_NUMBER_TOKEN_INVALID",
        [
          fixtureFor([], {
            body: bodyWithManifestText(zeroCanonical.replace(`"number":${ISSUE_NUMBER}`, '"number":1e0')),
          }),
          fixtureFor([]),
        ],
      ],
      [
        "MANIFEST_PARTS_DIGEST_MISMATCH",
        [fixtureFor([], { body: bodyWithManifestText(JSON.stringify(wrongDigest)) }), fixtureFor([])],
      ],
      [
        "PART_DUPLICATE",
        [fixtureFor(["first", "second"], { manifest: manifestFor(duplicateParts) }), fixtureFor(["first", "second"])],
      ],
      ["PART_NOT_FOUND", [fixtureFor(["part"], { collected: [] }), fixtureFor(["part"])]],
      ["PART_INACCESSIBLE", [fixtureFor(["part"], { restStatuses: [404] }), fixtureFor(["part"])]],
      ["PART_READ_FAILED", [fixtureFor(["part"], { restStatuses: [500] }), fixtureFor(["part"])]],
      [
        "PART_CROSS_REPOSITORY",
        [
          fixtureFor(["part"], {
            restOverrides: [{ issue_url: "https://api.github.com/repos/other/repo/issues/6680" }],
          }),
          fixtureFor(["part"]),
        ],
      ],
      [
        "PART_CROSS_ISSUE",
        [
          fixtureFor(["part"], { restOverrides: [{ issue_url: `${ISSUE_URL.slice(0, -4)}6681` }] }),
          fixtureFor(["part"]),
        ],
      ],
      ["PART_IDENTITY_DRIFT", [fixtureFor(["part"], { restOverrides: [{ body: "drift" }] }), fixtureFor(["part"])]],
      [
        "PART_OWNER_BINDING_DISAGREES",
        [
          fixtureFor(["part"], {
            graphOverrides: [{ issue: { number: ISSUE_NUMBER, repository: { nameWithOwner: "other/repo" } } }],
          }),
          fixtureFor(["part"]),
        ],
      ],
      ["PART_EMPTY", [fixtureFor([""], { manifest: manifestFor([emptyPart]) }), fixtureFor(["x"])]],
      [
        "PART_TOO_LARGE",
        [fixtureFor([largeBody], { manifest: manifestFor([largePart]) }), fixtureFor(["x".repeat(60_000)])],
      ],
      ["PART_IS_READINESS_RECEIPT", [fixtureFor([`${COMMENT_MARKER}\nreceipt`]), fixtureFor(["part"])]],
      ["PART_NESTED_MANIFEST", [fixtureFor([`${DISPATCH_BRIEF_MANIFEST_START}\nnested`]), fixtureFor(["part"])]],
      [
        "SEGMENT_FENCE_UNCLOSED",
        [fixtureFor(["```"], { body: segmentBody, manifest: segmentManifest }), fixtureFor(["```\nclosed\n```"])],
      ],
      ["ASSEMBLED_FORM_INVALID", [fixtureFor(["## Context\nduplicate"]), fixtureFor(["part"])]],
      [
        "ASSEMBLED_HEADING_COUNT_INVALID",
        [
          fixtureFor([], { body: `${formBody(SECTION_NAMES.slice(1))}\n` }),
          fixtureFor([], { body: `${formBody()}\n` }),
        ],
      ],
      [
        "ASSEMBLED_TOO_LARGE",
        [
          fixtureFor(aggregateBodies, {
            body: `${exactAggregateBody}z`,
            manifest: aggregate.manifest,
          }),
          fixtureFor(aggregateBodies, { body: exactAggregateBody, manifest: aggregate.manifest }),
        ],
      ],
    ]);

    expect(new Set(controls.keys())).toEqual(new Set(DISPATCH_BRIEF_GUARD_CODES));
    for (const [code, [mutant, pairedControl]] of controls) {
      expect((await resolveFixture(pairedControl)).status, `${code} paired control`).toBe("resolved");
      expectUnknown(await resolveFixture(mutant), code);
    }

    for (const code of DISPATCH_BRIEF_COLLECTION_CODES) {
      const result = await resolveFixture(
        fixtureFor([], { authority: { complete: false, reasonCodes: [code], issue: null, comments: [] } }),
      );
      expectUnknown(result, code);
    }

    const internal = await resolveFixture(
      fixtureFor([], {
        seams: {
          emitManifest: () => {
            throw new Error("fault");
          },
        },
      }),
    );
    expectUnknown(internal, "INTERNAL_FAILURE");
    expect(DISPATCH_BRIEF_REFUSAL_CODES.some((code) => code.startsWith("CANONICAL_"))).toBe(false);
  });

  it("retired refusal codes do not reappear", () => {
    const retired = [
      ["PART", "BOUNDARY", "STRADDLES", "LINE"].join("_"),
      ["PART", "FENCE", "UNBALANCED"].join("_"),
      ["SEGMENT", "PARSE", "DIVERGES"].join("_"),
    ];
    const diff = execFileSync(
      "git",
      ["diff", "--", "scripts/issue-dispatch-brief.mjs", "scripts/issue-dispatch-brief.test.mjs"],
      {
        encoding: "utf8",
      },
    );
    for (const code of retired) expect(diff).not.toContain(code);
  });

  it("resolver omits unmanifested comments on every return path", async () => {
    const resolved = await resolveFixture(fixtureFor([]));
    expect(Object.keys(resolved).sort()).toEqual([
      "assembledBytes",
      "assembledSha256",
      "bodySha256",
      "issueNodeId",
      "manifestSha256",
      "number",
      "parts",
      "partsDigest",
      "repository",
      "status",
    ]);
    const refused = await resolveFixture(
      fixtureFor([], {
        authority: { complete: false, reasonCodes: ["COLLECTION_BOUNDED"], issue: null, comments: [] },
      }),
    );
    expect(Object.keys(refused).sort()).toEqual(["details", "reasonCode", "status"]);
    expect(refused).not.toHaveProperty("assembledBytes");
  });
});
