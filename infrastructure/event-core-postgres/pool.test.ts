import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgPool, normalizePgPoolConnectionString, resolvePgPoolSslConfig } from "./pool";

describe("resolvePgPoolSslConfig", () => {
  it("uses libpq-compatible TLS behavior for sslmode=require", () => {
    expect(resolvePgPoolSslConfig("postgresql://user:pass@example.com:25060/defaultdb?sslmode=require")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("disables TLS for sslmode=disable", () => {
    expect(resolvePgPoolSslConfig("postgresql://user:pass@example.com/defaultdb?sslmode=disable")).toBeUndefined();
  });

  it("verifies TLS certificates for sslmode=verify-ca with PGSSLROOTCERT", () => {
    const { caPath, cleanup } = writeCaFile("test ca");
    try {
      expect(
        resolvePgPoolSslConfig("postgresql://user:pass@example.com/defaultdb?sslmode=verify-ca", {
          PGSSLROOTCERT: caPath,
        }),
      ).toEqual({
        rejectUnauthorized: true,
        ca: "test ca",
      });
    } finally {
      cleanup();
    }
  });

  it("lets connection-string sslrootcert override PGSSLROOTCERT for sslmode=verify-full", () => {
    const envCa = writeCaFile("env ca");
    const urlCa = writeCaFile("url ca");
    try {
      expect(
        resolvePgPoolSslConfig(
          `postgresql://user:pass@example.com/defaultdb?sslmode=verify-full&sslrootcert=${encodeURIComponent(
            urlCa.caPath,
          )}`,
          { PGSSLROOTCERT: envCa.caPath },
        ),
      ).toEqual({
        rejectUnauthorized: true,
        ca: "url ca",
      });
    } finally {
      envCa.cleanup();
      urlCa.cleanup();
    }
  });

  it("defaults remote database hosts to certificate verification", () => {
    expect(resolvePgPoolSslConfig("postgresql://user:pass@example.com/defaultdb")).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("leaves non-TLS local connection strings untouched", () => {
    expect(resolvePgPoolSslConfig("postgresql://postgres:postgres@localhost:5432/chase_sets")).toBeUndefined();
  });

  it("ignores malformed connection strings so pg can report the connection error", () => {
    expect(resolvePgPoolSslConfig("not a url")).toBeUndefined();
  });
});

describe("normalizePgPoolConnectionString", () => {
  it("opts sslmode=require URLs into pg's libpq-compatible parsing", () => {
    const normalized = normalizePgPoolConnectionString(
      "postgresql://user:pass@example.com:25060/defaultdb?sslmode=require",
    );

    expect(new URL(normalized).searchParams.get("uselibpqcompat")).toBe("true");
  });

  it("opts verifying sslmode URLs into pg's libpq-compatible parsing", () => {
    const normalized = normalizePgPoolConnectionString(
      "postgresql://user:pass@example.com:25060/defaultdb?sslmode=verify-full",
    );

    expect(new URL(normalized).searchParams.get("uselibpqcompat")).toBe("true");
  });

  it("preserves existing uselibpqcompat choices", () => {
    const connectionString = "postgresql://user:pass@example.com/defaultdb?sslmode=require&uselibpqcompat=false";

    expect(normalizePgPoolConnectionString(connectionString)).toBe(connectionString);
  });
});

describe("createPgPool", () => {
  it("absorbs idle client errors by default", async () => {
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets") as unknown as {
      emit: (event: string, error: unknown) => boolean;
      end: () => Promise<void>;
    };

    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    await pool.end();
  });

  it("does not pass idle-in-transaction timeout as a startup parameter", async () => {
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets", {
      idleInTransactionSessionTimeoutMillis: 15_000,
    }) as unknown as {
      options: { idle_in_transaction_session_timeout?: number; options?: string };
      idleInTransactionSessionTimeoutMillis?: number;
      end: () => Promise<void>;
    };

    expect(pool.options.idle_in_transaction_session_timeout).toBeUndefined();
    expect(pool.options.options).toBeUndefined();
    expect(pool.idleInTransactionSessionTimeoutMillis).toBe(15_000);
    await pool.end();
  });

  it("sets idle-in-transaction timeout after Postgres clients connect", async () => {
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets", {
      idleInTransactionSessionTimeoutMillis: 15_000,
    }) as unknown as {
      options: {
        onConnect: (client: unknown) => Promise<void>;
      };
      end: () => Promise<void>;
    };
    const client = createFakeClient();

    await pool.options.onConnect(client);

    expect(client.query).toHaveBeenCalledWith("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", [
      "15000ms",
    ]);

    await pool.end();
  });

  it("reports idle-in-transaction session setup failures through the active client hook", async () => {
    const setupError = new Error("provider rejected session setting");
    const reported: unknown[] = [];
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets", {
      idleInTransactionSessionTimeoutMillis: 15_000,
      onActiveClientError: ({ error }) => {
        reported.push(error);
      },
    }) as unknown as {
      options: {
        onConnect: (client: unknown) => Promise<void>;
      };
      end: () => Promise<void>;
    };
    const client = createFakeClient();
    client.query.mockRejectedValueOnce(setupError);

    await expect(pool.options.onConnect(client)).rejects.toThrow("provider rejected session setting");
    expect(reported).toEqual([setupError]);

    await pool.end();
  });

  it("notifies the idle client error hook without letting hook failures escape", async () => {
    const idleError = new Error("Connection terminated unexpectedly");
    const reported: unknown[] = [];
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets", {
      onIdleClientError: ({ error }) => {
        reported.push(error);
        throw new Error("observer failed");
      },
    }) as unknown as {
      emit: (event: string, error: unknown) => boolean;
      end: () => Promise<void>;
    };

    expect(() => pool.emit("error", idleError)).not.toThrow();
    expect(reported).toEqual([idleError]);
    await pool.end();
  });

  it("absorbs active checked-out client errors by default", async () => {
    const connectionError = new Error("Connection terminated unexpectedly");
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets") as unknown as {
      options: {
        onConnect: (client: unknown) => Promise<void>;
      };
      end: () => Promise<void>;
    };
    const client = createFakeClient();

    await pool.options.onConnect(client);
    expect(() => client.emit("error", connectionError)).not.toThrow();

    await pool.end();
  });

  it("notifies the active client error hook without letting hook failures escape", async () => {
    const connectionError = new Error("Connection terminated unexpectedly");
    const reported: unknown[] = [];
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets", {
      onActiveClientError: ({ error }) => {
        reported.push(error);
        throw new Error("observer failed");
      },
    }) as unknown as {
      options: {
        onConnect: (client: unknown) => Promise<void>;
      };
      end: () => Promise<void>;
    };
    const client = createFakeClient();

    await pool.options.onConnect(client);
    expect(() => client.emit("error", connectionError)).not.toThrow();

    expect(reported).toEqual([connectionError]);
    await pool.end();
  });
});

function writeCaFile(contents: string): { caPath: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "chase-sets-pg-ca-"));
  const caPath = join(directory, "root.crt");
  writeFileSync(caPath, contents, "utf8");

  return {
    caPath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function createFakeClient(): EventEmitter & { query: ReturnType<typeof vi.fn> } {
  const client = new EventEmitter() as EventEmitter & { query: ReturnType<typeof vi.fn> };
  client.query = vi.fn(async () => undefined);
  return client;
}
