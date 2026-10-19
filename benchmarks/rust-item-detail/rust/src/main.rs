//! Rust port of the Discovery item-detail and category read routes.
//! Mirrors bounded-contexts/discovery/features/{item-detail,categories}: same SQL,
//! same query order, same JSON normalization, same node-pg type mapping.

use std::{collections::HashSet, env, net::SocketAddr};

use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::{header::CONTENT_TYPE, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use redis::{aio::ConnectionManager, AsyncCommands};
use tokio_postgres::{types::Type, NoTls, Row};

/// Optional Redis cache-aside for public GETs (benchmark variant). Same key, TTL and
/// rules as the Node harness: only 200 responses are cached; Redis errors fall through.
#[derive(Clone)]
struct Cache {
    conn: ConnectionManager,
    ttl: u64,
}

async fn cache_layer(State(cache): State<Option<Cache>>, req: Request, next: Next) -> Response {
    let Some(cache) = cache else { return next.run(req).await };
    let key = format!("rb:{}", req.uri().path_and_query().map(|p| p.as_str()).unwrap_or(""));
    let mut conn = cache.conn.clone();
    if let Ok(Some(hit)) = conn.get::<_, Option<Vec<u8>>>(&key).await {
        return ([(CONTENT_TYPE, "application/json"), (axum::http::header::HeaderName::from_static("x-cache"), "hit")], hit).into_response();
    }
    let res = next.run(req).await;
    if res.status() != StatusCode::OK {
        return res;
    }
    let (mut parts, body) = res.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let _: Result<(), _> = conn.set_ex(&key, bytes.as_ref(), cache.ttl).await;
    parts.headers.insert("x-cache", HeaderValue::from_static("miss"));
    Response::from_parts(parts, Body::from(bytes))
}

const MARKET_ROW_LIMIT: u32 = 25;

fn listing_quantity_sql(l: &str) -> String {
    format!(
        "LEAST(\n {l}.quantity_cap,\n GREATEST(\n COALESCE({l}.supply_total_quantity, {l}.quantity_cap) - COALESCE({l}.active_held_quantity, 0),\n 0\n )\n )"
    )
}

fn listing_predicate_sql(l: &str, a: &str) -> String {
    format!(
        "{l}.status = 'active'\n AND {a}.status = 'active'\n AND {l}.price_currency_code IS NOT NULL\n AND {l}.listing_stream_version > 0\n AND {a}.seller_listing_availability_status = 'available'\n AND {l}.product_measure_snapshot IS NOT NULL\n AND {q} > 0",
        q = listing_quantity_sql(l)
    )
}

fn offer_predicate_sql(o: &str, a: &str) -> String {
    format!(
        "{o}.status = 'submitted'\n AND {o}.price_currency_code IS NOT NULL\n AND {o}.offer_stream_version > 0\n AND {a}.status = 'active'"
    )
}

struct Sql {
    page: String,
    summary: String,
    listings: String,
    offers: String,
    contents: String,
    included_in: String,
    categories_by_slug: &'static str,
}

fn build_sql() -> Sql {
    let page = r#"SELECT
       page.catalog_item_id, page.slug, page.language_code, page.title_i18n, page.title,
       page.subtitle_i18n, page.subtitle, page.display_badges, page.description_i18n,
       page.description, page.blueprint_id, page.blueprint, page.status, page.field_values,
       page.categories, page.tags, page.image_urls, page.product_asset_sets, page.image_fallback,
       page.product_schema, page.updated_at::text AS updated_at
     FROM (
       SELECT * FROM discovery_item_detail_pages WHERE catalog_item_id = $1
       UNION ALL
       SELECT * FROM discovery_item_detail_pages WHERE slug = $1 AND slug <> ''
       UNION ALL
       SELECT target.* FROM discovery_slug_redirects AS redirect
       JOIN discovery_item_detail_pages AS target ON target.catalog_item_id = redirect.entity_id
       WHERE redirect.entity_kind = 'item' AND redirect.slug = $1
       UNION ALL
       SELECT target.* FROM discovery_slug_redirects AS redirect
       JOIN discovery_item_detail_pages AS target ON target.slug = redirect.target_slug AND target.slug <> ''
       WHERE redirect.entity_kind = 'item' AND redirect.slug = $1
     ) AS page
     ORDER BY
       (page.slug = $1) DESC,
       (page.catalog_item_id = $1) DESC
     LIMIT 1"#
        .to_string();

    let summary = format!(
        r#"WITH startable_listing AS (
       SELECT listing.price_amount, listing.price_currency_code, {q} AS visible_quantity
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_catalog_item_id = $1
         AND {p}
     )
     SELECT
       CASE WHEN COUNT(DISTINCT price_currency_code) = 1
         THEN MIN(price_amount::numeric)::text ELSE NULL END AS lowest_price_amount,
       CASE WHEN COUNT(DISTINCT price_currency_code) = 1
         THEN MIN(price_currency_code) ELSE NULL END AS lowest_price_currency_code,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(visible_quantity), 0)::integer AS total_visible_quantity
     FROM startable_listing
     WHERE visible_quantity > 0"#,
        q = listing_quantity_sql("listing"),
        p = listing_predicate_sql("listing", "account")
    );

    let listings = format!(
        r#"WITH startable_listing AS (
       SELECT
         listing.listing_id, listing.listing_slug, listing.product_slug, listing.account_id,
         listing.inventory_item_id, listing.catalog_catalog_item_id, listing.product_id,
         listing.item_title, listing.item_subtitle, listing.selected_options, listing.product_summary,
         listing.graded_card, listing.storage_location_name, listing.ship_from_code,
         listing.price_amount, listing.price_currency_code, listing.listing_stream_version,
         listing.shipping_allowance_percentage_bps, listing.quantity_cap, listing.max_units_per_order,
         listing.max_units_per_day, listing.max_units_per_customer_account, listing.status,
         account.seller_slug, account.seller_display_name,
         account.average_rating_as_seller::text AS seller_average_rating,
         COALESCE(account.rating_count_as_seller, 0)::integer AS seller_review_count,
         COALESCE(account.badges, '[]'::jsonb) AS seller_badges,
         account.founder_number AS seller_founder_number,
         COALESCE(account.seller_at_capacity, false) AS seller_at_capacity,
         {q} AS visible_quantity,
         listing.created_at::text AS created_at,
         listing.updated_at::text AS updated_at
       FROM discovery_market_listings AS listing
       LEFT JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_catalog_item_id = $1
         AND {p}
     )
     SELECT
       listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id,
       product_id, item_title, item_subtitle, selected_options, product_summary, graded_card,
       storage_location_name, ship_from_code, price_amount, price_currency_code, listing_stream_version,
       shipping_allowance_percentage_bps, quantity_cap, max_units_per_order, max_units_per_day,
       max_units_per_customer_account, status, seller_slug, seller_display_name, seller_average_rating,
       seller_review_count, seller_badges, seller_at_capacity, visible_quantity, created_at, updated_at
     FROM startable_listing
     WHERE visible_quantity > 0
     ORDER BY price_currency_code ASC, price_amount::numeric ASC, updated_at DESC, listing_id ASC
     LIMIT {MARKET_ROW_LIMIT}"#,
        q = listing_quantity_sql("listing"),
        p = listing_predicate_sql("listing", "account")
    );

    let offers = format!(
        r#"SELECT
       offer.offer_id, offer.buyer_account_id, offer.catalog_catalog_item_id, offer.product_id,
       offer.item_title, offer.item_subtitle, offer.selected_options, offer.product_summary,
       offer.price_amount, offer.price_currency_code, offer.offer_stream_version,
       offer.quantity_requested, offer.status, offer.accepted_seller_account_id,
       offer.accepted_at::text AS accepted_at,
       account.seller_slug AS buyer_slug,
       account.seller_display_name AS buyer_display_name,
       account.average_rating_as_buyer::text AS buyer_average_rating,
       COALESCE(account.rating_count_as_buyer, 0)::integer AS buyer_review_count,
       offer.created_at::text AS created_at,
       offer.updated_at::text AS updated_at
     FROM discovery_offer_demand_matches AS offer
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = offer.buyer_account_id
     WHERE offer.catalog_catalog_item_id = $1
       AND {p}
     ORDER BY
       offer.price_currency_code ASC,
       offer.price_amount::numeric DESC,
       offer.quantity_requested DESC,
       offer.created_at ASC,
       offer.offer_id ASC
     LIMIT {MARKET_ROW_LIMIT}"#,
        p = offer_predicate_sql("offer", "account")
    );

    let contents_sql = |predicate: &str| {
        format!(
            r#"SELECT
       line.line_id, line.container_catalog_item_id, line.container_selected_options, line.container_product_id,
       container.slug AS container_slug, container.title AS container_title,
       container.subtitle AS container_subtitle, container.status AS container_status,
       container.image_urls AS container_image_urls, container.product_asset_sets AS container_product_asset_sets,
       container.image_fallback AS container_image_fallback,
       line.contained_catalog_item_id, line.contained_selected_options, line.contained_product_id,
       contained.slug AS contained_slug, contained.title AS contained_title,
       contained.subtitle AS contained_subtitle, contained.status AS contained_status,
       contained.image_urls AS contained_image_urls, contained.product_asset_sets AS contained_product_asset_sets,
       contained.image_fallback AS contained_image_fallback,
       line.quantity, line.content_type_id, line.content_type_display_name, line.inclusion_policy_id,
       line.inclusion_policy_display_name, line.resolution_status, line.target_lifecycle_status,
       line.updated_at::text AS updated_at
     FROM discovery_item_detail_product_contents AS line
     LEFT JOIN discovery_item_detail_pages AS container
       ON container.catalog_item_id = line.container_catalog_item_id
     LEFT JOIN discovery_item_detail_pages AS contained
       ON contained.catalog_item_id = line.contained_catalog_item_id
     WHERE {predicate}
     ORDER BY line.content_type_id ASC, line.line_id ASC"#
        )
    };

    Sql {
        page,
        summary,
        listings,
        offers,
        contents: contents_sql("line.container_catalog_item_id = $1"),
        included_in: contents_sql("line.contained_catalog_item_id = $1"),
        categories_by_slug: r#"SELECT category.*
     FROM discovery_categories AS category
     LEFT JOIN discovery_slug_redirects AS redirect
       ON redirect.entity_kind = 'category'
      AND redirect.slug = $1
     WHERE category.slug = $1
        OR category.category_id = $1
        OR category.category_id = redirect.entity_id
        OR category.slug = redirect.target_slug
     ORDER BY
       (category.slug = $1) DESC,
       (category.category_id = $1) DESC
     LIMIT 1"#,
    }
}

