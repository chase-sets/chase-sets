export type Invitation = Readonly<{
  invitation_id: string;
  account_id: string;
  email: string;
  role_key: string;
  status: string;
  expires_at: string;
  accepted_by_user_id: string | null;
  updated_at: string;
}>;
