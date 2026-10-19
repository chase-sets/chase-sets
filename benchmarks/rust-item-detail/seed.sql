-- Synthetic but shape-faithful Discovery read-model data for the item-detail benchmark.
-- Sizes: 50k item pages, 2k accounts, 150k listings (power-law skew toward popular items),
-- 30k buy offers, 20k sealed-product content lines, 300 categories, 5k slug redirects.
SELECT setseed(0.42);
TRUNCATE discovery_item_detail_pages, discovery_market_accounts, discovery_market_listings,
  discovery_offer_demand_matches, discovery_item_detail_product_contents, discovery_categories,
  discovery_slug_redirects;

INSERT INTO discovery_categories (category_id, key, slug, name, description, status, parent_category_id, display_order, item_count)
SELECT 'cat_' || g, 'cat-' || g, 'category-' || g, 'Category ' || g, 'Cards and sealed product for category ' || g,
       'active', CASE WHEN g > 20 THEN 'cat_' || (g % 20 + 1) END, g, (random() * 500)::int
FROM generate_series(1, 300) g;

INSERT INTO discovery_item_detail_pages (catalog_item_id, slug, language_code, title_i18n, title, subtitle_i18n, subtitle,
  display_badges, description_i18n, description, blueprint_id, blueprint, status, field_values, categories, tags,
  image_urls, product_asset_sets, image_fallback, product_schema, updated_at)
SELECT
  'item_' || g,
  'card-name-' || g || '-set-' || (g % 400),
  'en',
  jsonb_build_object('defaultLocale','en','values', jsonb_build_object('en','Card Name ' || g, 'ja', 'カード ' || g)),
  'Card Name ' || g,
  jsonb_build_object('defaultLocale','en','values', jsonb_build_object('en','Set ' || (g % 400))),
  'Set ' || (g % 400),
  jsonb_build_array(jsonb_build_object('kind','set-code','label','S' || (g % 400)), jsonb_build_object('kind','number','label', (g % 250) || '/250'), jsonb_build_object('kind','rarity','label','Rare')),
  jsonb_build_object('defaultLocale','en','values', jsonb_build_object('en', repeat('Flavor and rules text for this card. ', 8))),
  repeat('Flavor and rules text for this card. ', 8),
  'bp_' || (g % 12),
  jsonb_build_object('blueprintId','bp_' || (g % 12), 'name','Trading Card'),
  'active',
  (SELECT jsonb_agg(jsonb_build_object('fieldId','field_' || f, 'fieldName','Field ' || f, 'value', 'value-' || g || '-' || f, 'reference', CASE WHEN f % 3 = 0 THEN jsonb_build_object('referenceRecordId','ref_' || f, 'typeKey','artist', 'key','artist-' || f, 'name','Artist ' || f) END)) FROM generate_series(1, 10) f),
  jsonb_build_array(jsonb_build_object('categoryId','cat_' || (g % 300 + 1), 'slug','category-' || (g % 300 + 1), 'name','Category ' || (g % 300 + 1)), jsonb_build_object('categoryId','cat_' || (g % 20 + 1), 'slug','category-' || (g % 20 + 1), 'name','Category ' || (g % 20 + 1))),
  jsonb_build_array('tcg','single','set-' || (g % 400)),
  jsonb_build_array('https://cdn.chasesets.com/catalog/' || g || '/front.webp', 'https://cdn.chasesets.com/catalog/' || g || '/back.webp'),
  jsonb_build_array(jsonb_build_object('kind','product-image','sourceHash', md5(g::text),
     'source', jsonb_build_object('url','https://cdn.chasesets.com/catalog/' || g || '/src.png','width',1200,'height',1680,'format','png'),
     'variants', (SELECT jsonb_agg(jsonb_build_object('url','https://cdn.chasesets.com/catalog/' || g || '/' || w || '.webp','width',w,'height',(w*1.4)::int,'format','webp')) FROM unnest(array[160,320,640,960]) w))),
  NULL,
  jsonb_build_object('canonicalDimensionOrder', (SELECT jsonb_agg(jsonb_build_object('dimensionId','dim_' || d,'dimensionName','Dimension ' || d)) FROM generate_series(1,3) d),
     'dimensions', (SELECT jsonb_agg(jsonb_build_object('dimensionId','dim_' || d,'dimensionName','Dimension ' || d,'valueKind','unordered',
        'choices', (SELECT jsonb_agg(jsonb_build_object('optionId','opt_' || d || '_' || o,'code','c' || o,'label','Option ' || o,'displayOrder',o)) FROM generate_series(1,5) o))) FROM generate_series(1,3) d)),
  now() - (g || ' minutes')::interval
FROM generate_series(1, 50000) g;

INSERT INTO discovery_market_accounts (account_id, seller_slug, seller_display_name, status, seller_listing_availability_status,
  seller_at_capacity, average_rating_as_seller, rating_count_as_seller, average_rating_as_buyer, rating_count_as_buyer, badges, founder_number)
