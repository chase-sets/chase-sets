export interface ReviewListItem {
  review_id: string;
  order_id: string;
  author_account_id: string;
  author_display_name: string | null;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  // Double-blind reveal (m108): null when the row is redacted for the
  // subject's own "received reviews" view of a not-yet-revealed review.
  rating: number | null;
  feedback: string | null;
  status: string;
  submitted_at: string;
  updated_at: string;
  withdrawn_at: string | null;
  revealed_at: string | null;
  reveal_reason: string | null;
  // Moderation (m108).
  withdrawn_by_actor_type: string | null;
  moderation_operator_user_id: string | null;
  moderation_reason: string | null;
  feedback_redacted_at: string | null;
  // Subject reply: one threaded, moderatable response per review.
  reply_id: string | null;
  reply_feedback: string | null;
  reply_status: string | null;
  reply_submitted_at: string | null;
  reply_withdrawn_at: string | null;
}

export interface ReviewDetail extends ReviewListItem {}

export interface ReviewOpportunity {
  order_id: string;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  eligible_at: string;
  active_review_id: string | null;
  // Double-blind reveal (m108): true once the submission window has
  // elapsed with no review submitted yet.
  window_expired: boolean;
  window_expires_at: string;
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
