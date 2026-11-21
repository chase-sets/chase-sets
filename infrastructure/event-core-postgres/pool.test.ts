import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  ManagedPostgresClientError,
  admitPostgresClientConnection,
  classifyManagedPostgresClientError,
  composePreviewPostgresHost,
  createPgClient,
  createPgPool,
  managedPostgresPodCaPath,
  managedPostgresRunnerCaPath,
  previewPostgresHostEnvName,
  resolveManagedPostgresCaPath,
  resolvePreviewPostgresHost,
  type PostgresClientEnvironment,
} from "./pool";
import type { PgTransactionalPool } from "./types";

const runnerTemp = "/home/runner/work/_temp";
const runnerCaPath = managedPostgresRunnerCaPath(runnerTemp);
const podEnv = { KUBERNETES_SERVICE_HOST: "10.245.0.1", DEPLOYMENT_ENVIRONMENT: "staging" } as const;
const runnerEnv = { GITHUB_ACTIONS: "true", RUNNER_TEMP: runnerTemp } as const;
const previewHost = "chase-sets-pr-42-chase-sets-platform-preview-postgres";
const managedHost = "db-postgresql-nyc3-00000-do-user-0-0.k.db.ondigitalocean.com";

function managedUrl(caPath: string, overrides: Record<string, string | null> = {}, host = managedHost): string {
  const url = new URL(`postgresql://cs_catalog:secret-password@${host}:25060/catalog`);
  const params: Record<string, string | null> = {
    sslmode: "verify-full",
    sslrootcert: caPath,
    uselibpqcompat: "true",
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

function refusal(connectionString: string, env: PostgresClientEnvironment): string {
  try {
    admitPostgresClientConnection(connectionString, env);
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedPostgresClientError);
    const serialized = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain(managedHost);
    return (error as ManagedPostgresClientError).classification;
  }
  return "admitted";
}

describe("resolveManagedPostgresCaPath", () => {
  it("binds pods to the #7512 mount and runners to the canonical RUNNER_TEMP export", () => {
    expect(resolveManagedPostgresCaPath(podEnv)).toBe(managedPostgresPodCaPath);
    expect(managedPostgresPodCaPath).toBe("/var/run/secrets/chase-sets/managed-postgres/ca.crt");
    expect(resolveManagedPostgresCaPath(runnerEnv)).toBe(runnerCaPath);
  });

  it.each([
    ["no execution context", {}],
    ["runner without RUNNER_TEMP", { GITHUB_ACTIONS: "true" }],
    ["runner with a relative RUNNER_TEMP", { GITHUB_ACTIONS: "true", RUNNER_TEMP: "tmp" }],
    ["self-set non-runner marker", { GITHUB_ACTIONS: "1", RUNNER_TEMP: runnerTemp }],
    ["pod and runner markers together", { ...podEnv, ...runnerEnv }],
    ["preview pod", { ...podEnv, DEPLOYMENT_ENVIRONMENT: "preview" }],
    ["operator CA overrides", { PGSSLROOTCERT: runnerCaPath, MANAGED_POSTGRES_CA_PATH: runnerCaPath }],
  ])("has no managed trust location for %s", (_label, env) => {
    expect(resolveManagedPostgresCaPath(env)).toBeUndefined();
  });
});

describe("admitPostgresClientConnection", () => {
  it("admits verify-full URLs bound to the execution context's CA path unchanged", () => {
    const pod = managedUrl(managedPostgresPodCaPath);
    expect(admitPostgresClientConnection(pod, podEnv)).toEqual({
      connectionString: pod,
      transport: "verified-managed",
    });
    const runner = managedUrl(runnerCaPath);
    expect(admitPostgresClientConnection(runner, runnerEnv)).toEqual({
      connectionString: runner,
      transport: "verified-managed",
    });
  });

  it.each([
    ["absent sslmode", managedUrl(managedPostgresPodCaPath, { sslmode: null }), "remote-postgres-sslmode-missing"],
    ["prefer", managedUrl(managedPostgresPodCaPath, { sslmode: "prefer" }), "remote-postgres-sslmode-downgraded"],
    ["require", managedUrl(managedPostgresPodCaPath, { sslmode: "require" }), "remote-postgres-sslmode-downgraded"],
    ["verify-ca", managedUrl(managedPostgresPodCaPath, { sslmode: "verify-ca" }), "remote-postgres-sslmode-downgraded"],
    ["disable", managedUrl(managedPostgresPodCaPath, { sslmode: "disable" }), "remote-postgres-sslmode-downgraded"],
    [
      "upper-case mode",
      managedUrl(managedPostgresPodCaPath, { sslmode: "VERIFY-FULL" }),
      "remote-postgres-sslmode-downgraded",
    ],
    [
      "missing uselibpqcompat",
      managedUrl(managedPostgresPodCaPath, { uselibpqcompat: null }),
      "remote-postgres-libpq-compat-required",
    ],
    [
      "uselibpqcompat=false",
      managedUrl(managedPostgresPodCaPath, { uselibpqcompat: "false" }),
      "remote-postgres-libpq-compat-required",
    ],
    [
      "missing sslrootcert",
      managedUrl(managedPostgresPodCaPath, { sslrootcert: null }),
      "remote-postgres-rootcert-missing",
    ],
    ["runner path in a pod", managedUrl(runnerCaPath), "remote-postgres-rootcert-path-unexpected"],
    ["arbitrary path", managedUrl("/tmp/attacker-ca.pem"), "remote-postgres-rootcert-path-unexpected"],
    ["invalid URL", "not a url", "postgres-url-invalid"],
    ["non-postgres scheme", "https://example.com/catalog", "postgres-url-invalid"],
    ["IP authority", managedUrl(managedPostgresPodCaPath, {}, "10.0.0.5"), "postgres-url-invalid"],
    ["hostaddr escape", managedUrl(managedPostgresPodCaPath, { hostaddr: "10.0.0.5" }), "postgres-url-invalid"],
    ["host parameter override", managedUrl(managedPostgresPodCaPath, { host: "evil.example" }), "postgres-url-invalid"],
    ["ssl parameter", managedUrl(managedPostgresPodCaPath, { ssl: "true" }), "postgres-url-invalid"],
    ["duplicate sslmode", `${managedUrl(managedPostgresPodCaPath)}&sslmode=disable`, "postgres-url-invalid"],
  ])("refuses %s in a pod", (_label, connectionString, classification) => {
    expect(refusal(connectionString, podEnv)).toBe(classification);
  });

  it("refuses an env-only CA and cross-location paths on a runner", () => {
    expect(
      refusal(managedUrl(runnerCaPath, { sslrootcert: null }), { ...runnerEnv, PGSSLROOTCERT: runnerCaPath }),
    ).toBe("remote-postgres-rootcert-missing");
    expect(refusal(managedUrl(managedPostgresPodCaPath), runnerEnv)).toBe("remote-postgres-rootcert-path-unexpected");
    expect(
      refusal(managedUrl("/opt/ca.pem"), {
        ...runnerEnv,
        PGSSLROOTCERT: "/opt/ca.pem",
        MANAGED_POSTGRES_CA_PATH: "/opt/ca.pem",
      }),
    ).toBe("remote-postgres-rootcert-path-unexpected");
    expect(refusal(managedUrl(runnerCaPath), { GITHUB_ACTIONS: "true" })).toBe(
      "remote-postgres-rootcert-path-unexpected",
    );
    expect(refusal(managedUrl(runnerCaPath), {})).toBe("remote-postgres-rootcert-path-unexpected");
  });

  it("refuses an ambient process-wide TLS verification downgrade", () => {
    expect(refusal(managedUrl(managedPostgresPodCaPath), { ...podEnv, NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toBe(
      "remote-postgres-sslmode-downgraded",
    );
  });

  it.each([
    ["localhost", "postgresql://postgres:postgres@localhost:5432/chase_sets"],
    ["127.0.0.1", "postgresql://postgres:postgres@127.0.0.1:5432/chase_sets"],
    ["::1", "postgresql://postgres:postgres@[::1]:5432/chase_sets"],
  ])("keeps %s local containers plaintext with an explicit disable mode", (_label, connectionString) => {
    for (const env of [{}, podEnv, runnerEnv, { DEPLOYMENT_ENVIRONMENT: "production", PGSSLMODE: "require" }]) {
      const admission = admitPostgresClientConnection(connectionString, env);
      expect(admission.transport).toBe("plaintext-local");
      expect(new URL(admission.connectionString).searchParams.get("sslmode")).toBe("disable");
    }
  });

  it("validates loopback TLS URLs like remote ones", () => {
    expect(refusal("postgresql://postgres:postgres@localhost:5432/chase_sets?sslmode=require", runnerEnv)).toBe(
      "remote-postgres-sslmode-downgraded",
    );
    expect(admitPostgresClientConnection(managedUrl(runnerCaPath, {}, "localhost"), runnerEnv).transport).toBe(
      "verified-managed",
    );
  });

  it("admits preview plaintext only for the release's exact preview service under preview with disable", () => {
    const preview = `postgresql://cs_preview_catalog:secret-password@${previewHost}:5432/chase_sets_preview_catalog?sslmode=disable`;
    const previewEnv = {
      DEPLOYMENT_ENVIRONMENT: "preview",
      KUBERNETES_SERVICE_HOST: "10.245.0.1",
      [previewPostgresHostEnvName]: previewHost,
    };
    expect(admitPostgresClientConnection(preview, previewEnv)).toEqual({
      connectionString: preview,
      transport: "plaintext-preview",
    });

    for (const environment of ["staging", "production", undefined]) {
      expect(refusal(preview, { ...previewEnv, DEPLOYMENT_ENVIRONMENT: environment })).toBe(
        "remote-postgres-sslmode-downgraded",
      );
    }
    expect(refusal(preview.replace("sslmode=disable", "sslmode=require"), previewEnv)).toBe(
      "remote-postgres-sslmode-downgraded",
    );
    expect(refusal(preview.replace("sslmode=disable", ""), previewEnv)).toBe("remote-postgres-sslmode-missing");
    expect(refusal(preview.replace(previewHost, "postgres"), previewEnv)).toBe("remote-postgres-sslmode-downgraded");
    expect(refusal(preview.replace(previewHost, managedHost), previewEnv)).toBe("remote-postgres-sslmode-downgraded");
    expect(refusal(managedUrl(managedPostgresPodCaPath), previewEnv)).toBe("remote-postgres-rootcert-path-unexpected");

    // A preview-looking suffix is not the preview database: only this release's Service is.
    for (const host of [
      "synthetic-unrelated-preview-postgres",
      "chase-sets-pr-43-chase-sets-platform-preview-postgres",
      composePreviewPostgresHost,
    ]) {
      expect(refusal(preview.replace(previewHost, host), previewEnv)).toBe("remote-postgres-sslmode-downgraded");
      expect(() => createPgClient(preview.replace(previewHost, host), {}, previewEnv)).toThrow(
        "remote-postgres-sslmode-downgraded",
      );
    }
    expect(refusal(preview, { ...previewEnv, [previewPostgresHostEnvName]: "Not A Host" })).toBe(
      "remote-postgres-sslmode-downgraded",
    );
  });

  it("admits the fixed Compose alias as the preview database only where no release names one", () => {
    const composeEnv = { DEPLOYMENT_ENVIRONMENT: "preview" };
    const compose = `postgresql://postgres:secret-password@${composePreviewPostgresHost}:5432/chase_sets?sslmode=disable`;
    expect(resolvePreviewPostgresHost(composeEnv)).toBe(composePreviewPostgresHost);
    expect(admitPostgresClientConnection(compose, composeEnv).transport).toBe("plaintext-preview");
    for (const host of [previewHost, "synthetic-unrelated-preview-postgres"]) {
      expect(refusal(compose.replace(composePreviewPostgresHost, host), composeEnv)).toBe(
        "remote-postgres-sslmode-downgraded",
      );
    }
    expect(resolvePreviewPostgresHost({ [previewPostgresHostEnvName]: previewHost })).toBeUndefined();
    expect(admitPostgresClientConnection("postgresql://postgres@localhost:5432/chase_sets", composeEnv).transport).toBe(
      "plaintext-local",
    );
  });
});

describe("classifyManagedPostgresClientError", () => {
  it.each([
    [{ code: "ENOENT", message: "open /var/run/secrets/ca.crt" }, "certificate-authority-file-unavailable", undefined],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "certificate-authority-untrusted", "SELF_SIGNED_CERT_IN_CHAIN"],
    [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, "certificate-authority-untrusted", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "certificate-hostname-mismatch", "ERR_TLS_CERT_ALTNAME_INVALID"],
    [
      { code: "ECONNREFUSED", message: "connect ECONNREFUSED 10.0.0.5:25060" },
      "postgres-connect-failed",
      "ECONNREFUSED",
    ],
    [
      { code: "28P01", message: "password authentication failed for user cs_catalog" },
      "postgres-connect-failed",
      "28P01",
    ],
    [{ code: "provider text: lower-case" }, "postgres-connect-failed", undefined],
    [new Error("The server does not support SSL connections"), "postgres-connect-failed", undefined],
  ])("maps %j to the closed taxonomy without provider text", (input, classification, code) => {
    const classified = classifyManagedPostgresClientError(input);
    expect(classified.classification).toBe(classification);
    expect(classified.message).toBe(classification);
    expect(classified.code).toBe(code);
    expect(JSON.stringify({ ...classified, message: classified.message })).not.toMatch(/10\.0\.0\.5|cs_catalog|secret/);
  });
});

describe("managed client seam", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses an unsafe URL before any pool exists", () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.245.0.1");
    expect(() => createPgPool(managedUrl(managedPostgresPodCaPath, { sslmode: "require" }))).toThrow(
      ManagedPostgresClientError,
    );
    expect(() => createPgClient(managedUrl(runnerCaPath))).toThrow("remote-postgres-rootcert-path-unexpected");
  });

  it("classifies an absent pod CA during acquisition without throwing from the pool", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.245.0.1");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
    const pool = createPgPool(managedUrl(managedPostgresPodCaPath));
    try {
      await expect(pool.query("SELECT 1")).rejects.toMatchObject({
        name: "ManagedPostgresClientError",
        classification: "certificate-authority-file-unavailable",
        message: "certificate-authority-file-unavailable",
      });
    } finally {
      await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
    }

    const client = createPgClient(managedUrl(managedPostgresPodCaPath));
    await expect(client.connect()).rejects.toMatchObject({ classification: "certificate-authority-file-unavailable" });
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

function createFakeClient(): EventEmitter & { query: ReturnType<typeof vi.fn> } {
  const client = new EventEmitter() as EventEmitter & { query: ReturnType<typeof vi.fn> };
  client.query = vi.fn(async () => undefined);
  return client;
}