SELECT 'acct_' || g, 'seller-' || g, 'Seller ' || g,
       CASE WHEN random() < 0.97 THEN 'active' ELSE 'suspended' END,
       CASE WHEN random() < 0.95 THEN 'available' ELSE 'vacation' END,
       random() < 0.02, round((3.5 + random() * 1.5)::numeric, 2), (random() * 400)::int,
       round((3.5 + random() * 1.5)::numeric, 2), (random() * 100)::int,
       CASE WHEN g % 10 = 0 THEN '["founder","fast-shipper"]'::jsonb ELSE '[]'::jsonb END,
       CASE WHEN g % 10 = 0 THEN g END
FROM generate_series(1, 2000) g;

INSERT INTO discovery_market_listings (listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id,
  product_id, item_title, item_subtitle, selected_options, product_summary, product_measure_snapshot, graded_card,
  storage_location_name, ship_from_code, price_amount, price_currency_code, listing_stream_version, quantity_cap,
  max_units_per_order, supply_total_quantity, active_held_quantity, status, created_at, updated_at)
SELECT 'lst_' || g, 'listing-' || g, 'product-' || item, 'acct_' || (1 + (random() * 1999)::int), 'inv_' || g, 'item_' || item,
  'prod_' || item || '_' || (g % 3), 'Card Name ' || item, 'Set ' || (item % 400),
  jsonb_build_array(jsonb_build_object('dimensionId','dim_1','optionId','opt_1_' || (1 + g % 5)), jsonb_build_object('dimensionId','dim_2','optionId','opt_2_' || (1 + g % 3))),
  'Near Mint, English',
  jsonb_build_object('weightGrams', 3, 'lengthMm', 88, 'widthMm', 63, 'thicknessMm', 1),
  CASE WHEN g % 15 = 0 THEN jsonb_build_object('grader','PSA','grade','10','certificationNumber', (10000000 + g)::text) END,
  'Main shelf', 'US-TX',
  to_char(0.25 + random() * 200, 'FM999990.00'), 'USD', 1 + (random() * 5)::int,
  1 + (random() * 8)::int, CASE WHEN g % 4 = 0 THEN 4 END,
  CASE WHEN random() < 0.9 THEN 1 + (random() * 8)::int ELSE 0 END, (random() * 1)::int,
  CASE WHEN random() < 0.9 THEN 'active' ELSE 'paused' END,
  now() - random() * interval '90 days', now() - random() * interval '30 days'
FROM (SELECT g, 1 + floor(49999 * power(random(), 3))::int AS item FROM generate_series(1, 150000) g) s;

INSERT INTO discovery_offer_demand_matches (offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title, item_subtitle,
  selected_options, product_summary, price_amount, price_currency_code, offer_stream_version, quantity_requested, status, created_at, updated_at)
SELECT 'off_' || g, 'acct_' || (1 + (random() * 1999)::int), 'item_' || item, 'prod_' || item || '_0', 'Card Name ' || item, 'Set ' || (item % 400),
  jsonb_build_array(jsonb_build_object('dimensionId','dim_1','optionId','opt_1_1')), 'Near Mint, English',
  to_char(0.10 + random() * 150, 'FM999990.00'), 'USD', 1, 1 + (random() * 4)::int,
  CASE WHEN random() < 0.85 THEN 'submitted' ELSE 'withdrawn' END,
  now() - random() * interval '60 days', now() - random() * interval '10 days'
FROM (SELECT g, 1 + floor(49999 * power(random(), 3))::int AS item FROM generate_series(1, 30000) g) s;

-- Sealed products are items 1..2000; each contains 10 lines pointing at single cards.
INSERT INTO discovery_item_detail_product_contents (line_id, container_catalog_item_id, container_selected_options, container_product_id,
  contained_catalog_item_id, contained_selected_options, contained_product_id, quantity, content_type_id, content_type_display_name,
  inclusion_policy_id, inclusion_policy_display_name, provenance, resolution_status, resolved_fact_hash)
SELECT 'line_' || c || '_' || l, 'item_' || c, NULL, NULL, 'item_' || (2000 + ((c * 10 + l) % 48000)), NULL, NULL, 1 + l % 3,
  CASE WHEN l % 2 = 0 THEN 'guaranteed' ELSE 'random-pack' END,
  jsonb_build_object('defaultLocale','en','values', jsonb_build_object('en', CASE WHEN l % 2 = 0 THEN 'Guaranteed' ELSE 'Random pack' END)),
  CASE WHEN l % 2 = 1 THEN 'policy_random' END,
  CASE WHEN l % 2 = 1 THEN jsonb_build_object('defaultLocale','en','values', jsonb_build_object('en','One per pack')) END,
  '{"source":"seed"}'::jsonb, 'resolved', md5(c || '-' || l)
FROM generate_series(1, 2000) c, generate_series(1, 10) l;

INSERT INTO discovery_slug_redirects (entity_kind, slug, entity_id, target_slug)
SELECT 'item', 'old-card-slug-' || g, 'item_' || g, 'card-name-' || g || '-set-' || (g % 400) FROM generate_series(1, 5000) g;

ANALYZE;
