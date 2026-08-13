import { types } from "node:util";
import { emitRecord, emitRecordArray, sha256 } from "./canonical-record.mjs";
import { COMMENT_MARKER, collectIssueAuthority, scanIssueFormStructure } from "./issue-readiness.mjs";

export const DISPATCH_BRIEF_SCHEMA_VERSION = "dispatch-brief/v2";
export const DISPATCH_BRIEF_MANIFEST_START = "<!-- chase-sets:dispatch-brief-manifest:v2:start -->";
export const DISPATCH_BRIEF_MANIFEST_END = "<!-- chase-sets:dispatch-brief-manifest:v2:end -->";

export const DISPATCH_BRIEF_PART_FIELDS = Object.freeze([
  Object.freeze({ key: "order", shape: "integer" }),
  Object.freeze({ key: "databaseId", shape: "integer" }),
  Object.freeze({ key: "nodeId", shape: "string" }),
  Object.freeze({ key: "issueUrl", shape: "string" }),
  Object.freeze({ key: "authorLogin", shape: "string" }),
  Object.freeze({ key: "createdAt", shape: "string" }),
  Object.freeze({ key: "updatedAt", shape: "string" }),
  Object.freeze({ key: "utf8Bytes", shape: "integer" }),
  Object.freeze({ key: "sha256", shape: "string" }),
]);

export const DISPATCH_BRIEF_MANIFEST_FIELDS = Object.freeze([
  Object.freeze({ key: "schemaVersion", shape: "string" }),
  Object.freeze({
    key: "issue",
    shape: "record",
    fields: Object.freeze([
      Object.freeze({ key: "repository", shape: "string" }),
      Object.freeze({ key: "number", shape: "integer" }),
      Object.freeze({ key: "nodeId", shape: "string" }),
    ]),
  }),
  Object.freeze({ key: "parts", shape: "recordArray", fields: DISPATCH_BRIEF_PART_FIELDS }),
  Object.freeze({ key: "partsDigest", shape: "string" }),
]);

export const DISPATCH_BRIEF_GUARD_CODES = Object.freeze([
  "MANIFEST_MARKER_INVALID",
  "MANIFEST_MARKER_FENCED",
  "MANIFEST_REGION_SHAPE_INVALID",
  "MANIFEST_NOT_CANONICAL",
  "MANIFEST_KEY_MISSING",
  "MANIFEST_KEY_UNKNOWN",
  "MANIFEST_TYPE_INVALID",
  "MANIFEST_DOMAIN_INVALID",
  "MANIFEST_NUMBER_TOKEN_INVALID",
  "MANIFEST_PARTS_DIGEST_MISMATCH",
  "PART_DUPLICATE",
  "PART_NOT_FOUND",
  "PART_INACCESSIBLE",
  "PART_READ_FAILED",
  "PART_CROSS_REPOSITORY",
  "PART_CROSS_ISSUE",
  "PART_IDENTITY_DRIFT",
  "PART_OWNER_BINDING_DISAGREES",
  "PART_EMPTY",
  "PART_TOO_LARGE",
  "PART_IS_READINESS_RECEIPT",
  "PART_NESTED_MANIFEST",
  "SEGMENT_FENCE_UNCLOSED",
  "ASSEMBLED_FORM_INVALID",
  "ASSEMBLED_HEADING_COUNT_INVALID",
  "ASSEMBLED_TOO_LARGE",
]);

export const DISPATCH_BRIEF_COLLECTION_CODES = Object.freeze([
  "COLLECTION_BOUNDED",
  "COLLECTION_READ_FAILED",
  "COLLECTION_PAGE_SHAPE_INVALID",
  "PAGINATION_NEXT_UNSAFE",
  "COMMENT_SHAPE_INVALID",
  "COMMENT_COUNT_MISMATCH",
  "COMMENT_DUPLICATE",
  "INDEPENDENT_TOTAL_MISMATCH",
]);

export const DISPATCH_BRIEF_REFUSAL_CODES = Object.freeze([
  ...DISPATCH_BRIEF_GUARD_CODES,
  ...DISPATCH_BRIEF_COLLECTION_CODES,
  "INTERNAL_FAILURE",
]);

