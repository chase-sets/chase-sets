import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMISSION_PATH_SYNTAX_OUTCOMES,
  ADMISSION_PATH_SYNTAX_RULE_ORDER,
  validateCallInputs,
} from "./admission-path-syntax.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "admission-path-syntax/v1";
const VALID_BASE = "record-directory";
const VALID_PATH = "a/b";
const EXPECTED_OUTCOMES = Object.freeze(["accepted", "input-not-a-string", "path-syntax-invalid", "options-invalid"]);
const EXPECTED_RULE_ORDER = Object.freeze([
  "length",
  "empty-segment",
  "segment-charset",
  "dot-segment",
  "dots-only-segment",
  "reserved-device-stem",
  "trailing-dot-segment",
]);
const VALID_FILESYSTEM = Object.freeze({
  lstat: () => undefined,
  realpath: () => undefined,
});
const VALID_OPTIONS = Object.freeze({ filesystem: VALID_FILESYSTEM });

const REFERENCE_PREDICATES = Object.freeze({
  length: (value) => value.length < 1 || value.length > 300,
  "empty-segment": (value) => value.split("/").some((segment) => segment.length === 0),
  "segment-charset": (value) =>
    value.split("/").some((segment) => segment.length > 0 && !/^[A-Za-z0-9._-]+$/.test(segment)),
  "dot-segment": (value) => value.split("/").some((segment) => segment === "." || segment === ".."),
  "dots-only-segment": (value) => value.split("/").some((segment) => segment.length > 0 && /^\.+$/.test(segment)),
  "reserved-device-stem": (value) =>
    value.split("/").some((segment) => /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment.split(".", 1)[0])),
  "trailing-dot-segment": (value) => value.split("/").some((segment) => segment.length > 0 && segment.endsWith(".")),
});

const OVERLAP_ROWS = Object.freeze([
  Object.freeze({ input: "", matched: Object.freeze(["length", "empty-segment"]), selected: "length" }),
  Object.freeze({
    input: ".",
    matched: Object.freeze(["dot-segment", "dots-only-segment", "trailing-dot-segment"]),
    selected: "dot-segment",
  }),
  Object.freeze({
    input: "..",
    matched: Object.freeze(["dot-segment", "dots-only-segment", "trailing-dot-segment"]),
    selected: "dot-segment",
  }),
  Object.freeze({
    input: "...",
    matched: Object.freeze(["dots-only-segment", "trailing-dot-segment"]),
    selected: "dots-only-segment",
  }),
  Object.freeze({
    input: "./a",
    matched: Object.freeze(["dot-segment", "dots-only-segment", "trailing-dot-segment"]),
    selected: "dot-segment",
  }),
  Object.freeze({
    input: "../a",
    matched: Object.freeze(["dot-segment", "dots-only-segment", "trailing-dot-segment"]),
    selected: "dot-segment",
  }),
  Object.freeze({
    input: "a/./b",
    matched: Object.freeze(["dot-segment", "dots-only-segment", "trailing-dot-segment"]),
    selected: "dot-segment",
  }),
  Object.freeze({
    input: "a/../b",
    matched: Object.freeze(["dot-segment", "dots-only-segment", "trailing-dot-segment"]),
    selected: "dot-segment",
  }),
  Object.freeze({
    input: "NUL.",
    matched: Object.freeze(["reserved-device-stem", "trailing-dot-segment"]),
    selected: "reserved-device-stem",
  }),
  Object.freeze({
    input: "AUX.",
    matched: Object.freeze(["reserved-device-stem", "trailing-dot-segment"]),
    selected: "reserved-device-stem",
  }),
  Object.freeze({
    input: "a./NUL",
    matched: Object.freeze(["reserved-device-stem", "trailing-dot-segment"]),
    selected: "reserved-device-stem",
  }),
  Object.freeze({
    input: "a b/NUL",
    matched: Object.freeze(["segment-charset", "reserved-device-stem"]),
    selected: "segment-charset",
  }),
]);

