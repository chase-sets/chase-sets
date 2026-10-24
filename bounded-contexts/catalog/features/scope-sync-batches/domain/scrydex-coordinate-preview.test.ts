import { describe, expect, it } from "vitest";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
} from "../../source-observations/api/providers/registry";
import {
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureUnits,
  type ScrydexCacheCaptureUnitKey,
} from "./scrydex-cache-capture";
import {
  classifyScrydexCoordinatePreviewRequest,
  scrydexCoordinatePreviewIsolationPath,
  scrydexCoordinatePreviewPhases,
  validateScrydexCoordinatePreviewReceipt,
  type ScrydexCoordinatePreviewReceipt,
} from "./scrydex-coordinate-preview";

// Candidate C: a synthetic, probe-shaped `complete` receipt. Every identifier
// prefixed "synthetic" and every repeated-character hash is labeled test data,
// never a staging fact. Shapes and timing follow the captured probes:
// run 39529140347 job 118990855108 (deployment read before sign-in and after
// capture, six deep-equal generation keys with numeric runAttempt and the
// runner SHA as deployed head; mappings with microsecond versions, null setId,
// coordinate = setName, auto-accepted) and run 39994196905 job 120553452750
// (credited limit 0: `blocked`, confirmAllowed false, only
// credited-provider-estimate-unavailable). Profiles come from the shipped
// registry; set names from the checked-in Scrydex One Piece and Lorcana fixtures.

const runnerSha = "a".repeat(40);
const onePieceScope = "synthetic-scope-one-piece-romance-dawn";
const lorcanaScope = "synthetic-scope-lorcana-the-first-chapter";
const startedAt = "2026-10-21T01:47:04.995Z";
const resolvedAt = "2026-10-21T01:47:56.449Z";
const finishedAt = "2026-10-21T01:48:22.801Z";
const later = (instant: string, ms: number) => new Date(Date.parse(instant) + ms).toISOString();

function registryProfile(unitKey: ScrydexCacheCaptureUnitKey) {
  const version = catalogProviderIntegrationProfileVersions.find(
    (candidate) =>
      candidate.providerKey === "scrydex" &&
      candidate.active &&
      catalogProviderProfileVersionIngestionUnitKey(candidate) === unitKey,
  );
  if (!version) throw new Error(`No active registry profile for ${unitKey}.`);
  return { profileKey: version.profileKey, profileVersion: version.profileVersion };
}

const generation = {
  runId: "100000000002",
  runAttempt: 1,
  jobId: "100000000003",
  jobCompletedAt: "2026-10-21T01:31:12.000Z",
  deployedHead: runnerSha,
  imageDigest: `sha256:${"c".repeat(64)}`,
};

const units = scrydexCacheCaptureUnits.map(({ productDomain, unitKey }, index) => ({
  unitKey,
  scopeRecordId: productDomain === "one-piece" ? onePieceScope : lorcanaScope,
  setName: productDomain === "one-piece" ? "Romance Dawn" : "The First Chapter",
  mappingId: `synthetic-mapping-${index + 1}`,
  version: `2026-10-20T18:02:1${index}.12345${index}Z`,
  ...registryProfile(unitKey),
}));

const rows = units.map((unit) => ({
  unitKey: unit.unitKey,
  scopeRecordId: unit.scopeRecordId,
  planFingerprint: "d".repeat(64),
  profileKey: unit.profileKey,
  profileVersion: unit.profileVersion,
  mapping: {
    mappingId: unit.mappingId,
    version: unit.version,
    reviewStatus: "auto-accepted" as const,
    setId: null,
    setName: unit.setName,
  },
  coordinate: unit.setName,
  cache: {
    status: "fresh" as const,
    cacheKey: `sha256:${"e".repeat(64)}`,
    fetchedAt: "2026-10-21T01:40:00.000Z",
    expiresAt: "2026-10-21T01:55:00.000Z",
    staleUntil: "2026-10-22T01:40:00.000Z",
  },
  membership: "member" as const,
}));