const API_ORIGIN = "https://api.github.com";
const MAX_PARTS = 2;
const MAX_PART_BYTES = 60_000;
const MAX_ASSEMBLED_BYTES = 180_000;
const REQUIRED_HEADING_COUNT = 11;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const ISSUE_NODE_PATTERN = /^I_[A-Za-z0-9_-]+$/u;
const COMMENT_NODE_PATTERN = /^IC_[A-Za-z0-9_-]+$/u;
const LOGIN_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const SECOND_PRECISION_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REFUSAL_CODE_SET = new Set(DISPATCH_BRIEF_REFUSAL_CODES);
const COLLECTION_CODE_SET = new Set(DISPATCH_BRIEF_COLLECTION_CODES);

const COMMENT_OWNER_QUERY = `
query DispatchBriefCommentOwner($id: ID!) {
  node(id: $id) {
    ... on IssueComment {
      id
      databaseId
      author { login }
      issue { number repository { nameWithOwner } }
    }
  }
}`;

class DispatchBriefRefusal extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "DispatchBriefRefusal";
    this.code = code;
    this.details = details;
  }
}

function refuse(code, details) {
  if (!REFUSAL_CODE_SET.has(code)) throw new Error(`Undeclared dispatch-brief refusal: ${code}`);
  throw new DispatchBriefRefusal(code, details);
}

function unknown(error) {
  if (error instanceof DispatchBriefRefusal) {
    return { status: "unknown", reasonCode: error.code, details: error.details };
  }
  return { status: "unknown", reasonCode: "INTERNAL_FAILURE", details: {} };
}

function dependencies(seams = {}) {
  return {
    collectAuthority: seams.collectAuthority ?? collectIssueAuthority,
    emitManifest: seams.emitManifest ?? emitRecord,
    emitParts: seams.emitParts ?? emitRecordArray,
    digest: seams.digest ?? sha256,
    disabledGuards: new Set(seams.disabledGuards ?? []),
  };
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value, fields, position) {
  if (!isPlainRecord(value)) refuse("MANIFEST_TYPE_INVALID", { position });
  const expected = fields.map(({ key }) => key);
  const actual = Object.keys(value);
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) refuse("MANIFEST_KEY_MISSING", { position: `${position}.${missing}` });
  const extra = actual.find((key) => !expected.includes(key));
  if (extra !== undefined) refuse("MANIFEST_KEY_UNKNOWN", { position: `${position}.${extra}` });
  if (actual.length !== expected.length) refuse("MANIFEST_KEY_UNKNOWN", { position });

  for (const field of fields) {
    const fieldPosition = `${position}.${field.key}`;
    const entry = value[field.key];
    switch (field.shape) {
      case "string":
        if (typeof entry !== "string") refuse("MANIFEST_TYPE_INVALID", { position: fieldPosition });
        break;
      case "integer":
        if (typeof entry !== "number" || !Number.isSafeInteger(entry)) {
          refuse("MANIFEST_TYPE_INVALID", { position: fieldPosition });
        }
        break;
      case "record":
        exactRecord(entry, field.fields, fieldPosition);
        break;
      case "recordArray":
        if (!Array.isArray(entry)) refuse("MANIFEST_TYPE_INVALID", { position: fieldPosition });
        for (const [index, item] of entry.entries()) exactRecord(item, field.fields, `${fieldPosition}[${index}]`);
        break;
      default:
        throw new Error(`Unsupported manifest field shape: ${field.shape}`);
    }
  }
}

