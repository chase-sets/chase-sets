export const providerSendSchemaSql = [
  `CREATE TABLE IF NOT EXISTS catalog_provider_send_windows (
    window_id text PRIMARY KEY,
    actor text NOT NULL,
    armed_at timestamptz NOT NULL,
    members jsonb NOT NULL,
    policy jsonb NOT NULL,
    phase text NOT NULL DEFAULT 'preflight' CHECK (phase IN ('preflight','pass')),
    pass integer NOT NULL DEFAULT 0 CHECK (pass BETWEEN 0 AND 9),
    state text NOT NULL DEFAULT 'armed' CHECK (state IN ('armed','terminal')),
    used integer NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND 246000),
    refusal text NULL,
    terminated_at timestamptz NULL,
    CHECK ((phase = 'preflight' AND pass = 0) OR (phase = 'pass' AND pass BETWEEN 1 AND 9))
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS catalog_provider_send_one_armed_idx
    ON catalog_provider_send_windows (state) WHERE state = 'armed';`,
  `CREATE TABLE IF NOT EXISTS catalog_provider_send_authority (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
    window_id text NULL REFERENCES catalog_provider_send_windows(window_id)
  );`,
  `INSERT INTO catalog_provider_send_authority (singleton, window_id)
    SELECT true, NULL WHERE NOT EXISTS (SELECT 1 FROM catalog_provider_send_windows) ON CONFLICT DO NOTHING;`,
  `CREATE TABLE IF NOT EXISTS catalog_provider_send_quotas (
    window_id text NOT NULL REFERENCES catalog_provider_send_windows(window_id),
    pass integer NOT NULL CHECK (pass BETWEEN 0 AND 9),
    bucket text NOT NULL,
    quota integer NOT NULL CHECK (quota > 0),
    used integer NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= quota),
    PRIMARY KEY (window_id, pass, bucket)
  );`,
  `CREATE TABLE IF NOT EXISTS catalog_provider_send_attempts (
    window_id text NOT NULL REFERENCES catalog_provider_send_windows(window_id),
    sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 246000),
    phase text NOT NULL CHECK (phase IN ('preflight','pass')),
    pass integer NOT NULL,
    bucket text NOT NULL,
    provider text NOT NULL,
    category text NOT NULL,
    admitted_at timestamptz NOT NULL,
    settled_at timestamptz NULL,
    PRIMARY KEY (window_id, sequence),
    FOREIGN KEY (window_id, pass, bucket) REFERENCES catalog_provider_send_quotas(window_id, pass, bucket)
  );`,
  `CREATE INDEX IF NOT EXISTS catalog_provider_send_attempts_outstanding_idx
    ON catalog_provider_send_attempts(window_id) WHERE settled_at IS NULL;`,
  `CREATE TABLE IF NOT EXISTS catalog_provider_send_job_bindings (
    job_id text PRIMARY KEY,
    window_id text NULL REFERENCES catalog_provider_send_windows(window_id),
    phase text NULL,
    pass integer NULL,
    CHECK ((window_id IS NULL AND phase IS NULL AND pass IS NULL) OR
      (window_id IS NOT NULL AND ((phase = 'preflight' AND pass = 0) OR (phase = 'pass' AND pass BETWEEN 1 AND 9))))
  );`,
  `CREATE OR REPLACE FUNCTION catalog_provider_send_retain_identity() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'provider-send-ledger-retained'; END IF;
    IF TG_TABLE_NAME = 'catalog_provider_send_windows' THEN
      IF NEW.window_id <> OLD.window_id OR NEW.actor <> OLD.actor OR NEW.armed_at <> OLD.armed_at OR
         NEW.members <> OLD.members OR NEW.policy <> OLD.policy OR NEW.used < OLD.used OR
         NEW.pass < OLD.pass OR NEW.pass > OLD.pass + 1 OR (OLD.state = 'terminal' AND NEW.state <> 'terminal') THEN
        RAISE EXCEPTION 'provider-send-window-identity-immutable';
      END IF;
    ELSIF TG_TABLE_NAME = 'catalog_provider_send_quotas' THEN
      IF NEW.window_id <> OLD.window_id OR NEW.pass <> OLD.pass OR NEW.bucket <> OLD.bucket OR
         NEW.quota <> OLD.quota OR NEW.used <> OLD.used + 1 THEN
        RAISE EXCEPTION 'provider-send-quota-immutable';
      END IF;
    ELSIF TG_TABLE_NAME = 'catalog_provider_send_job_bindings' THEN
      RAISE EXCEPTION 'provider-send-job-binding-immutable';
    ELSIF TG_TABLE_NAME = 'catalog_provider_send_attempts' THEN
      IF (to_jsonb(NEW) - 'settled_at') <> (to_jsonb(OLD) - 'settled_at') OR
         (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
        RAISE EXCEPTION 'provider-send-attempt-retained';
      END IF;
    END IF;
    RETURN NEW;
  END $$;`,
  ...["windows", "quotas", "job_bindings", "attempts"].map(
    (suffix) => `
    DROP TRIGGER IF EXISTS catalog_provider_send_${suffix}_retain_identity ON catalog_provider_send_${suffix};
    CREATE TRIGGER catalog_provider_send_${suffix}_retain_identity BEFORE UPDATE OR DELETE ON catalog_provider_send_${suffix}
      FOR EACH ROW EXECUTE FUNCTION catalog_provider_send_retain_identity();`,
  ),
];