#[derive(Clone)]
struct AppState {
    pool: Pool,
    sql: &'static Sql,
}

#[derive(Debug)]
struct AppError(String);

impl<E: std::fmt::Display> From<E> for AppError {
    fn from(error: E) -> Self {
        AppError(error.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        eprintln!("request failed: {}", self.0);
        (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
    }
}

/// node-pg type mapping: text/numeric/int8 as strings, int4 as numbers,
/// json/jsonb parsed, timestamptz as JSON-serialized Date (ISO, ms, UTC).
fn cell(row: &Row, index: usize) -> Result<Value, tokio_postgres::Error> {
    let ty = row.columns()[index].type_();
    Ok(match *ty {
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => {
            row.try_get::<_, Option<String>>(index)?.map(Value::String).unwrap_or(Value::Null)
        }
        Type::INT4 => row.try_get::<_, Option<i32>>(index)?.map(Value::from).unwrap_or(Value::Null),
        Type::INT2 => row.try_get::<_, Option<i16>>(index)?.map(Value::from).unwrap_or(Value::Null),
        Type::INT8 => row
            .try_get::<_, Option<i64>>(index)?
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        Type::FLOAT8 => row.try_get::<_, Option<f64>>(index)?.map(Value::from).unwrap_or(Value::Null),
        Type::BOOL => row.try_get::<_, Option<bool>>(index)?.map(Value::Bool).unwrap_or(Value::Null),
        Type::JSON | Type::JSONB => row.try_get::<_, Option<Value>>(index)?.unwrap_or(Value::Null),
        Type::TIMESTAMPTZ => row
            .try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(index)?
            .map(|v| Value::String(v.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()))
            .unwrap_or(Value::Null),
        _ => panic!("unmapped column type {ty} for {}", row.columns()[index].name()),
    })
}

fn row_object(row: &Row) -> Result<Map<String, Value>, tokio_postgres::Error> {
    let mut object = Map::with_capacity(row.len());
    for (index, column) in row.columns().iter().enumerate() {
        object.insert(column.name().to_string(), cell(row, index)?);
    }
    Ok(object)
}

fn as_array(value: Value) -> Value {
    if value.is_array() {
        value
    } else {
        Value::Array(Vec::new())
    }
}

fn normalize_string_array(value: Value) -> Value {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    if let Value::Array(entries) = value {
        for entry in entries {
            if let Value::String(text) = entry {
                if seen.insert(text.clone()) {
                    out.push(Value::String(text));
                }
            }
        }
    }
    Value::Array(out)
}

/// JavaScript `String(value)` for the scalar shapes the projection writes.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(entries) => entries.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn normalize_category_refs(value: Value) -> Value {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    if let Value::Array(entries) = value {
        for entry in entries {
            let Value::Object(entry) = entry else { continue };
            let category_id = match entry.get("categoryId") {
                None | Some(Value::Null) => String::new(),
                Some(id) => js_string(id),
            };
            if category_id.is_empty() || !seen.insert(category_id.clone()) {
                continue;
            }
            let field = |name: &str| match entry.get(name) {
                None | Some(Value::Null) => category_id.clone(),
                Some(found) => js_string(found),
            };
            out.push(json!({ "categoryId": category_id, "slug": field("slug"), "name": field("name") }));
        }
    }
    Value::Array(out)
}

