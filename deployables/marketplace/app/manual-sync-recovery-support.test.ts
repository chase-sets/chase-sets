import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { runInNewContext } from "node:vm";
import * as responses from "@chase-sets/http/responses";
import { createManualSyncBrowserRecovery } from "../e2e/support/manual-sync-recovery";

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: h.spawn, default: { spawn: h.spawn } }));
const fixture = {
  ownershipId: "12345678-1234-4123-8123-123456789abc",
  connectionId: "chn_owned",
  listingId: "lst_owned",
  inventoryItemId: "itm_owned",
  createdAfter: "2026-11-07T00:00:00.000Z",
};
const metadata = { channelsDatabaseUrl: "private-marker-channels", catalogDatabaseUrl: "private-marker-catalog" };
const receipt = () => ({
  version: 1,
  ownershipId: fixture.ownershipId,
  connectionId: fixture.connectionId,
  listingId: fixture.listingId,
  runId: `run-browser-recovery-${fixture.ownershipId}`,
  runRevision: 0,
});

function recoveryFunctions(file: string, names: string[], globals: Record<string, unknown> = {}) {
  const filename = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../e2e/${file}`);
  const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = names.map((name) => {
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing recovery function: ${name}`);
    return declaration.getText(source);
  });
  const javascript = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(`${javascript}; ({ ${names.join(",")} })`, {
    ...responses,
    expect,
    URL,
    Headers,
    AggregateError,
    ...globals,
  });
}

