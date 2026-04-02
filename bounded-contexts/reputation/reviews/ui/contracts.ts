export interface ReputationReviewListItem {
  review_id: string;
  order_id: string;
  author_account_id: string;
  author_display_name: string | null;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  rating: number;
  feedback: string | null;
  status: string;
  submitted_at: string;
  updated_at: string;
  withdrawn_at: string | null;
}

export interface ReputationReviewDetail extends ReputationReviewListItem {}

export interface ReputationAccountSummary {
  account_id: string;
  account_display_name: string | null;
  average_rating: string | null;
  review_count: number;
  rating_1_count: number;
  rating_2_count: number;
  rating_3_count: number;
  rating_4_count: number;
  rating_5_count: number;
  updated_at: string | null;
}