const REJECTION_PARTITION = Object.freeze([
  Object.freeze({ rule: "length", inputs: Object.freeze(["", "a".repeat(301)]) }),
  Object.freeze({ rule: "empty-segment", inputs: Object.freeze(["/a", "a/", "a//b", "//a"]) }),
  Object.freeze({
    rule: "segment-charset",
    inputs: Object.freeze(["C:\\root\\file", "C:/root", "a\\b", "a%2Fb", "a\u0001b", "café", " a", "a "]),
  }),
  Object.freeze({ rule: "dot-segment", inputs: Object.freeze([".", "..", "a/./b", "a/../b"]) }),
  Object.freeze({ rule: "dots-only-segment", inputs: Object.freeze(["...", "a/..../b"]) }),
  Object.freeze({
    rule: "reserved-device-stem",
    inputs: Object.freeze(["NUL", "CON", "AUX", "NUL.txt", "COM9.txt", "lPt1.log"]),
  }),
  Object.freeze({ rule: "trailing-dot-segment", inputs: Object.freeze(["ordinary."]) }),
]);

const POSITIVE_PARTITION = Object.freeze([
  Object.freeze({ input: "a/b/c", segments: Object.freeze(["a", "b", "c"]) }),
  Object.freeze({ input: "ok_file-1.txt", segments: Object.freeze(["ok_file-1.txt"]) }),
  Object.freeze({ input: "a".repeat(300), segments: Object.freeze(["a".repeat(300)]) }),
  Object.freeze({ input: "a.b_c-d", segments: Object.freeze(["a.b_c-d"]) }),
]);

const PLATFORM_CORPUS = Object.freeze([
  ...POSITIVE_PARTITION.map(({ input }) => Object.freeze({ input, outcome: "accepted" })),
  ...REJECTION_PARTITION.flatMap(({ rule, inputs }) =>
    inputs.map((input) => Object.freeze({ input, outcome: "path-syntax-invalid", rule })),
  ),
]);

function matchingRules(input, order = EXPECTED_RULE_ORDER, predicates = REFERENCE_PREDICATES) {
  return order.filter((rule) => predicates[rule]?.(input) === true);
}

function grammarEvaluator(input, order = EXPECTED_RULE_ORDER, predicates = REFERENCE_PREDICATES) {
  const rule = order.find((candidate) => predicates[candidate]?.(input) ?? true);
  return rule === undefined
    ? Object.freeze({ outcome: "accepted" })
    : Object.freeze({ outcome: "path-syntax-invalid", rule });
}

function optionalChainingMutant(options) {
  const filesystem = options?.filesystem ?? null;
  if (
    filesystem !== null &&
    (typeof filesystem !== "object" ||
      typeof filesystem.lstat !== "function" ||
      typeof filesystem.realpath !== "function")
  ) {
    return "options-invalid";
  }
  return "accepted";
}

function ignoredNonObjectOptionsMutant(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return "accepted";
  }
  return optionalChainingMutant(options);
}

function grammarBeforeOptionsMutant(baseDirectory, relativePath, options) {
  if (typeof baseDirectory !== "string" || typeof relativePath !== "string") {
    return "input-not-a-string";
  }
  const grammar = grammarEvaluator(relativePath);
  if (grammar.outcome !== "accepted") {
    return grammar.outcome;
  }
  return optionalChainingMutant(options);
}