fn normalize_locale_key(locale: &str) -> String {
    let trimmed = locale.trim();
    let mut parts = trimmed.split('-');
    let language = parts.next().unwrap_or("").to_lowercase();
    let mut normalized = vec![language];
    for (index, part) in parts.enumerate() {
        normalized.push(if index == 0 && part.len() == 4 {
            let mut chars = part.chars();
            let first = chars.next().map(|c| c.to_uppercase().to_string()).unwrap_or_default();
            first + &chars.as_str().to_lowercase()
        } else if part.len() == 2 {
            part.to_uppercase()
        } else {
            part.to_lowercase()
        });
    }
    normalized.join("-")
}

/// resolveLocalizedTextMap(coerceLocalizedTextMap(value)) for the default locale.
fn resolve_localized_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Object(map) => {
            let Some(Value::Object(values)) = map.get("values") else { return String::new() };
            let mut entries: Vec<(String, String)> = values
                .iter()
                .filter_map(|(locale, text)| match text {
                    Value::String(text) if !text.trim().is_empty() => {
                        Some((normalize_locale_key(locale), text.trim().to_string()))
                    }
                    _ => None,
                })
                .collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            entries.into_iter().filter(|(locale, _)| locale == "en").last().map(|(_, text)| text).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn is_js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn nullable_selected_options(value: Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::Array(entries) => Value::Array(
            entries
                .into_iter()
                .map(|entry| {
                    let mut out = Map::new();
                    if let Value::Object(entry) = entry {
                        for key in ["dimensionId", "optionId"] {
                            if let Some(found) = entry.get(key) {
                                out.insert(key.to_string(), found.clone());
                            }
                        }
                    }
                    Value::Object(out)
                })
                .collect(),
        ),
        _ => Value::Array(Vec::new()),
    }
}

