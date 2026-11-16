import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  discoverOwnerWriters,
  enrollmentErrors,
  ownerWriterSourcePaths,
  ownerWriterSources,
} from "./owner-writer-enrollment-census.mjs";

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "scripts/check-structure/owner-writer-enrollment.json"), "utf8"),
);
const sourcePaths = ownerWriterSourcePaths();
const sourceScopes = Map.groupBy(sourcePaths, (file) => file.split("/").slice(0, 2).join("/"));
describe("owner writer enrollment census", () => {
  it("discovers stock streams through aliases, computed appends and SQL dataflow and rejects an unenrolled writer", () => {
    expect(manifest.owners).toContain("inventory");
    expect(manifest.keys).toContain("stock/<accountId>/<inventoryItemId>");
    for (const source of [
      'const stream = "inventory.item-" + itemId; const payload = {streamId: stream}; const sink = store.appendToStreams; sink([payload]);',
      'const method = "appendToStream"; store[method]({streamId: `inventory.channel-stock-allocation-${itemId}`});',
      "const statement = \"INSERT INTO event_store_events (stream_id) VALUES (\\'inventory.item-foreign\\')\"; const execute = db.query; execute(statement);",
    ]) {
      const planted = discoverOwnerWriters({ "packages/arbitrary/generated.ts": source });
      expect(planted.length).toBeGreaterThan(0);
      expect(planted.some((row) => row.keys.includes("stock"))).toBe(true);
      expect(enrollmentErrors(planted, manifest).some((error) => error.startsWith("UNKNOWN writer"))).toBe(true);
      const omitStockClassification = discoverOwnerWriters(
        { "packages/arbitrary/generated.ts": source },
        { mutant: "omit-stock-classification" },
      );
      expect(
        enrollmentErrors(omitStockClassification, manifest).some((error) => error.startsWith("UNKNOWN writer")),
      ).toBe(false);
    }
  });
  it.each([...sourceScopes])("closes every append, handler and SQL writer in %s", (_scope, files) => {
    const selected = new Set(files);
    expect(
      enrollmentErrors(discoverOwnerWriters(ownerWriterSources(files)), {
        writers: manifest.writers.filter((writer) => selected.has(writer.file)),
      }),
    ).toEqual([]);
  });
  it("covers every manifest writer in the complete discovered source inventory", () => {
    expect(manifest.writers.filter((writer) => !sourcePaths.includes(writer.file))).toEqual([]);
  });
  it("enrolls the linked-platform principal admitted with listings.manage and every physical delegation SQL writer", () => {
    expect(manifest.keys).toContain("delegation/<delegationId>");
    const writers = manifest.writers.filter((row) => row.sink === "delegation SQL");
    expect(writers.map((row) => row.symbol.split(" > ").at(-1)).sort()).toEqual([
      "advance",
      "grant",
      "revokeAuthorization",
      "revokeToken",
      "rotateRefreshToken",
    ]);
    expect(writers.every((row) => row.disposition === "enrolled" && row.keys.includes("delegation"))).toBe(true);
  });
  it("discovers Session streams, physical SQL tokens and projection-only Session writers", () => {
    expect(manifest.owners).toContain("auth");
    expect(manifest.keys).toContain("session/<sessionId>");
    const tokens = manifest.writers.filter((row) => row.sink === "session SQL");
    expect(tokens.map((row) => row.symbol)).toContain("upsertSessionToken");
    expect(tokens.every((row) => row.disposition === "enrolled")).toBe(true);
    const projections = manifest.writers.filter(
      (row) => row.file === "bounded-contexts/auth/features/sessions/read-model/projection.ts",
    );
    expect(projections.length).toBeGreaterThan(0);
    expect(projections.every((row) => row.disposition === "excluded" && row.foldTest)).toBe(true);
  });
  it("binds every enrollment and exclusion to an existing source symbol and executable proof", () => {
    for (const row of manifest.writers) {
      const [sourcePath, sourceSymbol] = (row.enrollment ?? row.sourceSymbol).split("::");
      const code = readFileSync(path.join(repoRoot, sourcePath), "utf8");
      for (const symbol of sourceSymbol.split(" > ")) expect(code).toContain(symbol);
      if (row.foldTest) {
        const [testPath, title] = row.foldTest.split("::");
        expect(readFileSync(path.join(repoRoot, testPath), "utf8")).toContain(title);
      }
    }
    const fence = readFileSync(
      path.join(repoRoot, "bounded-contexts/identity/features/account-management/api/fences.ts"),
      "utf8",
    );
    expect(fence.indexOf("await ownerEpochs.enroll(client, inputs)")).toBeLessThan(
      fence.indexOf("return store.appendToStreamsInTransaction(client, inputs)"),
    );
  });
  it("closes Connection handlers, the installed disconnect transaction and bootstrap without treating health as seller status", () => {
    expect(manifest.owners).toContain("channels");
    expect(manifest.keys).toContain("connection/<connectionId>");
    expect(manifest.consumedFields.connection).toEqual([
      "accountId",
      "providerKey",
      "environment",
      "status",
      "version",
    ]);
    const installed = manifest.writers.find(
      (row) =>
        row.file === "bounded-contexts/channels/features/connector-feed/api/runtime.ts" &&
        row.symbol.endsWith(" > disconnect"),
    );
    expect(installed).toMatchObject({ disposition: "enrolled", keys: ["connection"] });
    expect(installed.enrollment).toContain("createConnectorFeedRuntime > transact");
    const deletion = manifest.writers.find(
      (row) => row.sink === "deps.connectorFeed.disconnectChannelConnectionInTransaction",
    );
    expect(deletion).toMatchObject({ disposition: "enrolled", keys: ["connection"] });
    expect(deletion.enrollment).toContain("createEbayAccountDeletionConsumer > consume");
    const callback = manifest.writers.find(
      (row) => row.file === "bounded-contexts/channels/features/ebay-connection/api/runtime.ts",
    );
    expect(callback).toMatchObject({ disposition: "enrolled", keys: ["connection"] });
    expect(callback.enrollment).toContain("createEbayConnectionRuntime > callback");
    const callbackSource = readFileSync(
      path.join(repoRoot, "bounded-contexts/channels/features/ebay-connection/api/runtime.ts"),
      "utf8",
    );
    const enrollment = "return connectionEpochs.transaction([creationKey]";
    expect(callbackSource).toContain("const creationKey = `connection/${attempt.candidate_connection_id}`");
    expect(callbackSource).toContain(enrollment);
    expect(callbackSource.indexOf(enrollment)).toBeLessThan(
      callbackSource.indexOf("await deps.eventStore.appendToStreamInTransaction(db"),
    );
    const setupFile = "bounded-contexts/channels/features/ebay-connection/api/setup-runtime.ts";
    const setupWriters = manifest.writers.filter((row) => row.file === setupFile);
    expect(setupWriters).toHaveLength(3);
    expect(setupWriters.every((row) => row.disposition === "enrolled")).toBe(true);
    const setupSource = readFileSync(path.join(repoRoot, setupFile), "utf8");
    const setupEnrollment = "return epochs.transaction([`connection/${target.connectionId}`]";
    expect(setupSource).toContain(setupEnrollment);
    for (const sink of ["deps.eventStore.appendToStreamInTransaction(db", "connections.activateChannelConnection("])
      expect(setupSource.indexOf(setupEnrollment)).toBeLessThan(setupSource.indexOf(sink));
    const seed = manifest.writers.find(
      (row) =>
        row.file === "bounded-contexts/channels/features/manual-sync/api/seed.ts" && row.keys.includes("connection"),
    );
    expect(seed).toMatchObject({ disposition: "enrolled" });
    for (const feature of ["connection-health", "connection-attention", "credentials", "ebay-account-deletion"]) {
      const rows = manifest.writers.filter(
        (row) => row.file.startsWith(`bounded-contexts/channels/features/${feature}/`) && row !== deletion,
      );
      expect(rows.length, feature).toBeGreaterThan(0);
      expect(
        rows.every((row) => row.disposition === "excluded" && row.foldTest),
        feature,
      ).toBe(true);
    }
  });
  it.each([
    "function planted() { return store.appendToStreamInTransaction(db, { streamId: 'channels.connection-' + id, events: disconnectEvents }); }",
    "const hidden = 'channels.' + 'connection-' + id; const save = store.appendToStreams; function callback() { return save([{streamId: hidden, events}]); }",
    "function planted() { return deps.disconnectChannelConnection(input, context); }",
    "function planted() { return db.query('UPDATE channel_connections SET status = $1 WHERE connection_id = $2', [status, id]); }",
    "function callback() { return receiptQuery(db, 'INSERT INTO channels_ebay_account_deletion_receipts (notification_id) VALUES ($1)', [id]); }",
    "function refresh() { return query(db, 'UPDATE channels_connection_credentials SET token_generation=$1', [generation]); }",
  ])(
    "rejects planted unenrolled Connection writers, callbacks and wrapped SQL outside the connections path",
    (code) => {
      const sites = discoverOwnerWriters({ "packages/innocent/provider-callback.ts": code });
      expect(sites).toHaveLength(1);
      expect(sites[0].keys).toContain("connection");
      expect(enrollmentErrors(sites, { writers: [] })).toEqual([expect.stringContaining("UNKNOWN writer")]);
    },
  );
  it.each([
    `const hidden = 'identity.account-' + id; function planted() { return store.appendToStream({ streamId: hidden, events }); }`,
    `const hidden = 'identity.user-' + id; function planted() { return renamed.appendToStreams([{ streamId: hidden, events }]); }`,
    `const save = store.appendToStream; const hidden = 'identity.account-' + id; function planted() { return save({streamId: hidden, events}); }`,
    `const hidden = 'identity.' + 'account-' + id; function planted() { return store.appendToStream({streamId: hidden, events}); }`,
    "const table = 'event_store_events'; const hidden = 'identity.user-' + id; function planted() { return db.query(`INSERT INTO ${table} (stream_id) VALUES ($1)`, [hidden]); }",
    `function planted() { return db.query('INSERT INTO event_store_events (stream_id) VALUES ($1)', ['identity.membership-' + id]); }`,
    `function planted() { return db.query('UPDATE event_store_events SET payload = $1 WHERE stream_id = $2', [payload, 'identity.account-' + id]); }`,
    `const query = 'unrelated'; function planted() { return db.query('INSERT INTO event_store_events (stream_id) VALUES ($1)', ['identity.user-' + id]); }`,
    `const append = 'unrelated'; function planted() { return store.append({streamId: 'identity.membership-' + id, events}); }`,
    `const a = 'qu'; const b = 'ery'; const method = a + b; function planted() { return db[method]('INSERT INTO event_store_events (stream_id) VALUES ($1)', ['identity.account-' + id]); }`,
    `const method = 'qu' + 'ery'; const save = db[method]; function planted() { return save('INSERT INTO event_store_events (stream_id) VALUES ($1)', ['identity.user-' + id]); }`,
    `function planted() { return db.query('UPDATE identity_linked_platform_authorizations SET status = $1 WHERE authorization_id = $2', ['revoked', id]); }`,
    `const table = 'identity_linked_platform_authorizations'; function planted() { return db.query('INSERT INTO ' + table + ' (authorization_id) VALUES ($1)', [id]); }`,
    `function planted() { return db.query('DELETE FROM identity_linked_platform_authorizations WHERE authorization_id = $1', [id]); }`,
    `function planted() { return db.query('UPDATE identity_session_tokens SET token_hash = $1 WHERE session_id = $2', [hash, id]); }`,
    `const table = 'identity_session_tokens'; const method = 'qu' + 'ery'; const save = db[method]; function planted() { return save('INSERT INTO ' + table + ' (session_id) VALUES ($1)', [id]); }`,
    `function planted() { return db.query('DELETE FROM identity_session_tokens WHERE session_id = $1', [id]); }`,
    `const hidden = 'auth.' + 'session-' + id; function planted() { return store.appendToStream({ streamId: hidden, events }); }`,
    `function planted() { return db.query('UPDATE identity_sessions SET user_id = $1 WHERE session_id = $2', [user, id]); }`,
    `function planted() { return db.query('TRUNCATE TABLE identity_session_tokens'); }`,
    `const table = 'identity_session_tokens'; const save = db.query.bind(db); function planted() { return save('DELETE FROM ' + table + ' WHERE session_id = $1', [id]); }`,
  ])("rejects a planted unenrolled physical writer regardless of path vocabulary", (code) => {
    const sites = discoverOwnerWriters({ "packages/innocent/adapter.ts": code });
    expect(sites).toHaveLength(1);
    expect(enrollmentErrors(sites, { writers: [] })[0]).toContain("UNKNOWN writer");
  });
  it("requires source symbols and fold proof for exclusions", () => {
    const site = { file: "x.ts", symbol: "x", sink: "store.appendToStream", keys: ["account"] };
    expect(enrollmentErrors([site], { writers: [{ ...site, disposition: "excluded" }] })).toEqual([
      expect.stringContaining("unproven exclusion"),
    ]);
  });
  it("does not classify a read-only event-store dependency as an event-store mutation", () => {
    const code = `function upsertSecret() {
      return db.query('WITH owner AS (SELECT current_version FROM event_store_streams FOR UPDATE) INSERT INTO identity_api_key_secrets SELECT * FROM owner');
    }`;
    expect(discoverOwnerWriters({ "bounded-contexts/identity/features/api-keys/api/secret-store.ts": code })).toEqual(
      [],
    );
  });
  it("does not classify a read-only delegation dependency as a delegation mutation", () => {
    const code = `function remember() {
      return db.query('INSERT INTO identity_audit SELECT * FROM identity_linked_platform_authorizations');
    }`;
    expect(discoverOwnerWriters({ "bounded-contexts/identity/support/audit.ts": code })).toEqual([]);
  });
});