function assertClosedRecord(record) {
  const expectedKeys = {
    accepted: ["filesystem", "outcome", "segments", "version"],
    "input-not-a-string": ["outcome", "version"],
    "path-syntax-invalid": ["outcome", "rule", "version"],
    "options-invalid": ["outcome", "version"],
  };
  expect(Object.keys(record).sort()).toEqual(expectedKeys[record.outcome]);
  expect(record.version).toBe(VERSION);
  expect(EXPECTED_OUTCOMES).toContain(record.outcome);

  if (record.outcome === "accepted") {
    expect(Array.isArray(record.segments)).toBe(true);
    expect(Object.isFrozen(record.segments)).toBe(true);
    expect(record.segments.every((segment) => typeof segment === "string")).toBe(true);
    expect(Object.keys(record.segments)).toEqual(record.segments.map((_segment, index) => String(index)));
    expect(record.filesystem === null || typeof record.filesystem === "object").toBe(true);
  }
  if (record.outcome === "path-syntax-invalid") {
    expect(EXPECTED_RULE_ORDER).toContain(record.rule);
  }
}

describe("admission-path-syntax/v1 published grammar", () => {
  it("publishes the exact closed outcomes and frozen seven-token total order", () => {
    expect(ADMISSION_PATH_SYNTAX_OUTCOMES).toEqual(EXPECTED_OUTCOMES);
    expect(ADMISSION_PATH_SYNTAX_RULE_ORDER).toEqual(EXPECTED_RULE_ORDER);
    expect(Object.isFrozen(ADMISSION_PATH_SYNTAX_OUTCOMES)).toBe(true);
    expect(Object.isFrozen(ADMISSION_PATH_SYNTAX_RULE_ORDER)).toBe(true);
    expect(new Set(ADMISSION_PATH_SYNTAX_OUTCOMES).size).toBe(4);
    expect(new Set(ADMISSION_PATH_SYNTAX_RULE_ORDER).size).toBe(7);
  });

  it("selects one predetermined token for the complete twelve-row overlap table", () => {
    const reversedOrderMutant = Object.freeze([...EXPECTED_RULE_ORDER].reverse());

    for (const row of OVERLAP_ROWS) {
      const candidate = validateCallInputs(VALID_BASE, row.input, undefined);
      const matched = matchingRules(row.input);
      const mutant = grammarEvaluator(row.input, reversedOrderMutant);

      expect(matched, row.input).toEqual(row.matched);
      expect(candidate, row.input).toEqual({
        version: VERSION,
        outcome: "path-syntax-invalid",
        rule: row.selected,
      });
      expect(mutant.outcome, row.input).toBe(candidate.outcome);
      expect(mutant.rule, row.input).not.toBe(candidate.rule);
    }
  });

  it("derives a complete rejection partition in which every published token is reachable", () => {
    const reported = new Set();

    for (const partition of REJECTION_PARTITION) {
      for (const input of partition.inputs) {
        const result = validateCallInputs(VALID_BASE, input, undefined);
        expect(result, JSON.stringify(input)).toEqual({
          version: VERSION,
          outcome: "path-syntax-invalid",
          rule: partition.rule,
        });
        reported.add(result.rule);
      }
    }

    expect([...reported]).toEqual(EXPECTED_RULE_ORDER);
    expect([...reported]).toEqual(ADMISSION_PATH_SYNTAX_RULE_ORDER);
  });

  it("executes the collapsed-token and deleted-predicate mutants against the frozen partition", () => {
    const collapsedTokenMutant = (input) => {
      const result = grammarEvaluator(input);
      return result.outcome === "accepted"
        ? result
        : Object.freeze({ outcome: result.outcome, rule: "path-syntax-invalid" });
    };

    for (const partition of REJECTION_PARTITION) {
      const representative = partition.inputs[0];
      const candidate = validateCallInputs(VALID_BASE, representative, undefined);
      const collapsed = collapsedTokenMutant(representative);
      const predicatesWithoutGuard = Object.freeze(
        Object.fromEntries(Object.entries(REFERENCE_PREDICATES).filter(([rule]) => rule !== partition.rule)),
      );
      const orderWithoutGuard = Object.freeze(EXPECTED_RULE_ORDER.filter((rule) => rule !== partition.rule));
      const deletedPredicate = grammarEvaluator(representative, orderWithoutGuard, predicatesWithoutGuard);

      expect(collapsed.outcome).toBe(candidate.outcome);
      expect(collapsed.rule).not.toBe(candidate.rule);
      expect(deletedPredicate).not.toEqual({ outcome: candidate.outcome, rule: candidate.rule });
    }
  });

  it("admits exactly the authoritative positive partition with frozen ordered segments", () => {
    for (const row of POSITIVE_PARTITION) {
      const result = validateCallInputs(VALID_BASE, row.input, undefined);
      expect(result).toEqual({
        version: VERSION,
        outcome: "accepted",
        segments: row.segments,
        filesystem: null,
      });
      expect(result.segments).toEqual(row.segments);
      expect(Object.isFrozen(result.segments)).toBe(true);
    }
  });

  it("keeps the three-hundred-character boundary inclusive and kills the exclusive-bound mutant", () => {
    const boundary = Object.freeze({
      accepted: "a".repeat(300),
      refused: "a".repeat(301),
    });
    const exclusiveBoundMutant = (input) =>
      input.length >= 300 ? Object.freeze({ outcome: "path-syntax-invalid", rule: "length" }) : grammarEvaluator(input);

    expect(validateCallInputs(VALID_BASE, boundary.accepted, undefined).outcome).toBe("accepted");
    expect(validateCallInputs(VALID_BASE, boundary.refused, undefined)).toMatchObject({
      outcome: "path-syntax-invalid",
      rule: "length",
    });
    expect(exclusiveBoundMutant(boundary.accepted).outcome).toBe("path-syntax-invalid");
  });

  it("defaults fail-closed when the published order names a predicate that is unavailable", () => {
    const unknownRuleOrder = Object.freeze(["unknown-rule", ...EXPECTED_RULE_ORDER]);
    expect(grammarEvaluator(VALID_PATH, unknownRuleOrder)).toEqual({
      outcome: "path-syntax-invalid",
      rule: "unknown-rule",
    });
  });
});