fn content_item_ref(row: &mut Map<String, Value>, prefix: &str) -> Value {
    let mut take = |name: &str| row.remove(&format!("{prefix}_{name}")).unwrap_or(Value::Null);
    let catalog_item_id = take("catalog_item_id");
    let slug = take("slug");
    let title = take("title");
    let subtitle = take("subtitle");
    let status = take("status");
    let image_urls = take("image_urls");
    let product_asset_sets = take("product_asset_sets");
    let image_fallback = take("image_fallback");
    if [&catalog_item_id, &slug, &title, &status].iter().any(|v| !is_js_truthy(v)) {
        return Value::Null;
    }
    json!({
        "catalog_item_id": catalog_item_id,
        "slug": slug,
        "title": title,
        "subtitle": subtitle,
        "status": status,
        "image_urls": normalize_string_array(image_urls),
        "product_asset_sets": as_array(product_asset_sets),
        "image_fallback": if image_fallback.is_object() || image_fallback.is_array() { image_fallback } else { Value::Null },
    })
}

fn content_line(row: &Row) -> Result<Value, tokio_postgres::Error> {
    let mut raw = row_object(row)?;
    let container_catalog_item_id = raw.get("container_catalog_item_id").cloned().unwrap_or(Value::Null);
    let contained_catalog_item_id = raw.get("contained_catalog_item_id").cloned().unwrap_or(Value::Null);
    // Keep the id columns for the refs while building them.
    raw.insert("container_catalog_item_id".into(), container_catalog_item_id.clone());
    let container_item = content_item_ref(&mut raw, "container");
    raw.insert("contained_catalog_item_id".into(), contained_catalog_item_id.clone());
    let contained_item = content_item_ref(&mut raw, "contained");
    let mut take = |name: &str| raw.remove(name).unwrap_or(Value::Null);
    let inclusion_display = take("inclusion_policy_display_name");
    Ok(json!({
        "line_id": take("line_id"),
        "container_catalog_item_id": container_catalog_item_id,
        "container_selected_options": nullable_selected_options(take("container_selected_options")),
        "container_product_id": take("container_product_id"),
        "container_item": container_item,
        "contained_catalog_item_id": contained_catalog_item_id,
        "contained_selected_options": nullable_selected_options(take("contained_selected_options")),
        "contained_product_id": take("contained_product_id"),
        "contained_item": contained_item,
        "quantity": take("quantity"),
        "content_type_id": take("content_type_id"),
        "content_type_label": resolve_localized_text(&take("content_type_display_name")),
        "inclusion_policy_id": take("inclusion_policy_id"),
        "inclusion_policy_label": if is_js_truthy(&inclusion_display) { Value::String(resolve_localized_text(&inclusion_display)) } else { Value::Null },
        "resolution_status": take("resolution_status"),
        "target_lifecycle_status": take("target_lifecycle_status"),
        "updated_at": take("updated_at"),
    }))
}

