export interface OrderingCartLine {
  buyer_account_id: string;
  line_id: string;
  catalog_item_id: string;
  item_title: string;
  item_subtitle: string | null;
  version_selection: readonly { dimensionId: string; choiceId: string }[];
  version_summary: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}