function validSecondPrecisionInstant(value) {
  if (!SECOND_PRECISION_UTC_PATTERN.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value.replace(/Z$/u, ".000Z");
}

function canonicalIssueUrl(repository, number) {
  return `${API_ORIGIN}/repos/${repository}/issues/${number}`;
}

function validateDomains(manifest, { repository, number, issueNodeId }) {
  if (
    manifest.schemaVersion !== DISPATCH_BRIEF_SCHEMA_VERSION ||
    !REPOSITORY_PATTERN.test(manifest.issue.repository) ||
    manifest.issue.repository !== repository ||
    manifest.issue.number < 1 ||
    manifest.issue.number > 2_147_483_647 ||
    manifest.issue.number !== number ||
    !ISSUE_NODE_PATTERN.test(manifest.issue.nodeId) ||
    manifest.issue.nodeId !== issueNodeId ||
    manifest.parts.length > MAX_PARTS ||
    !SHA256_PATTERN.test(manifest.partsDigest)
  ) {
    refuse("MANIFEST_DOMAIN_INVALID");
  }

  const expectedIssueUrl = canonicalIssueUrl(repository, number);
  for (const [index, part] of manifest.parts.entries()) {
    if (
      part.order !== index + 1 ||
      part.databaseId < 1 ||
      part.databaseId > Number.MAX_SAFE_INTEGER ||
      !COMMENT_NODE_PATTERN.test(part.nodeId) ||
      part.issueUrl !== expectedIssueUrl ||
      !LOGIN_PATTERN.test(part.authorLogin) ||
      !validSecondPrecisionInstant(part.createdAt) ||
      !validSecondPrecisionInstant(part.updatedAt) ||
      Date.parse(part.createdAt) > Date.parse(part.updatedAt) ||
      part.utf8Bytes < 1 ||
      part.utf8Bytes > MAX_PART_BYTES ||
      !SHA256_PATTERN.test(part.sha256)
    ) {
      refuse("MANIFEST_DOMAIN_INVALID", { position: `root.parts[${index}]` });
    }
  }
}

function numericTokensAreMinimal(text) {
  let inString = false;
  let escaped = false;
  let previousSignificant = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (/\s/u.test(character)) continue;
    if (previousSignificant === ":" || previousSignificant === "[" || previousSignificant === ",") {
      if (/[+\d-]/u.test(character)) {
        let end = index + 1;
        while (end < text.length && !/[\s,\]}]/u.test(text[end])) end += 1;
        const token = text.slice(index, end);
        if (!/^-?(?:0|[1-9]\d*)$/u.test(token) || token === "-0") return false;
        try {
          const value = BigInt(token);
          if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return false;
        } catch {
          return false;
        }
        index = end - 1;
        previousSignificant = "0";
        continue;
      }
    }
    previousSignificant = character;
  }
  return true;
}

function occurrences(bytes, needle) {
  const offsets = [];
  let offset = 0;
  while (offset <= bytes.length - needle.length) {
    const found = bytes.indexOf(needle, offset);
    if (found === -1) break;
    offsets.push(found);
    offset = found + 1;
  }
  return offsets;
}

function completeLine(bytes, offset, markerBytes) {
  return (offset === 0 || bytes[offset - 1] === 0x0a) && bytes[offset + markerBytes.length] === 0x0a;
}

function fencedMarkerOffset(body, completeLineOffsets) {
  const structure = scanIssueFormStructure(body);
  let fence = null;
  const offsetSet = new Set(completeLineOffsets);
  for (const line of structure.lines) {
    if (offsetSet.has(line.startOffset) && fence !== null) return line.startOffset;
    if (line.enteringFence !== null) fence = line.enteringFence;
    if (line.leavingFence !== null) fence = null;
  }
  return null;
}

function locateManifest(body, deps) {
  const bodyBytes = Buffer.from(body, "utf8");
  const startBytes = Buffer.from(DISPATCH_BRIEF_MANIFEST_START, "ascii");
  const endBytes = Buffer.from(DISPATCH_BRIEF_MANIFEST_END, "ascii");
  const starts = occurrences(bodyBytes, startBytes);
  const ends = occurrences(bodyBytes, endBytes);
  if (starts.length === 0 && ends.length === 0) return { bodyBytes, manifestBytes: null };

  const completeStarts = starts.filter((offset) => completeLine(bodyBytes, offset, startBytes));
  const completeEnds = ends.filter((offset) => completeLine(bodyBytes, offset, endBytes));
  const fenced = fencedMarkerOffset(
    body,
    [...completeStarts, ...completeEnds].sort((left, right) => left - right),
  );
  if (fenced !== null && !deps.disabledGuards.has("MANIFEST_MARKER_FENCED")) {
    refuse("MANIFEST_MARKER_FENCED", { offset: fenced });
  }
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    completeStarts.length !== 1 ||
    completeEnds.length !== 1 ||
    ends[0] <= starts[0] + startBytes.length
  ) {
    refuse("MANIFEST_MARKER_INVALID");
  }

  const regionStart = starts[0] + startBytes.length + 1;
  const regionEnd = ends[0];
  const region = bodyBytes.subarray(regionStart, regionEnd);
  if (region.length < 2 || region[region.length - 1] !== 0x0a || region.subarray(0, -1).includes(0x0a)) {
    refuse("MANIFEST_REGION_SHAPE_INVALID");
  }
  return { bodyBytes, manifestBytes: region.subarray(0, -1) };
}

