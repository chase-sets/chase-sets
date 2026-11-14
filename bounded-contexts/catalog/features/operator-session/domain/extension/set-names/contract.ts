// Closed grant-post contract for operator-extension TCGplayer set names. The grammar comes from the
// bound SetNames probe report and its host findings: local `YYYY-MM-DDTHH:mm:ss` release dates and
// Pokemon set names carrying Cc/Cf/Co/Cn characters are real provider data, so both pass unchanged.
// This module is shared with the browser extension and must stay free of server imports.

export const tcgplayerSetNameObservationAuthority = Object.freeze({
  reportSha256: "973c4a89869c9f14b3ea67acae9210123a235d7ff6c1f5040d0aa9b229cd989b",
  buildCommit: "042e14c3151e5cf7da6c3d3da63ebfacd93aed10",
  // The Lorcana product-line id stays unresolved until a supplemental probe report binds it.
  lorcanaSupplementalReportSha256: null,
});

export const tcgplayerSetNameObservationLimits = Object.freeze({
  contractVersion: 1,
  maxPostBytes: 2 * 1024 * 1024,
  maxSets: 5_000,
  maxIdentifier: 2_147_483_647,
  maxNameScalars: 128,
  maxUrlNameScalars: 160,
  maxAbbreviationScalars: 32,
});

export type TcgplayerSetNameUnit = Readonly<{ unitKey: string; productLineId: number | null }>;

// One unit per TCGplayer product line. Lorcana keeps its unit with no product-line id: neither the
// fixture id 82 nor the candidate 71 is bound, so a Lorcana post is refused as unsupported.
export const tcgplayerSetNameUnits: readonly TcgplayerSetNameUnit[] = Object.freeze([
  Object.freeze({ unitKey: "tcgplayer:mtg:single-card:source-observation-import", productLineId: 1 }),
  Object.freeze({ unitKey: "tcgplayer:yugioh:single-card:source-observation-import", productLineId: 2 }),
  Object.freeze({ unitKey: "tcgplayer:pokemon:single-card:source-observation-import", productLineId: 3 }),
  Object.freeze({ unitKey: "tcgplayer:one-piece:single-card:source-observation-import", productLineId: 68 }),
  Object.freeze({ unitKey: "tcgplayer:lorcana:single-card:source-observation-import", productLineId: null }),
]);

export const tcgplayerSetNameProductLineIds: readonly number[] = Object.freeze(
  tcgplayerSetNameUnits.flatMap((unit) => (unit.productLineId === null ? [] : [unit.productLineId])),
);

export function tcgplayerSetNameUnitKeyForProductLineId(productLineId: number): string | null {
  return tcgplayerSetNameUnits.find((unit) => unit.productLineId === productLineId)?.unitKey ?? null;
}

export type TcgplayerSetNameEntry = Readonly<{
  setNameId: number;
  categoryId: number;
  name: string;
  cleanSetName: string;
  urlName: string;
  abbreviation: string | null;
  releaseDate: string | null;
  isSupplemental: boolean;
  active: boolean;
}>;

export type TcgplayerSetNameObservationPost = Readonly<{
  contractVersion: 1;
  productLineId: number;
  observedAt: string;
  sets: readonly TcgplayerSetNameEntry[];
}>;

export type TcgplayerSetNameObservationRefusal = "invalid-body" | "product-line-unsupported";

export type TcgplayerSetNameObservationParse =
  | Readonly<{ ok: true; post: TcgplayerSetNameObservationPost; unitKey: string }>
  | Readonly<{ ok: false; code: TcgplayerSetNameObservationRefusal }>;

const postKeys = ["contractVersion", "productLineId", "observedAt", "sets"] as const;
const entryKeys = [
  "setNameId",
  "categoryId",
  "name",
  "cleanSetName",
  "urlName",
  "abbreviation",
  "releaseDate",
  "isSupplemental",
  "active",
] as const;

const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;
const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const offsetInstantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const loneSurrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function parseTcgplayerSetNameObservationPost(value: unknown): TcgplayerSetNameObservationParse {
  const post = readPost(value);
  if (!post) return { ok: false, code: "invalid-body" };
  const unitKey = tcgplayerSetNameUnitKeyForProductLineId(post.productLineId);
  if (!unitKey) return { ok: false, code: "product-line-unsupported" };
  return { ok: true, post, unitKey };
}