describe("admission-path-syntax/v1 third argument", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("accepts %s as selection of the successor's real filesystem", (_name, options) => {
    expect(validateCallInputs(VALID_BASE, VALID_PATH, options)).toEqual({
      version: VERSION,
      outcome: "accepted",
      segments: ["a", "b"],
      filesystem: null,
    });
  });

  it("captures a valid seam unchanged from ordinary and null-prototype option records", () => {
    const nullPrototypeOptions = Object.assign(Object.create(null), { filesystem: VALID_FILESYSTEM });

    for (const options of [VALID_OPTIONS, nullPrototypeOptions]) {
      const result = validateCallInputs(VALID_BASE, VALID_PATH, options);
      expect(result).toMatchObject({ version: VERSION, outcome: "accepted" });
      expect(result.filesystem).toBe(VALID_FILESYSTEM);
      expect(result.segments).toEqual(["a", "b"]);
      expect(Object.isFrozen(result.segments)).toBe(true);
    }
  });

  it.each([
    ["number", 7],
    ["string", "filesystem"],
    ["boolean", true],
    ["array", []],
    ["symbol", Symbol("filesystem")],
  ])("refuses a %s options value and executes the ignored-non-object bypass mutant", (_name, options) => {
    const candidate = validateCallInputs(VALID_BASE, VALID_PATH, options);
    expect(candidate).toEqual({ version: VERSION, outcome: "options-invalid" });
    expect(ignoredNonObjectOptionsMutant(options)).toBe("accepted");
  });

  it.each([
    ["number", 7],
    ["null", null],
    ["missing lstat", { realpath: () => undefined }],
    ["missing realpath", { lstat: () => undefined }],
    ["non-callable lstat", { lstat: true, realpath: () => undefined }],
    ["non-callable realpath", { lstat: () => undefined, realpath: true }],
    ["array", Object.assign([], { lstat: () => undefined, realpath: () => undefined })],
  ])("refuses a filesystem member with the wrong nested shape: %s", (_name, filesystem) => {
    expect(validateCallInputs(VALID_BASE, VALID_PATH, { filesystem })).toEqual({
      version: VERSION,
      outcome: "options-invalid",
    });
  });

  it("returns options-invalid for hostile getter, get trap, has trap, and revoked proxy records", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostileCases = Object.freeze([
      Object.freeze({
        name: "getter",
        value: Object.defineProperty({}, "filesystem", {
          get() {
            throw new TypeError("hostile getter");
          },
        }),
      }),
      Object.freeze({
        name: "get trap",
        value: new Proxy(
          {},
          {
            get() {
              throw new TypeError("hostile get");
            },
          },
        ),
      }),
      Object.freeze({
        name: "has trap",
        value: new Proxy(
          {},
          {
            has() {
              throw new TypeError("hostile has");
            },
          },
        ),
      }),
      Object.freeze({ name: "revoked proxy", value: revoked.proxy }),
    ]);

    for (const hostileCase of hostileCases) {
      expect(() => validateCallInputs(VALID_BASE, VALID_PATH, hostileCase.value), hostileCase.name).not.toThrow();
      expect(validateCallInputs(VALID_BASE, VALID_PATH, hostileCase.value), hostileCase.name).toEqual({
        version: VERSION,
        outcome: "options-invalid",
      });
    }
  });

  it("executes the optional-chaining mutant against the hostile getter, get trap, and revoked proxy", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const mutantKillers = Object.freeze([
      Object.defineProperty({}, "filesystem", {
        get() {
          throw new TypeError("hostile getter");
        },
      }),
      new Proxy(
        {},
        {
          get() {
            throw new TypeError("hostile get");
          },
        },
      ),
      revoked.proxy,
    ]);

    for (const options of mutantKillers) {
      expect(validateCallInputs(VALID_BASE, VALID_PATH, options)).toEqual({
        version: VERSION,
        outcome: "options-invalid",
      });
      expect(() => optionalChainingMutant(options)).toThrow(TypeError);
    }
  });

  it("executes the missing-has-guard mutant against a throwing has trap", () => {
    const options = new Proxy(
      {},
      {
        has() {
          throw new TypeError("hostile has");
        },
      },
    );

    expect(validateCallInputs(VALID_BASE, VALID_PATH, options).outcome).toBe("options-invalid");
    expect(optionalChainingMutant(options)).toBe("accepted");
  });

  it("guards hostile seam member reads without invoking seam behaviour", () => {
    let calls = 0;
    const callable = () => {
      calls += 1;
    };
    const hostileMember = Object.defineProperty({ lstat: callable }, "realpath", {
      get() {
        throw new TypeError("hostile seam member");
      },
    });

    expect(validateCallInputs(VALID_BASE, VALID_PATH, { filesystem: hostileMember })).toEqual({
      version: VERSION,
      outcome: "options-invalid",
    });
    expect(calls).toBe(0);
  });

  it("returns options-invalid for a revoked filesystem proxy without throwing", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const options = { filesystem: revoked.proxy };

    expect(() => validateCallInputs(VALID_BASE, VALID_PATH, options)).not.toThrow();
    expect(validateCallInputs(VALID_BASE, VALID_PATH, options)).toEqual({
      version: VERSION,
      outcome: "options-invalid",
    });
  });

  it("reads options.filesystem exactly once and returns that exact captured seam", () => {
    let reads = 0;
    const options = Object.defineProperty({}, "filesystem", {
      get() {
        reads += 1;
        return VALID_FILESYSTEM;
      },
    });

    const result = validateCallInputs(VALID_BASE, VALID_PATH, options);

    expect(reads).toBe(1);
    expect(result.outcome).toBe("accepted");
    expect(result.filesystem).toBe(VALID_FILESYSTEM);
  });
});

