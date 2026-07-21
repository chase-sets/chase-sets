import { describe, expect, it } from "vitest";
import {
  mergeGateIdentity,
  selectStaleMergeGateNamespaces,
  selectStaleVerificationNamespaces,
  verificationIdentity,
} from "./ephemeral-verification-namespace.mjs";

describe("ephemeral verification namespaces", () => {
  it("derives DNS-safe isolated names from a workflow run", () => {
    expect(verificationIdentity("123456", "2")).toEqual({
      slug: "verify-123456-2",
      namespace: "chase-sets-verify-123456-2",
      release: "csv-123456-2",
    });
  });

  it("selects every strictly named verification namespace at least 24 hours old", () => {
    const item = (name, created, purpose) => ({
      metadata: {
        name,
        creationTimestamp: created,
        labels: purpose ? { "chasesets.com/purpose": purpose } : undefined,
      },
    });
    expect(
      selectStaleVerificationNamespaces(
        [
          item("chase-sets-verify-100-1", "2026-07-11T12:00:00.000Z"),
          item("chase-sets-verify-101-1", "2026-07-11T12:00:00.001Z"),
          item("chase-sets-verify-manual-proof", "2026-07-11T00:00:00.000Z", "something-else"),
        ],
        { now: "2026-07-12T12:00:00.000Z" },
      ),
    ).toEqual([
      { namespace: "chase-sets-verify-100-1", release: "csv-100-1", slug: "verify-100-1" },
      {
        namespace: "chase-sets-verify-manual-proof",
        release: "csv-manual-proof",
        slug: "verify-manual-proof",
      },
    ]);
  });

  it("never selects a namespace outside the strict chase-sets-verify run prefix", () => {
    const created = "2020-01-01T00:00:00.000Z";
    const items = [
      "chase-sets-platform",
      "chase-sets-pr-100",
      "chase-sets-verify-",
      "other-chase-sets-verify-100-1",
      "staging",
    ].map((name) => ({ metadata: { name, creationTimestamp: created } }));

    expect(selectStaleVerificationNamespaces(items, { now: "2026-07-12T12:00:00.000Z" })).toEqual([]);
  });
});

describe("merge-gate namespaces (#5838)", () => {
  const gateItem = (name, { labels, annotations, created } = {}) => ({
    metadata: {
      name,
      creationTimestamp: created,
      labels,
      annotations,
    },
  });
  const ours = { "chasesets.com/purpose": "merge-gate-verification" };

  it("derives DNS-safe gate identity distinct from the verify kind", () => {
    expect(mergeGateIdentity("987654", "3")).toEqual({
      slug: "gate-987654-3",
      namespace: "chase-sets-gate-987654-3",
      release: "csg-987654-3",
    });
    expect(() => mergeGateIdentity("abc", "1")).toThrow("run id and attempt must be positive integers.");
  });

  it("selects only labeled gate namespaces past their cleanup deadline", () => {
    const now = "2026-07-21T12:00:00.000Z";
    const selection = selectStaleMergeGateNamespaces(
      [
        gateItem("chase-sets-gate-100-1", {
          labels: ours,
          annotations: { "chasesets.com/cleanup-deadline": "2026-07-21T11:59:59.000Z" },
          created: "2026-07-21T09:00:00.000Z",
        }),
        gateItem("chase-sets-gate-101-1", {
          labels: ours,
          annotations: { "chasesets.com/cleanup-deadline": "2026-07-21T14:00:00.000Z" },
          created: "2026-07-21T11:30:00.000Z",
        }),
      ],
      { now },
    );

    expect(selection.scanned).toBe(2);
    expect(selection.refused).toEqual([]);
    expect(selection.eligible).toEqual([
      {
        namespace: "chase-sets-gate-100-1",
        release: "csg-100-1",
        slug: "gate-100-1",
        reason: "past-cleanup-deadline",
      },
    ]);
  });

  it("refuses unlabeled and foreign-labeled gate-named namespaces instead of deleting them", () => {
    const now = "2026-07-21T12:00:00.000Z";
    const selection = selectStaleMergeGateNamespaces(
      [
        gateItem("chase-sets-gate-200-1", { created: "2020-01-01T00:00:00.000Z" }),
        gateItem("chase-sets-gate-201-1", {
          labels: { "chasesets.com/purpose": "release-verification" },
          created: "2020-01-01T00:00:00.000Z",
        }),
      ],
      { now },
    );

    expect(selection.eligible).toEqual([]);
    expect(selection.refused).toEqual([
      { namespace: "chase-sets-gate-200-1", reason: expect.stringContaining("unlabeled") },
      { namespace: "chase-sets-gate-201-1", reason: expect.stringContaining("foreign purpose label") },
    ]);
  });

  it("falls back to the 6-hour age bound when the deadline annotation is missing, and sweeps unreadable timestamps", () => {
    const now = "2026-07-21T12:00:00.000Z";
    const selection = selectStaleMergeGateNamespaces(
      [
        gateItem("chase-sets-gate-300-1", { labels: ours, created: "2026-07-21T05:00:00.000Z" }),
        gateItem("chase-sets-gate-301-1", { labels: ours, created: "2026-07-21T11:00:00.000Z" }),
        gateItem("chase-sets-gate-302-1", { labels: ours }),
      ],
      { now },
    );

    expect(selection.eligible).toEqual([
      {
        namespace: "chase-sets-gate-300-1",
        release: "csg-300-1",
        slug: "gate-300-1",
        reason: "missing-deadline-age-fallback",
      },
      {
        namespace: "chase-sets-gate-302-1",
        release: "csg-302-1",
        slug: "gate-302-1",
        reason: "unreadable-timestamps",
      },
    ]);
  });

  it("never matches staging, production, previews, verify namespaces, or renamed gate lookalikes", () => {
    const now = "2026-07-21T12:00:00.000Z";
    const historicalAndRenamed = [
      // Historical-path fixtures: every other namespace kind that has ever
      // lived on the staging cluster.
      "chase-sets-platform",
      "staging",
      "production",
      "kube-system",
      "chase-sets-pr-100",
      "chase-sets-verify-100-1",
      "chase-sets-verify-manual-proof",
      // Renamed-copy fixtures: gate-adjacent names outside the bounded shape.
      "chase-sets-gate2-100-1",
      "other-chase-sets-gate-100-1",
      "chase-sets-gate-abc-1",
      "chase-sets-gate-100-1-fixture",
      "chase-sets-gate-100",
    ];
    const selection = selectStaleMergeGateNamespaces(
      historicalAndRenamed.map((name) =>
        gateItem(name, {
          labels: ours,
          annotations: { "chasesets.com/cleanup-deadline": "2020-01-01T00:00:00.000Z" },
          created: "2020-01-01T00:00:00.000Z",
        }),
      ),
      { now },
    );

    expect(selection.scanned).toBe(historicalAndRenamed.length);
    expect(selection.eligible).toEqual([]);
    expect(selection.refused).toEqual([]);
  });
});