const sample = (scopeRecordId: string) => ({
  scopeRecordId,
  mappingVersions: units
    .filter((unit) => unit.scopeRecordId === scopeRecordId)
    .map((unit) => ({ mappingId: unit.mappingId, version: unit.version, reviewStatus: "auto-accepted" })),
  profileVersions: units
    .filter((unit) => unit.scopeRecordId === scopeRecordId)
    .map((unit) => ({
      providerKey: "scrydex",
      unitKey: unit.unitKey,
      profileKey: unit.profileKey,
      profileVersion: unit.profileVersion,
    })),
});

const candidate: ScrydexCoordinatePreviewReceipt = {
  schemaVersion: "scrydex-coordinate-preview/v1",
  outcome: "complete",
  reasons: [],
  runner: {
    sha: runnerSha,
    runId: "100000000001",
    runAttempt: "1",
    journeyScope: "scrydex-coordinate-preview",
    origin: "admin.staging.chasesets.com",
  },
  deployment: { before: { ...generation }, after: { ...generation } },
  startedAt,
  finishedAt,
  phases: [...scrydexCoordinatePreviewPhases],
  requests: {
    signIn: 6,
    profileReads: 1,
    scopeInventoryReads: 2,
    coverageReads: 4,
    cacheOptionReads: 10,
    previewPosts: 1,
    usageReads: 1,
    forbidden: 0,
  },
  usageRead: { count: 1, allowed: true },
  forbiddenCalls: [],
  preview: {
    planFingerprint: "d".repeat(64),
    status: "blocked",
    confirmAllowed: false,
    resolvedAt,
    selection: { mode: "ids", scopeRecordIds: [lorcanaScope, onePieceScope] },
    samples: [sample(lorcanaScope), sample(onePieceScope)],
    blockers: [
      {
        code: "credited-provider-estimate-unavailable",
        scopeRecordId: null,
        providerKey: "scrydex",
        message: "scrydex request or credit evidence is unavailable; confirmation is closed.",
      },
    ],
  },
  rows,
};

type Receipt = ScrydexCoordinatePreviewReceipt;
type Preview = NonNullable<Receipt["preview"]>;

// One-variable mutant: a copy of C with exactly one input changed.
function mutant(change: (receipt: Receipt) => void): Receipt {
  const copy = structuredClone(candidate);
  change(copy);
  return copy;
}

function previewOf(receipt: Receipt): Preview {
  if (!receipt.preview) throw new Error("Candidate preview is missing.");
  return receipt.preview;
}

function rowOf(receipt: Receipt, unitKey: string) {
  const row = receipt.rows.find((candidateRow) => candidateRow.unitKey === unitKey);
  if (!row) throw new Error(`No row for ${unitKey}.`);
  return row;
}

function sampleOf(receipt: Receipt, unitKey: string) {
  const { scopeRecordId } = rowOf(receipt, unitKey);
  const found = previewOf(receipt).samples.find((entry) => entry.scopeRecordId === scopeRecordId);
  if (!found) throw new Error(`No sample for ${scopeRecordId}.`);
  return found;
}

function blocker(scopeRecordId: string | null, providerKey = "scrydex") {
  return { code: "scope-planning-blocked", scopeRecordId, providerKey, message: "Scope planning is blocked." };
}

// A derived value the receipt omitted, as the oracle reports it.
const derived = (...values: string[]) => [
  ...[...values].sort().map((value) => `reasons: missing ${value}`),
  "outcome: not derived from evidence",
];

const validate = validateScrydexCoordinatePreviewReceipt;

