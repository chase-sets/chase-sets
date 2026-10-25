import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_WINDOW_JOURNAL_LOCK_SQL,
  evidenceWindowJournalPrincipal,
  evidenceWindowJournalPrincipalDropStatements,
  evidenceWindowJournalPrincipalProvisionStatements,
  evidenceWindowJournalProbes,
  parseEvidenceWindowJournalPrincipal,
  runEvidenceWindowJournalProbes,
  scramSha256Verifier,
} from "./evidence-window-journal-principal";

const verifier = scramSha256Verifier("synthetic-password", Buffer.alloc(16, 7));

describe("evidence-window journal principal", () => {
  it("names the login from run id and attempt and parses back only that exact shape", () => {
    const principal = evidenceWindowJournalPrincipal("18342011223", 2);
    expect(principal.name).toBe("evidence_window_journal_18342011223_2");
    expect(parseEvidenceWindowJournalPrincipal(principal.name)).toEqual(principal);
    for (const name of [
      "evidence_window_journal_0_1",
      "evidence_window_journal_12_0",
      "evidence_window_journal_12",
      "evidence_window_journal_12_1_x",
      'evidence_window_journal_12_1"; DROP ROLE x; --',
      "Evidence_window_journal_12_1",
      `evidence_window_journal_${"9".repeat(21)}_1`,
      42,
    ]) {
      expect(parseEvidenceWindowJournalPrincipal(name)).toBeNull();
    }
    expect(() => evidenceWindowJournalPrincipal("12a", 1)).toThrow("identity-invalid");
    expect(() => evidenceWindowJournalPrincipal("12", 0)).toThrow("identity-invalid");
  });

  it("creates a SCRAM verifier that never contains the password", () => {
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(verifier).not.toContain("synthetic-password");
    expect(scramSha256Verifier("synthetic-password", Buffer.alloc(16, 7))).toBe(verifier);
    expect(scramSha256Verifier("synthetic-password")).not.toBe(verifier);
  });

  it("grants only the journal's two tables, with the column UPDATE that FOR SHARE needs", () => {
    const statements = evidenceWindowJournalPrincipalProvisionStatements({
      principal: evidenceWindowJournalPrincipal("77", 1),
      database: "control",
      verifier,
      validUntil: "2026-10-20T12:00:00.000Z",
    });
    expect(statements).toEqual([
      `CREATE ROLE "evidence_window_journal_77_1" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '${verifier}' VALID UNTIL '2026-10-20T12:00:00.000Z'`,
      'GRANT CONNECT ON DATABASE "control" TO "evidence_window_journal_77_1"',
      'GRANT USAGE ON SCHEMA public TO "evidence_window_journal_77_1"',
      'GRANT SELECT ON TABLE public.evidence_window TO "evidence_window_journal_77_1"',
      'GRANT UPDATE (version) ON TABLE public.evidence_window TO "evidence_window_journal_77_1"',
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.evidence_window_provider_write TO "evidence_window_journal_77_1"',
    ]);
    const input = {
      principal: evidenceWindowJournalPrincipal("77", 1),
      database: "control",
      verifier,
      validUntil: "2026-10-20T12:00:00.000Z",
    };
    expect(() => evidenceWindowJournalPrincipalProvisionStatements({ ...input, verifier: "plaintext" })).toThrow(
      "verifier-invalid",
    );
    expect(() => evidenceWindowJournalPrincipalProvisionStatements({ ...input, validUntil: "tomorrow" })).toThrow(
      "input-invalid",
    );
  });

  it("revokes every grant before dropping the login", () => {
    expect(evidenceWindowJournalPrincipalDropStatements(evidenceWindowJournalPrincipal("77", 1), "control")).toEqual([
      'REVOKE ALL ON TABLE public.evidence_window_provider_write FROM "evidence_window_journal_77_1"',
      'REVOKE ALL ON TABLE public.evidence_window FROM "evidence_window_journal_77_1"',
      'REVOKE ALL ON SCHEMA public FROM "evidence_window_journal_77_1"',
      'REVOKE ALL ON DATABASE "control" FROM "evidence_window_journal_77_1"',
      'DROP ROLE IF EXISTS "evidence_window_journal_77_1"',
    ]);
  });

  it("mirrors the shipped journal's reserve lock statement exactly", () => {
    const journal = readFileSync(new URL("./evidence-window-provider-write.ts", import.meta.url), "utf8");
    expect(journal).toContain(EVIDENCE_WINDOW_JOURNAL_LOCK_SQL);
    expect(journal).toContain("pg_advisory_xact_lock(hashtextextended($1, 0))");
  });

  it("classifies each probe from its SQLSTATE and rolls every probe back", async () => {
    const issued: string[] = [];
    const client = {
      query: async (text: string) => {
        issued.push(text);
        if (text.startsWith("UPDATE evidence_window")) throw Object.assign(new Error("raw"), { code: "42501" });
        if (text.startsWith("SELECT pg_reload_conf")) throw Object.assign(new Error("raw"), { code: "XX000" });
        return { rows: [] };
      },
    };
    const results = await runEvidenceWindowJournalProbes(client, "0123456789abcdef0123456789abcdef");
    expect(results.map(({ name, observed }) => [name, observed])).toEqual([
      ["advisory-lock", "allowed"],
      ["window-lock", "allowed"],
      ["evidence-window-update", "refused"],
      ["evidence-window-insert", "allowed"],
      ["evidence-window-delete", "allowed"],
      ["journal-delete", "allowed"],
      ["unrelated-table-read", "allowed"],
      ["admin-function", "failed"],
    ]);
    expect(issued.filter((text) => text === "BEGIN")).toHaveLength(evidenceWindowJournalProbes.length);
    expect(issued.filter((text) => text === "ROLLBACK")).toHaveLength(evidenceWindowJournalProbes.length);
    expect(JSON.stringify(results)).not.toContain("raw");
  });

  it("keeps every refused probe a no-op even if its grant were wrong", () => {
    for (const probe of evidenceWindowJournalProbes.filter(({ expect: outcome }) => outcome === "refused")) {
      expect(probe.sql).toMatch(/WHERE false|LIMIT 0|pg_reload_conf\(\)/);
    }
  });
});