fn with_selected_options(row: &Row) -> Result<Value, tokio_postgres::Error> {
    let mut object = row_object(row)?;
    let options = object.remove("selected_options").unwrap_or(Value::Null);
    object.insert("selected_options".into(), as_array(options));
    Ok(Value::Object(object))
}

fn not_found(message: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": { "code": "not_found", "message": message } }))).into_response()
}

async fn item_detail(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response, AppError> {
    // Mirror node-pg Pool.query: each statement checks out its own pooled
    // connection; the two product-content reads run concurrently on two.
    let sql = state.sql;
    let pool = &state.pool;
    let page = pool.get().await?.query_typed(&sql.page, &[(&id, Type::TEXT)]).await?;
    let Some(page) = page.first() else {
        return Ok(not_found("Item not found."));
    };
    let mut item = row_object(page)?;
    let item_id = item.get("catalog_item_id").and_then(Value::as_str).unwrap_or_default().to_string();
    let params: [(&(dyn tokio_postgres::types::ToSql + Sync), Type); 1] = [(&item_id, Type::TEXT)];

    let summary = pool.get().await?.query_typed(&sql.summary, &params).await?;
    let listings = pool.get().await?.query_typed(&sql.listings, &params).await?;
    let offers = pool.get().await?.query_typed(&sql.offers, &params).await?;
    let (contents, included_in) = tokio::try_join!(
        async { Ok::<_, AppError>(pool.get().await?.query_typed(&sql.contents, &params).await?) },
        async { Ok::<_, AppError>(pool.get().await?.query_typed(&sql.included_in, &params).await?) },
    )?;

    let market_summary = match summary.first() {
        Some(row) if row.try_get::<_, i32>("active_listing_count")? > 0 => Value::Object(row_object(row)?),
        _ => Value::Null,
    };

    for key in ["display_badges", "product_asset_sets"] {
        let value = item.remove(key).unwrap_or(Value::Null);
        item.insert(key.into(), as_array(value));
    }
    let categories = item.remove("categories").unwrap_or(Value::Null);
    item.insert("categories".into(), normalize_category_refs(categories));
    for key in ["tags", "image_urls"] {
        let value = item.remove(key).unwrap_or(Value::Null);
        item.insert(key.into(), normalize_string_array(value));
    }
    item.insert("market_summary".into(), market_summary);
    item.insert("market_listings".into(), listings.iter().map(with_selected_options).collect::<Result<_, _>>()?);
    item.insert("offer_demand_matches".into(), offers.iter().map(with_selected_options).collect::<Result<_, _>>()?);
    item.insert("contents".into(), contents.iter().map(content_line).collect::<Result<_, _>>()?);
    item.insert("included_in".into(), included_in.iter().map(content_line).collect::<Result<_, _>>()?);

    Ok(Json(Value::Object(item)).into_response())
}

#[derive(Deserialize)]
struct CategoryQuery {
    #[serde(rename = "parentCategoryId")]
    parent_category_id: Option<String>,
    status: Option<String>,
}

async fn list_categories(State(state): State<AppState>, Query(query): Query<CategoryQuery>) -> Result<Response, AppError> {
    let client = state.pool.get().await?;
    let status = query.status.filter(|s| !s.is_empty()).unwrap_or_else(|| "active".to_string());
    let parent = query.parent_category_id.filter(|s| !s.is_empty());
    let rows = match &parent {
        Some(parent) => {
            client
                .query_typed(
                    "SELECT * FROM discovery_categories WHERE status = $1 AND parent_category_id = $2 ORDER BY display_order ASC",
                    &[(&status, Type::TEXT), (parent, Type::TEXT)],
                )
                .await?
        }
        None => {
            client
                .query_typed(
                    "SELECT * FROM discovery_categories WHERE status = $1 ORDER BY display_order ASC",
                    &[(&status, Type::TEXT)],
                )
                .await?
        }
    };
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        if row.try_get::<_, i32>("item_count")? > 0 {
            items.push(Value::Object(row_object(row)?));
        }
    }
    let count = items.len();
    Ok(Json(json!({ "items": items, "total": count, "count": count })).into_response())
}

