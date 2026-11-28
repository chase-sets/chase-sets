use chase_sets_discovery_suggestions::{Vocabulary, get_suggestions};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, env, str::FromStr};
use tokio_postgres::{Config, NoTls, config::Host, error::SqlState};

#[derive(Deserialize)]
struct Fixture {
    expansions: Vocabulary,
    rows: Vec<SeedRow>,
    requests: Vec<RequestCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedRow {
    catalog_item_id: String,
    title: String,
    subtitle: Option<String>,
    slug: String,
    category: Option<String>,
    english: String,
    simple: String,
    weight: String,
    status: String,
    set_code: Option<String>,
}

#[derive(Deserialize)]
struct RequestCase {
    name: String,
    query: String,
    limit: Option<String>,
    ids: Vec<String>,
}

#[tokio::test]
async fn matches_the_typescript_suggestion_contract_on_seeded_postgres() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../read-model/suggestion-parity.fixture.json"
    ))
    .unwrap();
    let config =
        env::var("TEST_DATABASE_URL").expect("the parity test requires disposable Postgres");
    let config = Config::from_str(&config).expect("invalid parity database config");
    assert!(
        matches!(config.get_hosts(), [Host::Tcp(host)] if host == "127.0.0.1" || host == "localhost")
    );
    assert!(
        config
            .get_hostaddrs()
            .iter()
            .all(std::net::IpAddr::is_loopback)
    );
    let (mut client, connection) = config.connect(NoTls).await.unwrap();
    let driver = tokio::spawn(connection);
    let tx = client.transaction().await.unwrap();
    tx.batch_execute(
        "CREATE TEMP TABLE discovery_search_items (
            catalog_item_id text PRIMARY KEY, title text NOT NULL, subtitle text, slug text NOT NULL,
            category_names jsonb NOT NULL, set_code text, status text NOT NULL,
            search_text tsvector, search_text_simple tsvector
         ) ON COMMIT DROP;
         SET LOCAL search_path TO pg_temp, pg_catalog;",
    )
    .await
    .unwrap();

    let mut items = HashMap::<&str, Value>::new();
    for row in &fixture.rows {
        let categories = match &row.category {
            Some(category) => json!([category]),
            None => json!([]),
        }
        .to_string();
        tx.execute(
            "INSERT INTO pg_temp.discovery_search_items
                 (catalog_item_id, title, subtitle, slug, category_names, set_code, status, search_text, search_text_simple)
             VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7, setweight(to_tsvector('english', $8), $10::text::\"char\"),
                     setweight(to_tsvector('simple', $9), $10::text::\"char\"))",
            &[&row.catalog_item_id, &row.title, &row.subtitle, &row.slug, &categories,
                &row.set_code, &row.status, &row.english, &row.simple, &row.weight],
        ).await.unwrap();
        items.insert(
            &row.catalog_item_id,
            json!({
                "catalogItemId": row.catalog_item_id,
                "title": row.title,
                "subtitle": row.subtitle,
                "slug": row.slug,
                "category": row.category,
            }),
        );
    }

    for case in fixture.requests {
        let mut params = form_urlencoded::Serializer::new(String::new());
        params.append_pair("q", &case.query);
        if let Some(limit) = case.limit.as_deref() {
            params.append_pair("limit", limit);
        }
        let uri = format!("/api/marketplace/items/suggest?{}", params.finish())
            .parse()
            .unwrap();
        let actual = get_suggestions(&tx, &uri, &fixture.expansions)
            .await
            .unwrap();
        let expected: Vec<_> = case.ids.iter().map(|id| &items[id.as_str()]).collect();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            json!({"items": expected, "count": expected.len()}),
            "{}",
            case.name
        );
    }

    // Without a readable projection, an empty query still succeeds and a real
    // query returns a repository failure rather than an empty successful read.
    tx.batch_execute("DROP TABLE pg_temp.discovery_search_items")
        .await
        .unwrap();
    let empty = "/api/marketplace/items/suggest?q=".parse().unwrap();
    assert_eq!(
        get_suggestions(&tx, &empty, &fixture.expansions)
            .await
            .unwrap()
            .count,
        0
    );
    let nonempty = "/api/marketplace/items/suggest?q=ember".parse().unwrap();
    let error = get_suggestions(&tx, &nonempty, &fixture.expansions)
        .await
        .unwrap_err();
    assert_eq!(error.code(), Some(&SqlState::UNDEFINED_TABLE));

    tx.rollback().await.unwrap();
    drop(client);
    driver.await.unwrap().unwrap();
}