function emitManifestBytes(value, deps) {
  try {
    return deps.emitManifest(value, DISPATCH_BRIEF_MANIFEST_FIELDS);
  } catch {
    refuse("INTERNAL_FAILURE");
  }
}

function emitPartsBytes(value, deps) {
  try {
    return deps.emitParts(value, DISPATCH_BRIEF_PART_FIELDS);
  } catch {
    refuse("INTERNAL_FAILURE");
  }
}

function digest(bytes, deps) {
  try {
    return deps.digest(bytes);
  } catch {
    refuse("INTERNAL_FAILURE");
  }
}

function parseManifest(manifestBytes, identity, deps) {
  const text = manifestBytes.toString("utf8");
  if (!numericTokensAreMinimal(text)) refuse("MANIFEST_NUMBER_TOKEN_INVALID");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    refuse("MANIFEST_NOT_CANONICAL");
  }
  exactRecord(manifest, DISPATCH_BRIEF_MANIFEST_FIELDS, "root");
  validateDomains(manifest, identity);
  const canonicalBytes = emitManifestBytes(manifest, deps);
  if (!canonicalBytes.equals(manifestBytes)) refuse("MANIFEST_NOT_CANONICAL");

  const databaseIds = manifest.parts.map(({ databaseId }) => databaseId);
  const nodeIds = manifest.parts.map(({ nodeId }) => nodeId);
  if (new Set(databaseIds).size !== databaseIds.length || new Set(nodeIds).size !== nodeIds.length) {
    refuse("PART_DUPLICATE");
  }
  const partsBytes = emitPartsBytes(manifest.parts, deps);
  if (digest(partsBytes, deps) !== manifest.partsDigest) refuse("MANIFEST_PARTS_DIGEST_MISMATCH");
  return manifest;
}

function responseHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

async function responseJson(response, code) {
  if (!response || response.status !== 200 || !response.ok) refuse(code, { status: response?.status ?? null });
  try {
    return await response.json();
  } catch {
    refuse(code);
  }
}

function normalizeLogin(login) {
  return typeof login === "string" && login.endsWith("[bot]") ? login.slice(0, -5) : login;
}