describe("admission-path-syntax/v1 ordered arms and closed records", () => {
  it.each([
    ["both base and path", 7, false],
    ["only base", 7, VALID_PATH],
    ["only path", VALID_BASE, 7],
  ])("refuses non-string inputs deterministically when invalidity is in %s", (_name, baseDirectory, relativePath) => {
    expect(validateCallInputs(baseDirectory, relativePath, VALID_OPTIONS)).toEqual({
      version: VERSION,
      outcome: "input-not-a-string",
    });
  });

  it("evaluates the base and path arms before touching hostile options", () => {
    let reads = 0;
    const hostileOptions = Object.defineProperty({}, "filesystem", {
      get() {
        reads += 1;
        throw new TypeError("must not be read");
      },
    });

    expect(validateCallInputs(7, VALID_PATH, hostileOptions)).toEqual({
      version: VERSION,
      outcome: "input-not-a-string",
    });
    expect(reads).toBe(0);
  });

  it("evaluates hostile options before grammar and executes the grammar-first mutant", () => {
    const hostileOptions = Object.defineProperty({}, "filesystem", {
      get() {
        throw new TypeError("hostile getter");
      },
    });
    const invalidPath = Object.freeze({ value: "" });

    expect(validateCallInputs(VALID_BASE, invalidPath.value, hostileOptions)).toEqual({
      version: VERSION,
      outcome: "options-invalid",
    });
    expect(grammarBeforeOptionsMutant(VALID_BASE, invalidPath.value, hostileOptions)).toBe("path-syntax-invalid");
  });

  it("reaches grammar only after valid call inputs", () => {
    expect(validateCallInputs(VALID_BASE, "", VALID_OPTIONS)).toEqual({
      version: VERSION,
      outcome: "path-syntax-invalid",
      rule: "length",
    });
  });

  it("returns the exact recursively closed owned shape for all four outcomes", () => {
    const records = Object.freeze([
      validateCallInputs(VALID_BASE, VALID_PATH, undefined),
      validateCallInputs(Symbol("base"), VALID_PATH, undefined),
      validateCallInputs(VALID_BASE, "", undefined),
      validateCallInputs(VALID_BASE, VALID_PATH, 7),
    ]);

    for (const record of records) {
      assertClosedRecord(record);
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(records.map((record) => record.outcome)).toEqual(EXPECTED_OUTCOMES);
  });

  it("kills unknown and wrong members at the record and owned-array depths", () => {
    const accepted = validateCallInputs(VALID_BASE, VALID_PATH, undefined);
    const unknownRootMemberMutant = { ...accepted, callerValue: "unexpected" };
    const wrongRuleMemberMutant = {
      version: VERSION,
      outcome: "path-syntax-invalid",
      rule: "unknown-rule",
    };
    const wrongArrayMemberMutant = {
      version: VERSION,
      outcome: "accepted",
      segments: Object.freeze(["a", 7]),
      filesystem: null,
    };
    const arrayWithUnknownMember = ["a", "b"];
    arrayWithUnknownMember.extra = true;
    const unknownArrayMemberMutant = {
      version: VERSION,
      outcome: "accepted",
      segments: Object.freeze(arrayWithUnknownMember),
      filesystem: null,
    };

    expect(() => assertClosedRecord(unknownRootMemberMutant)).toThrow();
    expect(() => assertClosedRecord(wrongRuleMemberMutant)).toThrow();
    expect(() => assertClosedRecord(wrongArrayMemberMutant)).toThrow();
    expect(() => assertClosedRecord(unknownArrayMemberMutant)).toThrow();
  });

  it("keeps rule absent rather than null and accepted-only members absent on refusals", () => {
    const records = Object.freeze([
      validateCallInputs(Symbol("base"), VALID_PATH, undefined),
      validateCallInputs(VALID_BASE, "", undefined),
      validateCallInputs(VALID_BASE, VALID_PATH, 7),
    ]);

    expect(records[0]).not.toHaveProperty("rule");
    expect(records[1]).toHaveProperty("rule", "length");
    expect(records[2]).not.toHaveProperty("rule");
    for (const record of records) {
      expect(record).not.toHaveProperty("segments");
      expect(record).not.toHaveProperty("filesystem");
    }
  });

  it("does not leak caller or host text and executes the echoing-refusal mutant", () => {
    const sentinel = "CALLER!SENTINEL_ZXQ_98631";
    const candidate = validateCallInputs(VALID_BASE, sentinel, undefined);
    const echoingRefusalMutant = Object.freeze({ ...candidate, offendingSegment: sentinel });
    const candidateSerialized = JSON.stringify(candidate);
    const mutantSerialized = JSON.stringify(echoingRefusalMutant);
    const forbiddenFragments = Object.freeze([
      sentinel,
      "ENOENT",
      "EPERM",
      "TypeError",
      "C:\\",
      "/home/",
      path.basename(repoRoot),
    ]);

    expect(candidate).toEqual({
      version: VERSION,
      outcome: "path-syntax-invalid",
      rule: "segment-charset",
    });
    for (const fragment of forbiddenFragments) {
      expect(candidateSerialized).not.toContain(fragment);
    }
    expect(mutantSerialized).toContain(sentinel);
  });

  it("never throws for the complete hostile call-shape corpus", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const corpus = Object.freeze([
      Object.freeze([Symbol("base"), VALID_PATH, undefined]),
      Object.freeze([VALID_BASE, 1n, undefined]),
      Object.freeze([VALID_BASE, VALID_PATH, revoked.proxy]),
      Object.freeze([Symbol("base"), 1n, revoked.proxy]),
    ]);

    for (const args of corpus) {
      expect(() => validateCallInputs(...args)).not.toThrow();
    }
    expect(corpus.map((args) => validateCallInputs(...args).outcome)).toEqual([
      "input-not-a-string",
      "input-not-a-string",
      "options-invalid",
      "input-not-a-string",
    ]);
  });
});

