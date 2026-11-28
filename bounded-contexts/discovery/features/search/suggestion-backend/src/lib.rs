mod query;

use std::collections::HashSet;

pub use query::Vocabulary;
use query::{QueryPlan, SuggestionQuery};
use serde::Serialize;
use tokio_postgres::GenericClient;

const SERVED_SET_CODES: &str = "
    SELECT candidate.set_code FROM unnest($1::text[]) AS candidate(set_code)
    WHERE EXISTS (SELECT 1 FROM discovery_search_items AS item WHERE item.set_code = candidate.set_code)";

const SUGGESTIONS: &str = "
    SELECT catalog_item_id, title, subtitle, slug,
           CASE WHEN jsonb_array_length(category_names) > 0 THEN category_names ->> 0 ELSE NULL END AS category
    FROM discovery_search_items
    WHERE status = $1
      AND (search_text @@ to_tsquery('english', $2) OR search_text_simple @@ to_tsquery('simple', $3))
    ORDER BY (ts_rank(search_text, to_tsquery('english', $2)) + ts_rank(search_text_simple, to_tsquery('simple', $3))) DESC,
             title ASC, catalog_item_id ASC
    LIMIT $4";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub catalog_item_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub slug: String,
    pub category: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Suggestions {
    pub items: Vec<Suggestion>,
    pub count: usize,
}

/// The existing GET route accepts the first `q` and `limit` query values.
/// The host still owns routing, policy resolution, and error translation.
pub async fn get_suggestions(
    db: &impl GenericClient,
    uri: &http::Uri,
    vocabulary: &Vocabulary,
) -> Result<Suggestions, tokio_postgres::Error> {
    let mut query = None;
    let mut limit = None;
    for (key, value) in form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "q" if query.is_none() => query = Some(value),
            "limit" if limit.is_none() => limit = Some(value),
            _ => {}
        }
    }
    suggest(
        db,
        query.as_deref().unwrap_or_default(),
        limit.as_deref(),
        vocabulary,
    )
    .await
}

/// Reads from Discovery's existing Postgres projection. The caller supplies the
/// validated Query Vocabulary in force; this crate does not make a second policy.
pub async fn suggest(
    db: &impl GenericClient,
    query: &str,
    limit: Option<&str>,
    vocabulary: &Vocabulary,
) -> Result<Suggestions, tokio_postgres::Error> {
    let query = SuggestionQuery::parse(query, limit);
    let candidates = query.set_code_candidates();
    let mut served_codes = HashSet::new();
    if !candidates.is_empty() {
        for row in db.query(SERVED_SET_CODES, &[&candidates]).await? {
            served_codes.insert(row.try_get("set_code")?);
        }
    }
    let Some(QueryPlan {
        english,
        simple,
        limit,
    }) = query.plan(&served_codes, vocabulary)
    else {
        return Ok(Suggestions {
            items: Vec::new(),
            count: 0,
        });
    };

    let rows = db
        .query(SUGGESTIONS, &[&"active", &english, &simple, &limit])
        .await?;
    let items = rows
        .iter()
        .map(|row| {
            Ok(Suggestion {
                catalog_item_id: row.try_get("catalog_item_id")?,
                title: row.try_get("title")?,
                subtitle: row.try_get("subtitle")?,
                slug: row.try_get("slug")?,
                category: row.try_get("category")?,
            })
        })
        .collect::<Result<Vec<_>, tokio_postgres::Error>>()?;
    Ok(Suggestions {
        count: items.len(),
        items,
    })
}
