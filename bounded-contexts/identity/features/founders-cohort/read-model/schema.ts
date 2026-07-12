export const identityFoundersCohortSchemaSql = `CREATE TABLE IF NOT EXISTS identity_founder_claims (
  account_id text PRIMARY KEY,
  founder_number integer NOT NULL UNIQUE CHECK (founder_number BETWEEN 1 AND 500),
  qualifying_act_type text NOT NULL CHECK (qualifying_act_type IN ('listing-created', 'offer-submitted')),
  qualifying_act_id text NOT NULL,
  claimed_at timestamptz NOT NULL,
  last_stream_version bigint NOT NULL CHECK (last_stream_version > 0)
);`;