describe("admission-path-syntax/v1 platform-independent purity", () => {
  it("contains no filesystem/path import or operation and only inspects seam member shapes", () => {
    const pattern = String.raw`node:fs|node:path|require\(|readFile|realpath|lstat\(`;
    const output = execFileSync("git", ["grep", "-nE", pattern, "--", "scripts/admission-path-syntax.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    expect(output).not.toMatch(/from\s+["']node:(?:fs|fs\/promises|path)["']/);
    expect(output).not.toMatch(/\brequire\s*\(/);
    expect(output).not.toMatch(/\breadFile\s*\(/);
    expect(output).not.toMatch(/\b(?:lstat|realpath)\s*\(/);
    expect(output.split(/\r?\n/).every((line) => /filesystem|"realpath"/.test(line))).toBe(true);
  });

  it(`records ${process.platform} beside the complete platform-independent outcome-and-rule table`, () => {
    const observation = Object.freeze({
      platform: process.platform,
      table: Object.freeze(
        PLATFORM_CORPUS.map(({ input }) => {
          const { outcome, rule } = validateCallInputs(VALID_BASE, input, undefined);
          return Object.freeze({ input, outcome, ...(rule === undefined ? {} : { rule }) });
        }),
      ),
    });
    const expectation = Object.freeze({
      platform: process.platform,
      table: PLATFORM_CORPUS,
    });

    expect(observation).toEqual(expectation);
  });

  it("executes a platform-branch mutant and proves one shared table catches its divergence", () => {
    const invariantInput = Object.freeze({ value: "platform-neutral" });
    const platformBranchMutant = (input, platform) =>
      platform === "win32"
        ? Object.freeze({ outcome: "path-syntax-invalid", rule: "segment-charset" })
        : grammarEvaluator(input);
    const candidate = validateCallInputs(VALID_BASE, invariantInput.value, undefined);

    expect(candidate.outcome).toBe("accepted");
    expect(platformBranchMutant(invariantInput.value, "linux").outcome).toBe(candidate.outcome);
    expect(platformBranchMutant(invariantInput.value, "win32").outcome).not.toBe(candidate.outcome);
  });
});
