export type Consent = Readonly<{
  consent_id: string;
  subject_type: string;
  user_id: string | null;
  account_id: string | null;
  policy_key: string;
  policy_version: string;
  status: "recorded" | "withdrawn";
  recorded_at: string;
  withdrawn_at: string | null;
  updated_at: string;
  is_current: boolean;
}>;
