import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { findCurrentConsent, listConsents, listSubjectExactCurrentConsents } from "./queries";

describe("findCurrentConsent", () => {
  it("returns null without querying when no subject is given", async () => {
    const db = { query: vi.fn() } as unknown as PgQueryable;

    const result = await findCurrentConsent(db, { policyKey: "terms-of-service" });

    expect(result).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("queries by policy key and subject, ordered to the most recent fact", async () => {
    const row = {
      consent_id: "cns_1",
      subject_type: "user",
      user_id: "usr_1",
      account_id: "acc_1",
      policy_key: "terms-of-service",
      policy_version: "v2",
      status: "recorded",
      recorded_at: "2026-06-01T00:00:00.000Z",
      withdrawn_at: null,
      updated_at: "2026-06-01T00:00:00.000Z",
    };
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [row] }));
    const db = { query } as unknown as PgQueryable;

    const result = await findCurrentConsent(db, {
      userId: "usr_1",
      accountId: "acc_1",
      policyKey: "terms-of-service",
    });

    expect(result).toEqual(row);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("FROM identity_consent_current_states");
    expect(sql).toContain("ORDER BY updated_at DESC");
    expect(sql).toContain("policy_key = $1");
    expect(values).toEqual(["terms-of-service", "usr_1", "acc_1"]);
  });

  it("returns null when no matching fact exists", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PgQueryable;

    const result = await findCurrentConsent(db, { userId: "usr_new", policyKey: "terms-of-service" });

    expect(result).toBeNull();
  });

  it("lists retained consent records with their current-state marker", async () => {
    const rows = [
      { consent_id: "cns_2", status: "recorded", is_current: true },
      { consent_id: "cns_1", status: "withdrawn", is_current: false },
    ];
    const query = vi.fn(async (sql: string) => (sql.includes("COUNT(*)") ? { rows: [{ count: "2" }] } : { rows }));
    const db = { query } as unknown as PgQueryable;

    const result = await listConsents(db, { userId: "usr_1" });

    expect(result).toEqual({ items: rows, total: 2 });
    const listSql = query.mock.calls.map(([sql]) => sql).find((sql) => !sql.includes("COUNT(*)"));
    expect(listSql).toContain("FROM identity_consents h");
    expect(listSql).toContain("FROM identity_consent_current_states c");
    expect(listSql).toContain("AS is_current");
  });
});

describe("listSubjectExactCurrentConsents", () => {
  it("pins one subject_type and subject_id and never widens to a disjunction", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const db = { query } as unknown as PgQueryable;

    await listSubjectExactCurrentConsents(db, {
      subjectType: "user",
      subjectId: "usr_1",
      policyKeys: ["terms-of-service", "privacy-policy"],
    });

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("c.subject_type = $1");
    expect(sql).toContain("c.subject_id = $2");
    expect(sql).not.toMatch(/\bOR\b/);
    expect(values).toEqual(["user", "usr_1", ["terms-of-service", "privacy-policy"]]);
  });

  it("qualifies every column reference across the ordinality join", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const db = { query } as unknown as PgQueryable;

    await listSubjectExactCurrentConsents(db, {
      subjectType: "account",
      subjectId: "acc_1",
      policyKeys: ["seller-agreement"],
    });

    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("FROM identity_consent_current_states AS c");
    expect(sql).toContain("JOIN unnest($3::text[]) WITH ORDINALITY AS m(policy_key, member_ordinal)");
    expect(sql).toContain("ON m.policy_key = c.policy_key");
    expect(sql).toContain("ORDER BY m.member_ordinal");
    // `policy_key` exists on both sides of the join, so every *reference* to it
    // carries a table qualifier. Strip the two places the bare name is a
    // declaration rather than a reference -- the derived table's column alias
    // list and the projected output alias -- then require nothing bare is left.
    const references = sql.replace("m(policy_key, member_ordinal)", "m").replace(" AS member_ordinal", "");
    expect(references).not.toMatch(/(?<![.\w])policy_key\b/);
    expect(references).not.toMatch(/(?<![.\w])member_ordinal\b/);
    expect(references).not.toMatch(/(?<![.\w])subject_(?:type|id)\b/);
  });

  it("returns the rows in the requested member order", async () => {
    const rows = [
      { policy_key: "seller-agreement", member_ordinal: 1 },
      { policy_key: "payments-terms", member_ordinal: 2 },
    ];
    const db = { query: vi.fn(async () => ({ rows })) } as unknown as PgQueryable;

    const result = await listSubjectExactCurrentConsents(db, {
      subjectType: "account",
      subjectId: "acc_1",
      policyKeys: ["seller-agreement", "payments-terms"],
    });

    expect(result).toEqual(rows);
  });
});
