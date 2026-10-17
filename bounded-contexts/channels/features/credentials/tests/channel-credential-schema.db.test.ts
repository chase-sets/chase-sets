import { describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as channels } from "../../../index";
import { createChannelCredentialRuntime } from "../api/runtime";
import { channelCredentialSchemaMigrations, channelCredentialSchemaSql } from "../read-model/schema";
import { credentialDatabase } from "./db-support";
import { at, binding, payload, keyring } from "./fixtures";

describe("Channel credential schema convergence", () => {
  const fresh = credentialDatabase("fresh", false);
  const upgrade = credentialDatabase("upgrade", false);
  it("converges empty and predecessor schemas; two boots preserve custody bytes", async () => {
    const predecessor = {
      ...channels,
      schemaSql: channels.schemaSql.replace(channelCredentialSchemaSql, ""),
      schemaMigrations: channels.schemaMigrations?.filter(
        (migration) => !channelCredentialSchemaMigrations.some((next) => next.migrationId === migration.migrationId),
      ),
    };
    await bootstrapContextDatabase(predecessor, upgrade());
    expect((await upgrade().query("SELECT to_regclass('channels_connection_credentials') AS name")).rows).toEqual([
      { name: null },
    ]);
    await bootstrapContextDatabase(channels, fresh());
    await bootstrapContextDatabase(channels, upgrade());
    const schema = (db: ReturnType<typeof fresh>) =>
      db.query(
        "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='channels_connection_credentials' ORDER BY ordinal_position",
      );
    expect((await schema(fresh())).rows).toEqual((await schema(upgrade())).rows);
    const constraints = (db: ReturnType<typeof fresh>) =>
      db.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='channels_connection_credentials'::regclass ORDER BY definition",
      );
    expect((await constraints(fresh())).rows).toEqual((await constraints(upgrade())).rows);
    const store = createChannelCredentialRuntime(keyring());
    const row = await store.create(upgrade(), binding, payload, at);
    const before = (await upgrade().query("SELECT * FROM channels_connection_credentials WHERE row_id=$1", [row.rowId]))
      .rows;
    await bootstrapContextDatabase(channels, upgrade());
    await bootstrapContextDatabase(channels, upgrade());
    expect(
      (await upgrade().query("SELECT * FROM channels_connection_credentials WHERE row_id=$1", [row.rowId])).rows,
    ).toEqual(before);
    expect(await store.readMetadata(upgrade(), row.rowId)).toEqual(row);
  });
});