describe("owned recovery browser preparation", () => {
  it("keeps recovery client navigation before provider selection and drains held connection routes", () => {
    const source = (name: string) =>
      readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../e2e/${name}`), "utf8");
    const recovery = source("manual-sync-recovery.spec.ts");
    expect(recovery).toContain("await hydratedChannelForm(page)");
    expect(recovery).toContain("await expect(activate).toBeEnabled()");
    expect(recovery.indexOf("await hydratedChannelForm(page)")).toBeLessThan(
      recovery.indexOf('.selectOption("tcgplayer")'),
    );
    expect(recovery).toContain("await expect(location).toBeChecked()");
    expect(recovery.indexOf("await expect(activate).toBeEnabled()")).toBeLessThan(
      recovery.indexOf("await activate.click()"),
    );
    const connection = source("channel-connection-connect.spec.ts");
    expect(connection).toContain("releaseScript();");
    expect(connection).toContain('await page.unrouteAll({ behavior: "wait" })');
    expect(connection.indexOf("releaseScript();")).toBeLessThan(
      connection.indexOf('await page.unrouteAll({ behavior: "wait" })'),
    );
    const interruption = source("account-management-interruption.spec.ts");
    const afterEach = interruption.slice(
      interruption.indexOf("test.afterEach"),
      interruption.indexOf('test("five actual routes'),
    );
    expect(afterEach).toContain("await expect(page).toHaveURL");
    expect(afterEach.indexOf("await expect(page).toHaveURL")).toBeLessThan(afterEach.indexOf("await page.reload()"));
    expect(
      recoveryFunctions("manual-sync-recovery.spec.ts", ["hydratedChannelForm"]).hydratedChannelForm.toString(),
    ).toContain("/account/channels.data");
  });
  it("preserves the exact primary failure after all cleanup, including reporting failure", async () => {
    const { withOwnedRecoveryCleanup } = recoveryFunctions("manual-sync-recovery.spec.ts", [
      "withOwnedRecoveryCleanup",
    ]);
    const primary = new Error("primary");
    const calls: string[] = [];
    await expect(
      withOwnedRecoveryCleanup(
        async () => {
          throw primary;
        },
        [
          async () => {
            calls.push("run");
            throw new Error("secondary");
          },
          async () => {
            calls.push("listing");
            throw new Error("secondary");
          },
          async () => {
            calls.push("connection");
          },
        ],
        (count: number) => {
          calls.push(`record:${count}`);
          throw new Error("reporting");
        },
      ),
    ).rejects.toBe(primary);
    expect(calls).toEqual(["run", "listing", "connection", "record:2"]);
  });
  it("fails cleanup-only errors, runs later cleanup and accepts complete success", async () => {
    const { withOwnedRecoveryCleanup } = recoveryFunctions("manual-sync-recovery.spec.ts", [
      "withOwnedRecoveryCleanup",
    ]);
    const later = vi.fn(async () => {});
    const record = vi.fn();
    await expect(
      withOwnedRecoveryCleanup(
        async () => {},
        [
          async () => {
            throw new Error("cleanup");
          },
          later,
        ],
        record,
      ),
    ).rejects.toThrow("owned-recovery-cleanup-failed");
    expect(later).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(1);
    await expect(withOwnedRecoveryCleanup(async () => {}, [later], record)).resolves.toBeUndefined();
  });
  it.each(["manual-sync-recovery.spec.ts", "channel-connection-connect.spec.ts"])(
    "%s sends receipt headers and retries only transient projection failures",
    async (file) => {
      const receipt = {
        observedAtMs: Date.now(),
        sources: [{ sourceContextName: "inventory", maxGlobalPosition: "1", eventIds: ["evt_owned"] }],
      };
      const body = { listing_id: "lst_owned", inventory_item_id: "itm_owned" };
      const pollExpect = Object.assign((value: unknown, message?: string) => expect(value, message), {
        poll: (probe: () => Promise<boolean>) => ({
          toBe: async (expected: boolean) => {
            for (let attempt = 0; attempt < 3; attempt++) {
              if ((await probe()) === expected) return;
            }
            throw new Error("projection poll exhausted");
          },
        }),
      });
      const names =
        file === "manual-sync-recovery.spec.ts"
          ? ["readFreshListing", "responseJson"]
          : ["readFreshListing", "successfulJson", "marketplaceFreshReadHeaders", "capturePendingProjections"];
      const { readFreshListing } = recoveryFunctions(file, names, { expect: pollExpect });
      const response = (status: number, value: unknown) => ({
        ok: () => status === 200,
        status: () => status,
        json: async () => value,
        headers: () => ({ "content-type": "application/json" }),
        url: () => "http://localhost/listing",
        text: async () => JSON.stringify(value),
      });
      const get = vi.fn();
      const page = { url: () => "http://localhost/account", request: { get } };
      const capture = { data: { freshnessReads: [] } };
      const accepts = (value: typeof body) =>
        value.listing_id === body.listing_id && value.inventory_item_id === body.inventory_item_id;
      const input = {
        id: "itm_owned",
        commandReceipt: { mode: "eventual", commitPositions: receipt.sources, commitEventIds: ["evt_owned"] },
      };
      const invoke = () =>
        file === "manual-sync-recovery.spec.ts"
          ? readFreshListing(page, "/api/marketplace/account/listings/lst_owned", input, accepts)
          : readFreshListing(page, "/api/marketplace/account/listings/lst_owned", input, capture, accepts);
      get
        .mockResolvedValueOnce(response(503, { error: { code: "projection_freshness_timeout" } }))
        .mockResolvedValueOnce(response(200, body));
      await expect(invoke()).resolves.toMatchObject(body);
      expect(get).toHaveBeenCalledTimes(2);
      for (const [url, options] of get.mock.calls) {
        expect(responses.readFreshWriteToken(url)).toMatchObject({ sources: receipt.sources });
        expect(
          responses.readFreshWriteToken(
            `http://localhost/?afterWrite=${options.headers[responses.CHASE_SETS_READ_AFTER_WRITE_HEADER]}`,
          ),
        ).toMatchObject({ sources: receipt.sources });
        expect(options.headers[responses.CHASE_SETS_READ_TARGET_CONTEXT_HEADER]).toBe("marketplace");
      }
      for (const refused of [
        response(403, { error: { code: "authorization_forbidden" } }),
        response(200, { ...body, inventory_item_id: "itm_foreign" }),
      ]) {
        get.mockReset().mockResolvedValue(refused);
        await expect(invoke()).rejects.toThrow();
        expect(get).toHaveBeenCalledOnce();
      }
      get.mockReset().mockRejectedValue(new Error("network"));
      await expect(invoke()).rejects.toThrow("network");
      expect(get).toHaveBeenCalledOnce();
    },
  );
});
function child() {
  const value = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  h.spawn.mockReturnValue(value);
  return value;
}
function finish(value: ReturnType<typeof child>, code: number | null = 0) {
  value.emit("exit", code);
  value.emit("close", code);
}
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("finite manual-sync recovery transport", () => {
  it("spawns only the known Node facade, writes metadata only to stdin, and awaits exit AND close", async () => {
    vi.stubEnv("UNRELATED_PRIVATE_VALUE", "private-marker-environment");
    const value = child();
    const received: Buffer[] = [];
    value.stdin.on("data", (chunk) => received.push(chunk));
    const result = createManualSyncBrowserRecovery(fixture, metadata);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    expect(h.spawn).toHaveBeenCalledOnce();
    expect(h.spawn.mock.calls[0]!.slice(0, 2)).toEqual([
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(root, "bounded-contexts/channels/support/seed-support/manual-sync-browser.ts"),
        "--owned-recovery-stdin",
      ],
    ]);
    const options = h.spawn.mock.calls[0]![2];
    expect(options.cwd).toBe(root);
    expect(options.shell).toBe(false);
    expect(Object.keys(options.env).every((key) => ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"].includes(key))).toBe(
      true,
    );
    expect(JSON.stringify(h.spawn.mock.calls)).not.toContain("private-marker");
    expect(JSON.parse(Buffer.concat(received).toString())).toEqual({
      version: 1,
      fixture,
      databases: { channels: metadata.channelsDatabaseUrl, catalog: metadata.catalogDatabaseUrl },
    });
    expect(value.stdin.writableEnded).toBe(true);
    value.stdout.write(JSON.stringify(receipt()));
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    value.emit("exit", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    value.emit("close", 0);
    await expect(result).resolves.toEqual(receipt());
    expect(value.stdin.destroyed).toBe(true);
  });
  it("refuses skipped/external-server mode and oversized input before any spawn", async () => {
    vi.stubEnv("PLAYWRIGHT_SKIP_WEB_SERVER", "true");
    await expect(createManualSyncBrowserRecovery(fixture, metadata)).rejects.toThrow("owned-recovery-child-failed");
    vi.stubEnv("PLAYWRIGHT_SKIP_WEB_SERVER", "false");
    await expect(
      createManualSyncBrowserRecovery(fixture, { ...metadata, channelsDatabaseUrl: "x".repeat(8193) }),
    ).rejects.toThrow("owned-recovery-child-failed");
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("accepts a complete receipt at the stdout cap and rejects input cap+1", async () => {
    const value = child();
    const result = createManualSyncBrowserRecovery(fixture, metadata);
    const bytes = Buffer.from(JSON.stringify(receipt()));
    value.stdout.write(Buffer.concat([bytes, Buffer.alloc(2048 - bytes.length, 32)]));
    finish(value);
    await expect(result).resolves.toEqual(receipt());
  });
  it.each([
    "",
    "{",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...receipt(), extra: true }),
    JSON.stringify({ ...receipt(), version: 2 }),
    JSON.stringify({ ...receipt(), ownershipId: "foreign" }),
    JSON.stringify({ ...receipt(), connectionId: "chn_foreign" }),
    JSON.stringify({ ...receipt(), listingId: "lst_foreign" }),
    JSON.stringify({ ...receipt(), runId: "run_foreign" }),
    JSON.stringify({ ...receipt(), runRevision: 1 }),
    JSON.stringify({ ...receipt(), runRevision: "0" }),
    JSON.stringify(receipt()) + "{}",
  ])("refuses partial/extra/unbound receipts without serializing their contents %#", async (output) => {
    const value = child();
    const result = createManualSyncBrowserRecovery(fixture, metadata);
    value.stdout.write(output);
    finish(value);
    await expect(result).rejects.toThrow("owned-recovery-child-failed");
  });
  it.each([
    "nonzero",
    "signal",
    "close-first",
    "spawn-error",
    "stdin-error",
    "stdout-error",
    "stderr-error",
    "stdin-end-throw",
    "stdout-cap",
    "stderr-cap",
    "stderr",
    "repeated",
    "utf8",
  ])("fails closed for %s with marker-free serialized errors", async (kind) => {
    const value = child();
    if (kind === "stdin-end-throw")
      vi.spyOn(value.stdin, "end").mockImplementationOnce(() => {
        throw new Error("private-marker");
      });
    const result = createManualSyncBrowserRecovery(fixture, metadata);
    value.stdout.write(JSON.stringify(receipt()));
    if (kind === "stdout-cap")
      value.stdout.write(Buffer.alloc(2049 - Buffer.byteLength(JSON.stringify(receipt())), 32));
    if (kind === "stderr-cap") value.stderr.write(Buffer.alloc(2049));
    if (kind === "stderr") value.stderr.write("private-marker postgres://private-marker");
    if (kind === "repeated") for (let i = 0; i < 20; i++) value.stdout.write(Buffer.alloc(1024, 120));
    if (kind === "utf8") value.stdout.write(Buffer.from([255]));
    if (kind === "spawn-error") value.emit("error", new Error("private-marker"));
    if (kind === "stdin-error") value.stdin.emit("error", new Error("private-marker"));
    if (kind === "stdout-error") value.stdout.emit("error", new Error("private-marker"));
    if (kind === "stderr-error") value.stderr.emit("error", new Error("private-marker"));
    if (kind === "close-first") value.emit("close", 0);
    else finish(value, kind === "signal" ? null : kind === "nonzero" ? 1 : 0);
    const error = await result.catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected owned recovery transport refusal");
    expect(error.message).toBe("owned-recovery-child-failed");
    expect(JSON.stringify({ message: error.message, stack: error.stack, ...error })).not.toContain("private-marker");
    expect(value.stdin.destroyed).toBe(true);
  });
  it("does not expose synchronous spawn errors", async () => {
    h.spawn.mockImplementation(() => {
      throw new Error("private-marker");
    });
    await expect(createManualSyncBrowserRecovery(fixture, metadata)).rejects.toThrow("owned-recovery-child-failed");
  });
  it("keeps browser collection context-free and native prerequisites before the bridge", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../e2e/manual-sync-recovery.spec.ts");
    const source = readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const runtimeContextImports = ast.statements
      .filter(ts.isImportDeclaration)
      .filter(
        (node) =>
          !node.importClause?.isTypeOnly &&
          /@chase-sets\/(channels|marketplace|inventory)(?:\/|$)/.test((node.moduleSpecifier as ts.StringLiteral).text),
      );
    expect(runtimeContextImports).toEqual([]);
    expect(source.indexOf("await signInThroughMarketplaceForm")).toBeLessThan(
      source.indexOf("await createManualSyncBrowserRecovery"),
    );
    expect(source.indexOf('name: "Activate"')).toBeLessThan(source.indexOf("await createManualSyncBrowserRecovery"));
    expect(source.indexOf("await recoveryListing")).toBeLessThan(
      source.indexOf("await createManualSyncBrowserRecovery"),
    );
    const helper = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../e2e/support/manual-sync-recovery.ts"),
      "utf8",
    );
    expect(helper).not.toMatch(/from ["']@chase-sets\//);
    expect(helper).not.toMatch(/\.kill\(|process\.kill|\.evaluate\(|\.attach\(|console\./);
  });
});