describe("oracle", () => {
  it("[]", () => {
    expect(validate(candidate)).toEqual([]);
    expect(
      validate(mutant((receipt) => previewOf(receipt).blockers.push(blocker("synthetic-scope-unselected")))),
    ).toEqual([]);
    // Added case: a non-Scrydex scope-planning-blocked blocker on a selected scope is preserved, not blocking.
    expect(
      validate(mutant((receipt) => previewOf(receipt).blockers.push(blocker(onePieceScope, "tcgplayer")))),
    ).toEqual([]);
  });

  it("forbidden-call", () => {
    const receipt = mutant((value) => {
      value.requests.forbidden = 1;
      value.forbiddenCalls = ["mutation:POST"];
    });
    expect(validate(receipt)).toEqual(derived("forbidden-call"));
  });

  it("requests.forbidden: tally mismatch", () => {
    const receipt = mutant((value) => {
      value.requests.forbidden = 2;
      value.forbiddenCalls = ["mutation:POST"];
    });
    expect(validate(receipt)).toEqual(["requests.forbidden: tally mismatch"]);
  });

  it("scrydex-scope-planning-blocked", () => {
    expect(validate(mutant((receipt) => previewOf(receipt).blockers.push(blocker(onePieceScope))))).toEqual(
      derived("scrydex-scope-planning-blocked"),
    );
    expect(validate(mutant((receipt) => previewOf(receipt).blockers.push(blocker(null))))).toEqual(
      derived("scrydex-scope-planning-blocked"),
    );
  });

  it("deployment-unbound", () => {
    const receipt = mutant((value) => {
      value.deployment = { before: null, after: null };
    });
    expect(validate(receipt)).toEqual(derived("deployment-unbound"));
  });

  it("deployment-head-mismatch", () => {
    expect(
      validate(
        mutant((receipt) => {
          receipt.runner.sha = "b".repeat(40);
        }),
      ),
    ).toEqual(derived("deployment-head-mismatch"));
    expect(
      validate(
        mutant((receipt) => {
          receipt.deployment.after = { ...generation, deployedHead: "b".repeat(40) };
        }),
      ),
    ).toEqual(derived("deployment-head-mismatch", "deployment-generation-changed"));
  });

  it("deployment-generation-changed", () => {
    expect(
      validate(
        mutant((receipt) => {
          receipt.deployment.after = { ...generation, jobId: "100000000004" };
        }),
      ),
    ).toEqual(derived("deployment-generation-changed"));
    expect(
      validate(
        mutant((receipt) => {
          receipt.deployment.after = { ...generation, imageDigest: `sha256:${"f".repeat(64)}` };
        }),
      ),
    ).toEqual(derived("deployment-generation-changed"));
  });

  it("cache-stale:<unit>", () => {
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const receipt = mutant((value) => {
        rowOf(value, unitKey).cache.staleUntil = later(finishedAt, -1_000);
      });
      expect(validate(receipt), unitKey).toEqual(derived(`cache-stale:${unitKey}`));
    }
  });

  it("cache-fetched-after-preview:<unit>", () => {
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const receipt = mutant((value) => {
        rowOf(value, unitKey).cache.fetchedAt = later(resolvedAt, 1_000);
      });
      expect(validate(receipt), unitKey).toEqual(derived(`cache-fetched-after-preview:${unitKey}`));
    }
  });

  it("cache-interval:<unit>", () => {
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const receipt = mutant((value) => {
        const { cache } = rowOf(value, unitKey);
        cache.expiresAt = later(cache.fetchedAt, -1_000);
      });
      expect(validate(receipt), unitKey).toEqual(derived(`cache-interval:${unitKey}`));
    }
  });

  it("cache-membership:<unit>", () => {
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const receipt = mutant((value) => {
        rowOf(value, unitKey).membership = "non-member";
      });
      expect(validate(receipt), unitKey).toEqual(derived(`cache-membership:${unitKey}`));
    }
  });

  it("preview-post-count", () => {
    const receipt = mutant((value) => {
      value.requests.previewPosts = 0;
    });
    expect(validate(receipt)).toEqual(derived("preview-post-count"));
  });

  it("usage-read-count", () => {
    const receipt = mutant((value) => {
      value.requests.usageReads = 7;
    });
    expect(validate(receipt)).toEqual(derived("usage-read-count"));
  });

  it("phases-incomplete", () => {
    const receipt = mutant((value) => {
      value.phases = [];
    });
    expect(validate(receipt)).toEqual(derived("phases-incomplete"));
  });

  it("mapping-sample-missing:<unit>", () => {
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const receipt = mutant((value) => {
        const { mappingId } = rowOf(value, unitKey).mapping;
        const entry = sampleOf(value, unitKey).mappingVersions.find((mapping) => mapping.mappingId === mappingId);
        if (!entry) throw new Error(`No sample mapping for ${unitKey}.`);
        entry.reviewStatus = "rejected";
      });
      expect(validate(receipt), unitKey).toEqual(derived(`mapping-sample-missing:${unitKey}`));
    }
  });

  it("profile-sample-missing:<unit>", () => {
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const receipt = mutant((value) => {
        const entry = sampleOf(value, unitKey);
        entry.profileVersions = entry.profileVersions.filter((profile) => profile.unitKey !== unitKey);
      });
      expect(validate(receipt), unitKey).toEqual(derived(`profile-sample-missing:${unitKey}`));
    }
  });

  it("too_big", () => {
    expect(
      validate(
        mutant((receipt) => {
          previewOf(receipt).status = "x".repeat(200_000);
        }),
      ),
    ).toEqual(["preview.status: too_big"]);
    expect(
      validate(
        mutant((receipt) => {
          receipt.requests.cacheOptionReads = 1e15;
        }),
      ),
    ).toEqual(["requests.cacheOptionReads: too_big"]);
    expect(validate(mutant((receipt) => receipt.rows.push(structuredClone(rows[0]!))))).toEqual(["rows: too_big"]);
  });

  it("coordinate-missing:<unit>", () => {
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const receipt = mutant((value) => {
        const row = rowOf(value, unitKey);
        row.mapping.setId = null;
        row.mapping.setName = null;
        row.coordinate = null;
      });
      expect(validate(receipt), unitKey).toEqual(derived(`coordinate-missing:${unitKey}`));
    }
  });

  it("coordinate-mismatch:<unit>", () => {
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const receipt = mutant((value) => {
        rowOf(value, unitKey).coordinate = "Synthetic Unmapped Set";
      });
      expect(validate(receipt), unitKey).toEqual(derived(`coordinate-mismatch:${unitKey}`));
    }
  });

  it("preview-time-out-of-range", () => {
    expect(
      validate(
        mutant((receipt) => {
          previewOf(receipt).resolvedAt = later(finishedAt, 1_000);
        }),
      ),
    ).toEqual(derived("preview-time-out-of-range"));
    // Added case: a preview resolved before the run started is out of range too.
    expect(
      validate(
        mutant((receipt) => {
          previewOf(receipt).resolvedAt = later(startedAt, -1_000);
        }),
      ),
    ).toEqual(derived("preview-time-out-of-range"));
  });

  it("finished-before-started", () => {
    const receipt = mutant((value) => {
      value.finishedAt = later(startedAt, -1_000);
    });
    expect(validate(receipt)).toEqual(derived("finished-before-started"));
  });

  it("invalid_format", () => {
    const receipt = mutant((value) => {
      value.startedAt = "2026-10-20";
    });
    expect(validate(receipt)).toEqual(["startedAt: invalid_format"]);
  });

  it("unrecognized_keys", () => {
    const receipt = mutant((value) => {
      Object.assign(value.rows[0]!.mapping, { extra: 1 });
    });
    expect(validate(receipt)).toEqual(["rows.0.mapping: unrecognized_keys"]);
  });

  it("preview-not-confirmable", () => {
    const receipt = mutant((value) => {
      previewOf(value).status = "empty";
    });
    expect(validate(receipt)).toEqual(derived("preview-not-confirmable"));
  });

  it("preview-missing", () => {
    const receipt = mutant((value) => {
      value.preview = null;
    });
    expect(validate(receipt)).toEqual(derived("preview-missing"));
  });

  it("outcome: not derived from evidence", () => {
    const receipt = mutant((value) => {
      value.reasons = ["producer-failed"];
    });
    expect(validate(receipt)).toEqual(["outcome: not derived from evidence"]);
  });

  it("preview-join-mismatch", () => {
    const receipt = mutant((value) => {
      value.rows[2]!.planFingerprint = "9".repeat(64);
    });
    expect(validate(receipt)).toEqual(derived("preview-join-mismatch"));
  });

  it("rows-duplicate, rows-unit-membership", () => {
    const receipt = mutant((value) => {
      const lorcanaSet = rowOf(value, "scrydex:lorcana:set:reference-data");
      value.rows = value.rows.map((row) =>
        row.unitKey === "scrydex:lorcana:single-card:source-observation-import" ? structuredClone(lorcanaSet) : row,
      );
    });
    expect(validate(receipt)).toEqual(derived("rows-duplicate", "rows-unit-membership"));
  });

  it("rows-not-exactly-five", () => {
    const receipt = mutant((value) => {
      value.rows = value.rows.slice(0, 4);
    });
    expect(validate(receipt)).toEqual(derived("rows-not-exactly-five"));
  });
});