function parseOwnerUrl(value) {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/u.exec(value);
  if (!match) return null;
  return { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

async function readPart(part, { repository, number, token, client, deps }) {
  const individualUrl = `${API_ORIGIN}/repos/${repository}/issues/comments/${part.databaseId}`;
  const response = await client(individualUrl, { headers: responseHeaders(token) });
  if (response?.status === 404 || response?.status === 410) {
    refuse("PART_INACCESSIBLE", { databaseId: part.databaseId, status: response.status });
  }
  const raw = await responseJson(response, "PART_READ_FAILED");
  const owner = parseOwnerUrl(raw?.issue_url);
  if (owner !== null && owner.repository !== repository) {
    refuse("PART_CROSS_REPOSITORY", { databaseId: part.databaseId });
  }
  if (owner !== null && owner.repository === repository && owner.number !== number) {
    refuse("PART_CROSS_ISSUE", { databaseId: part.databaseId });
  }

  const body = typeof raw?.body === "string" ? raw.body : null;
  if (body === null || owner === null || raw.issue_url !== part.issueUrl) {
    refuse("PART_IDENTITY_DRIFT", { databaseId: part.databaseId });
  }
  const bodyBytes = Buffer.from(body, "utf8");
  if (bodyBytes.length === 0) refuse("PART_EMPTY", { databaseId: part.databaseId });
  if (bodyBytes.length > MAX_PART_BYTES) refuse("PART_TOO_LARGE", { databaseId: part.databaseId });
  if (body.includes(COMMENT_MARKER)) refuse("PART_IS_READINESS_RECEIPT", { databaseId: part.databaseId });
  if (body.includes(DISPATCH_BRIEF_MANIFEST_START)) {
    refuse("PART_NESTED_MANIFEST", { databaseId: part.databaseId });
  }
  if (
    raw.id !== part.databaseId ||
    raw.node_id !== part.nodeId ||
    normalizeLogin(raw.user?.login) !== part.authorLogin ||
    raw.created_at !== part.createdAt ||
    raw.updated_at !== part.updatedAt ||
    bodyBytes.length !== part.utf8Bytes ||
    digest(bodyBytes, deps) !== part.sha256
  ) {
    refuse("PART_IDENTITY_DRIFT", { databaseId: part.databaseId });
  }

  const graphResponse = await client(`${API_ORIGIN}/graphql`, {
    method: "POST",
    headers: { ...responseHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ query: COMMENT_OWNER_QUERY, variables: { id: part.nodeId } }),
  });
  const graph = await responseJson(graphResponse, "PART_READ_FAILED");
  const node = graph?.data?.node;
  if (
    Array.isArray(graph?.errors) ||
    !node ||
    node.id !== part.nodeId ||
    node.databaseId !== part.databaseId ||
    node.author?.login !== part.authorLogin ||
    node.issue?.number !== number ||
    node.issue?.repository?.nameWithOwner !== repository ||
    node.issue.number !== owner.number ||
    node.issue.repository.nameWithOwner !== owner.repository
  ) {
    refuse("PART_OWNER_BINDING_DISAGREES", { databaseId: part.databaseId });
  }
  return { identity: { ...part }, body, bodyBytes };
}

function assemble({ body, bodyBytes, manifestBytes, parts, deps }) {
  const segments = [bodyBytes, ...parts.map(({ bodyBytes: bytes }) => bytes)];
  const assembledBytes = Buffer.concat(
    segments.flatMap((bytes, index) => (index === 0 ? [bytes] : [Buffer.of(0x0a), bytes])),
  );
  if (assembledBytes.length > MAX_ASSEMBLED_BYTES) refuse("ASSEMBLED_TOO_LARGE");

  for (const [index, segment] of [body, ...parts.map(({ body: partBody }) => partBody)].entries()) {
    if (scanIssueFormStructure(segment).terminalFence !== null) {
      refuse("SEGMENT_FENCE_UNCLOSED", { segmentIndex: index });
    }
  }
  const assembled = assembledBytes.toString("utf8");
  const structure = scanIssueFormStructure(assembled);
  if (structure.terminalFence !== null || structure.reasonCodes.length > 0) {
    refuse("ASSEMBLED_FORM_INVALID", { scannerReasonCodes: structure.reasonCodes });
  }
  if (structure.headings.filter(({ accepted }) => accepted).length !== REQUIRED_HEADING_COUNT) {
    refuse("ASSEMBLED_HEADING_COUNT_INVALID");
  }

  return {
    status: "resolved",
    bodySha256: digest(bodyBytes, deps),
    manifestSha256: manifestBytes === null ? null : digest(manifestBytes, deps),
    assembledSha256: digest(assembledBytes, deps),
    assembledBytes,
  };
}

export function emitDispatchBriefManifest(manifest, { seams } = {}) {
  return emitManifestBytes(manifest, dependencies(seams));
}

export function emitDispatchBriefParts(parts, { seams } = {}) {
  return emitPartsBytes(parts, dependencies(seams));
}

export async function resolveIssueDispatchBrief({ repository, number, token, client = globalThis.fetch, seams } = {}) {
  const deps = dependencies(seams);
  try {
    const authority = await deps.collectAuthority({ repository, number, token, client });
    if (!authority?.complete) {
      const inherited = authority?.reasonCodes?.find((code) => COLLECTION_CODE_SET.has(code));
      refuse(inherited ?? "INTERNAL_FAILURE");
    }
    const body = authority.issue?.body;
    const issueNodeId = authority.issue?.nodeId;
    if (typeof body !== "string" || typeof issueNodeId !== "string") refuse("INTERNAL_FAILURE");
    const located = locateManifest(body, deps);
    const identity = { repository, number, issueNodeId };
    const manifest = located.manifestBytes === null ? null : parseManifest(located.manifestBytes, identity, deps);
    const manifestedParts = manifest?.parts ?? [];
    const collectedIds = new Set(authority.comments.map(({ id }) => id));
    const parts = [];
    for (const part of manifestedParts) {
      if (!collectedIds.has(part.databaseId)) refuse("PART_NOT_FOUND", { databaseId: part.databaseId });
      parts.push(await readPart(part, { repository, number, token, client, deps }));
    }
    const result = assemble({ body, bodyBytes: located.bodyBytes, manifestBytes: located.manifestBytes, parts, deps });
    return {
      ...result,
      repository,
      number,
      issueNodeId,
      partsDigest: manifest?.partsDigest ?? digest(emitPartsBytes([], deps), deps),
      parts: parts.map(({ identity: partIdentity }) => partIdentity),
    };
  } catch (error) {
    return unknown(error);
  }
}
