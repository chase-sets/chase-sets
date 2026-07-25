import type { Context } from "hono";
import type { PgQueryable as MissingPgQueryable } from "@chase-sets/event-core-postgres/missing-contract";
import type { PgQueryable as SchemaPgQueryable } from "@chase-sets/event-core-postgres/schema";
import type { PgQueryable as SubpathPgQueryable } from "@chase-sets/event-core-postgres/types";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PgQueryable as UnresolvedPgQueryable } from "./missing-types";
import type { PgQueryable as VendorPgQueryable } from "./vendor/infrastructure/event-core-postgres/types";
import type { Root as DeepRoot } from "./proof-depth/root";
import type { CycleA } from "./proof-cycle/a";

type Cache = Readonly<{
  query: (key: string) => Promise<unknown>;
}>;

type Services = Readonly<{
  db: SubpathPgQueryable;
}>;

type StructuralServices = Readonly<{
  db: {
    query: (text: string) => Promise<unknown>;
  };
}>;

declare function buildCacheKey(prefix: string, accountId: string): string;

export async function p12(pool: PgTransactionalPool) {
  const db = pool as PgQueryable;
  await db.query("P12");
}

export async function p17(db: SubpathPgQueryable) {
  await db.query("P17");
}

export async function p18(db: NonNullable<Services["db"]>) {
  await db.query("P18");
}

export async function n1(cache: Cache) {
  await cache.query("SELECT:last-viewed");
}

export async function n2(cache: Cache, accountId: string) {
  await cache.query(buildCacheKey("SELECT", accountId));
}

export function n3(c: Context) {
  return c.req.query("id");
}

export function n4() {
  return (c) => c.req.query("id");
}

export async function n5({ db }) {
  await db.query("N5");
}

export async function n6(db: VendorPgQueryable) {
  await db.query("N6");
}

export async function n7(db: MissingPgQueryable) {
  await db.query("N7");
}

export async function n8(db: SchemaPgQueryable) {
  await db.query("N8");
}

export async function n9(db: UnresolvedPgQueryable) {
  await db.query("N9");
}

export async function n10(root: { a: { b: { c: { db: SubpathPgQueryable } } } }) {
  await root.a.b.c.db.query("N10");
}

export async function n11Depth(root: DeepRoot) {
  await root.a.b.c.query("N11-depth");
}

export async function n11Cycle(root: CycleA) {
  await root.db.query("N11-cycle");
}

export async function n12(cache: Cache) {
  // SELECT * FROM definitely_not_a_database
  await cache.query("INSERT:cache-key");
}

export async function n15(db: NonNullable<StructuralServices["db"]>) {
  await db.query("N15");
}