const isolationDocument = `${scrydexCacheCaptureOrigin}${scrydexCoordinatePreviewIsolationPath}`;
const phases = ["sign-in", "capture"] as const;
const refused = (reason: string) => ({ requestClass: "fence-refused", allowed: false, reason });

function classify(method: string, url: string, phase: (typeof phases)[number], navigation: boolean) {
  return classifyScrydexCoordinatePreviewRequest({ method, url, phase, navigation });
}

describe("classifier", () => {
  it("isolation-document", () => {
    expect(classify("GET", isolationDocument, "sign-in", true)).toEqual({
      requestClass: "isolation-document",
      allowed: true,
      reason: "isolation-document",
    });
    // Added case: only the navigation is the isolation document; a sign-in fetch of the path stays a sign-in read.
    expect(classify("GET", isolationDocument, "sign-in", false).requestClass).toBe("sign-in");
  });

  it("ambient-read", () => {
    const ambient = { requestClass: "ambient-read-blocked", allowed: false, reason: "ambient-read" };
    expect(classify("GET", isolationDocument, "capture", true)).toEqual(ambient);
    expect(classify("GET", `${scrydexCacheCaptureOrigin}/assets/app.js`, "capture", false)).toEqual(ambient);
  });

  it("navigation-outside-sign-in", () => {
    expect(classify("GET", `${isolationDocument}?probe=1`, "sign-in", true)).toEqual(
      refused("navigation-outside-sign-in"),
    );
  });

  it("mutation:POST", () => {
    for (const phase of phases) {
      expect(classify("POST", isolationDocument, phase, true), phase).toEqual(refused("mutation:POST"));
    }
  });

  it("api-read-outside-capture", () => {
    expect(classify("GET", `${scrydexCacheCaptureOrigin}/api/catalog/items`, "capture", false)).toEqual(
      refused("api-read-outside-capture"),
    );
  });

  it("classifier preview-post", () => {
    const preview = `${scrydexCacheCaptureOrigin}/api/catalog/scope-sync-batches/preview`;
    expect(classify("POST", preview, "capture", false)).toEqual({
      requestClass: "preview-post",
      allowed: true,
      reason: "preview-post",
    });
    expect(classify("GET", preview, "capture", false)).toEqual(refused("api-read-outside-capture"));
    expect(
      classify("POST", `${scrydexCacheCaptureOrigin}/api/catalog/scope-sync-batches/confirm`, "capture", false),
    ).toEqual(refused("mutation:POST"));
    expect(classify("POST", `${preview}?x=1`, "capture", false)).toEqual(refused("mutation:POST"));
    expect(classify("POST", preview, "sign-in", false)).toEqual(refused("mutation:POST"));
    expect(classify("POST", preview, "capture", true)).toEqual(refused("mutation:POST"));
    expect(
      classify("POST", "https://api.scrydex.com/api/catalog/scope-sync-batches/preview", "capture", false),
    ).toEqual(refused("cross-origin"));
    expect(
      classify(
        "POST",
        "https://tcgplayer@admin.staging.chasesets.com/api/catalog/scope-sync-batches/preview",
        "capture",
        false,
      ),
    ).toEqual(refused("tcgplayer"));
    expect(classify("POST", `${preview}#tcgplayer`, "capture", false)).toEqual(refused("tcgplayer"));
    expect(classify("POST", `${preview}#x`, "capture", false)).toEqual(refused("mutation:POST"));
    expect(classify("POST", `${preview}/x`, "capture", false)).toEqual(refused("mutation:POST"));
  });

  it("classifier usage-read", () => {
    const usage = `${scrydexCacheCaptureOrigin}/api/catalog/source-observations/integration-control-plane/overview?audience=daily`;
    expect(classify("GET", usage, "capture", false)).toEqual({
      requestClass: "usage-read",
      allowed: true,
      reason: "usage-read",
    });
    expect(classify("POST", usage, "capture", false)).toEqual(refused("mutation:POST"));
    expect(
      classify(
        "GET",
        `${scrydexCacheCaptureOrigin}/api/catalog/source-observations/integration-control-plane/overview`,
        "capture",
        false,
      ),
    ).toEqual(refused("api-read-outside-capture"));
    expect(
      classify(
        "GET",
        `${scrydexCacheCaptureOrigin}/api/catalog/source-observations/integration-control-plane/overview?audience=daily&x=1`,
        "capture",
        false,
      ),
    ).toEqual(refused("api-read-outside-capture"));
    expect(
      classify(
        "GET",
        `${scrydexCacheCaptureOrigin}/api/catalog/source-observations/provider-profiles?audience=daily`,
        "capture",
        false,
      ),
    ).toEqual(refused("api-read-outside-capture"));
    expect(classify("GET", usage, "sign-in", false)).toEqual(refused("api-before-capture"));
    expect(classify("GET", usage, "capture", true)).toEqual(refused("api-read-outside-capture"));
    expect(
      classify(
        "GET",
        "https://api.scrydex.com/api/catalog/source-observations/integration-control-plane/overview?audience=daily",
        "capture",
        false,
      ),
    ).toEqual(refused("cross-origin"));
    expect(
      classify(
        "GET",
        "https://tcgplayer@admin.staging.chasesets.com/api/catalog/source-observations/integration-control-plane/overview?audience=daily",
        "capture",
        false,
      ),
    ).toEqual(refused("tcgplayer"));
    expect(classify("GET", `${usage}#tcgplayer`, "capture", false)).toEqual(refused("tcgplayer"));
    expect(classify("GET", `${usage}#x`, "capture", false)).toEqual(refused("api-read-outside-capture"));
    expect(classify("GET", `${usage}/x`, "capture", false)).toEqual(refused("api-read-outside-capture"));
  });

  it("tcgplayer", () => {
    for (const phase of phases) {
      expect(classify("GET", "https://www.tcgplayer.com/", phase, true), phase).toEqual(refused("tcgplayer"));
    }
  });

  it("cross-origin", () => {
    for (const phase of phases) {
      expect(classify("GET", "https://api.scrydex.com/account/v1/usage", phase, false), phase).toEqual(
        refused("cross-origin"),
      );
    }
  });
});