async fn category_by_slug(State(state): State<AppState>, Path(slug): Path<String>) -> Result<Response, AppError> {
    let client = state.pool.get().await?;
    let rows = client.query_typed(state.sql.categories_by_slug, &[(&slug, Type::TEXT)]).await?;
    match rows.first() {
        Some(row) if row.try_get::<_, i32>("item_count")? > 0 => Ok(Json(Value::Object(row_object(row)?)).into_response()),
        _ => Ok(not_found("Category not found.")),
    }
}

#[tokio::main]
async fn main() {
    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://postgres:postgres@localhost:55432/postgres".to_string());
    let pool_max: usize = env::var("POOL_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    let pg_config: tokio_postgres::Config = database_url.parse().expect("valid DATABASE_URL");
    let manager = Manager::from_config(pg_config, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
    let pool = Pool::builder(manager).max_size(pool_max).build().expect("pool");
    let sql: &'static Sql = Box::leak(Box::new(build_sql()));
    let state = AppState { pool, sql };
    let cache = match env::var("REDIS_URL") {
        Ok(url) => {
            let client = redis::Client::open(url).expect("valid REDIS_URL");
            let conn = ConnectionManager::new(client).await.expect("redis connect");
            let ttl = env::var("CACHE_TTL_SECONDS").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
            Some(Cache { conn, ttl })
        }
        Err(_) => None,
    };

    let app = Router::new()
        .route("/health/live", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/discovery/items/{id}", get(item_detail))
        .route("/api/discovery/categories", get(list_categories))
        .route("/api/discovery/categories/", get(list_categories))
        .route("/api/discovery/categories/{slug}", get(category_by_slug))
        .with_state(state)
        .layer(middleware::from_fn_with_state(cache, cache_layer));

    let port: u16 = env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await.expect("bind");
    println!("rust item-detail bench listening on {port}");
    axum::serve(listener, app).await.expect("serve");
}
