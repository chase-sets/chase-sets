export type Membership = Readonly<{
  membership_id: string;
  user_id: string;
  account_id: string;
  role_key: string;
  status: string;
  updated_at: string;
}>;
