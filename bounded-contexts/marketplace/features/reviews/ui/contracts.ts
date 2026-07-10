export interface ReviewListItem {
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

export interface ReviewDetail extends ReviewListItem {}

export interface ReviewOpportunity {
  order_id: string;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  eligible_at: string;
  active_review_id: string | null;
}

export interface ReviewSummary {
  account_id: string;
  account_display_name: string | null;
  average_rating_as_seller: string | null;
  review_count_as_seller: number;
  rating_1_count_as_seller: number;
  rating_2_count_as_seller: number;
  rating_3_count_as_seller: number;
  rating_4_count_as_seller: number;
  rating_5_count_as_seller: number;
  average_rating_as_buyer: string | null;
  review_count_as_buyer: number;
  rating_1_count_as_buyer: number;
  rating_2_count_as_buyer: number;
  rating_3_count_as_buyer: number;
  rating_4_count_as_buyer: number;
  rating_5_count_as_buyer: number;
  updated_at: string | null;
}