function readPost(value: unknown): TcgplayerSetNameObservationPost | null {
  if (!isClosedRecord(value, postKeys)) return null;
  if (value.contractVersion !== tcgplayerSetNameObservationLimits.contractVersion) return null;
  const productLineId = value.productLineId;
  if (!isIdentifier(productLineId)) return null;
  const observedAt = value.observedAt;
  if (typeof observedAt !== "string" || !isMillisecondInstant(observedAt)) return null;
  const sets = value.sets;
  if (!Array.isArray(sets) || sets.length < 1 || sets.length > tcgplayerSetNameObservationLimits.maxSets) return null;

  const entries: TcgplayerSetNameEntry[] = [];
  const setNameIds = new Set<number>();
  const cleanSetNames = new Set<string>();
  for (const candidate of sets) {
    const entry = readEntry(candidate, productLineId);
    if (!entry || setNameIds.has(entry.setNameId) || cleanSetNames.has(entry.cleanSetName)) return null;
    setNameIds.add(entry.setNameId);
    cleanSetNames.add(entry.cleanSetName);
    entries.push(entry);
  }
  return Object.freeze({
    contractVersion: 1,
    productLineId,
    observedAt,
    sets: Object.freeze(entries),
  });
}

function readEntry(value: unknown, productLineId: number): TcgplayerSetNameEntry | null {
  if (!isClosedRecord(value, entryKeys)) return null;
  const limits = tcgplayerSetNameObservationLimits;
  const { setNameId, categoryId, name, cleanSetName, urlName, abbreviation, releaseDate, isSupplemental, active } =
    value;
  if (!isIdentifier(setNameId) || categoryId !== productLineId) return null;
  if (!isBoundedText(name, 1, limits.maxNameScalars)) return null;
  if (!isBoundedText(cleanSetName, 1, limits.maxNameScalars)) return null;
  if (!isBoundedText(urlName, 1, limits.maxUrlNameScalars)) return null;
  if (abbreviation !== null && !isBoundedText(abbreviation, 0, limits.maxAbbreviationScalars)) return null;
  if (releaseDate !== null && !isReleaseDate(releaseDate)) return null;
  if (typeof isSupplemental !== "boolean" || typeof active !== "boolean") return null;
  return Object.freeze({
    setNameId,
    categoryId: productLineId,
    name,
    cleanSetName,
    urlName,
    abbreviation,
    releaseDate,
    isSupplemental,
    active,
  });
}

function isClosedRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): value is Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isIdentifier(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= tcgplayerSetNameObservationLimits.maxIdentifier
  );
}

// Provider text is opaque: only U+0000 and unpaired surrogates are refused because the database
// cannot store them. Length counts Unicode scalar values.
function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string" || value.includes("\u0000") || loneSurrogatePattern.test(value)) return false;
  let scalars = 0;
  for (const _scalar of value) {
    scalars += 1;
    if (scalars > maximum) return false;
  }
  return scalars >= minimum;
}

function isReleaseDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const dateOnly = dateOnlyPattern.exec(value);
  if (dateOnly) return isCalendarDate(dateOnly[1]!, dateOnly[2]!, dateOnly[3]!);
  // A local date-time names no offset, so it is kept as text and never converted to an Instant.
  const local = localDateTimePattern.exec(value);
  if (local) return isCalendarDate(local[1]!, local[2]!, local[3]!) && isClockTime(local[4]!, local[5]!, local[6]!);
  const instant = offsetInstantPattern.exec(value);
  if (!instant) return false;
  if (instant[7] !== undefined && (Number(instant[7]) > 23 || Number(instant[8]) > 59)) return false;
  return isCalendarDate(instant[1]!, instant[2]!, instant[3]!) && isClockTime(instant[4]!, instant[5]!, instant[6]!);
}

function isMillisecondInstant(value: string): boolean {
  const match = instantPattern.exec(value);
  return (
    match !== null && isCalendarDate(match[1]!, match[2]!, match[3]!) && isClockTime(match[4]!, match[5]!, match[6]!)
  );
}

function isCalendarDate(yearText: string, monthText: string, dayText: string): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= daysInMonth;
}

function isClockTime(hourText: string, minuteText: string, secondText: string): boolean {
  return Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59;
}
