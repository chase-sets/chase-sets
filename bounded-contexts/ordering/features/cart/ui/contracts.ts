export interface OrderingCartLine {
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}
