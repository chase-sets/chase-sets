export type Consent = Readonly<{
  consent_id: string;
  subject_type: string;
  user_id: string | null;
  account_id: string | null;
  policy_key: string;
  policy_version: string;
  recorded_at: string;
  updated_at: string;
}>;
