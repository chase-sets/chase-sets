#!/usr/bin/env node
import pg from "pg";

const { Client } = pg;

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...valueParts] = arg.replace(/^--/, "").split("=");
    return [key, valueParts.join("=")];
  }),
);

const databaseUrl = args.get("database-url") ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL or --database-url is required.");
  process.exit(1);
}

const eventTypes = readCsv(args.get("event-types"));
const streamPrefixes = readCsv(args.get("stream-prefixes"));
const afterGlobalPosition = args.get("after") ?? "0";
const limit = Number(args.get("limit") ?? "500");

if (!Number.isSafeInteger(limit) || limit <= 0) {
  console.error("--limit must be a positive safe integer.");
  process.exit(1);
}

const { sql, params } = buildExplainQuery({
  afterGlobalPosition,
  eventTypes,
  streamPrefixes,
  limit,
});

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const result = await client.query(sql, params);
  console.log(result.rows.map((row) => row["QUERY PLAN"]).join("\n"));
} finally {
  await client.end();
}

function buildExplainQuery(input) {
  const params = [input.afterGlobalPosition, input.limit];
  const predicates = ["global_position > $1::bigint"];

  if (input.eventTypes.length > 0) {
    params.push(input.eventTypes);
    predicates.push(`event_type = ANY($${params.length}::text[])`);
  }

  if (input.streamPrefixes.length > 0) {
    const streamPrefixFilter = buildStreamPrefixFilterSql(input.streamPrefixes, params.length + 1);
    params.push(...streamPrefixFilter.params);
    predicates.push(streamPrefixFilter.predicate);
  }

  return {
    sql: `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT event_id, stream_id, stream_version, event_type, payload, metadata, global_position, recorded_at
FROM event_store_events
WHERE ${predicates.join("\n  AND ")}
ORDER BY global_position ASC
LIMIT $2`,
    params,
  };
}

function readCsv(value) {
  return value
    ? [
        ...new Set(
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function buildStreamPrefixFilterSql(streamPrefixes, nextParamIndex) {
  const params = [];
  const predicates = [...new Set(streamPrefixes)].map((prefix) => {
    const contextName = normalizedStreamPrefixContextName(prefix);
    if (contextName) {
      const contextParam = nextParamIndex + params.length;
      params.push(contextName);
      const prefixParam = nextParamIndex + params.length;
      params.push(escapeLikePattern(prefix));
      return `(stream_context_name = $${contextParam} AND stream_id LIKE $${prefixParam} || '%' ESCAPE '\\')`;
    }

    const prefixParam = nextParamIndex + params.length;
    params.push(escapeLikePattern(prefix));
    return `(stream_id LIKE $${prefixParam} || '%' ESCAPE '\\')`;
  });

  return {
    predicate: `(${predicates.join(" OR ")})`,
    params,
  };
}

function normalizedStreamPrefixContextName(prefix) {
  const separatorIndex = prefix.indexOf(".");
  return separatorIndex > 0 ? prefix.slice(0, separatorIndex) : null;
}

function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}
