// A private attempt binding, not a projection. An acknowledged no-op has a
// binding too, so retries cannot submit a report when the target becomes active.
export const identityAccountProfileReportSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_account_profile_report_attempts (
  attempt_key text PRIMARY KEY,
  request_digest text NOT NULL
);`;
