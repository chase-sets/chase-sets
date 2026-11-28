use std::collections::BTreeSet;

use corten::{
    http::{Body, Method, Request, Response, StatusCode, header},
    middleware::{MatchedPath, Middleware, Next},
};
use serde::Deserialize;
use tower::ServiceExt;

use crate::{
    api::Platform,
    app::{Config, app_with_middleware},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkRoute {
    route_id: String,
    route_path: String,
}

const EXCEPTIONS: &[(&str, &str, &str)] = &[(
    "item-detail-market-history",
    "items/:id/market-history",
    "This was a JSON resource for the React panel. Corten reads and renders history in the item's Sales tab.",
)];

/// Ask the assembled router what it matched, without calling any route handler or platform API.
struct RecordMatch;

impl Middleware for RecordMatch {
    async fn call(&self, req: Request<Body>, _next: impl Next) -> Response<Body> {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        if let Some(matched) = req.extensions().get::<MatchedPath>() {
            response.extensions_mut().insert(matched.clone());
        }
        response
    }
}

fn segments(path: &str) -> impl Iterator<Item = &str> {
    path.strip_prefix('/').unwrap_or(path).split('/')
}

fn parameter_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn catalog_path(path: &str, parameter: &'static str) -> String {
    let mut result = String::new();
    for segment in segments(path) {
        result.push('/');
        result.push_str(if segment.strip_prefix(':').is_some_and(parameter_name) { parameter } else { segment });
    }
    result
}

fn corten_path(path: &str) -> String {
    let mut result = String::new();
    for segment in segments(path) {
        result.push('/');
        let name = segment.strip_prefix('{').and_then(|part| part.strip_suffix('}'));
        result.push_str(if name.is_some_and(parameter_name) { "{}" } else { segment });
    }
    result
}

async fn matched_pattern(router: &corten::Router, record: &LinkRoute) -> Option<String> {
    let request = Request::builder()
        .method(Method::OPTIONS)
        .uri(catalog_path(&record.route_path, "route-parity-sample"))
        .header(header::HOST, "localhost:7791")
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT, "route probe for {}", record.route_path);
    response.extensions().get::<MatchedPath>().map(|matched| corten_path(matched.as_str()))
}

fn unmatched<'a>(records: &'a [LinkRoute], registered: &BTreeSet<String>) -> Vec<(&'a str, &'a str)> {
    records
        .iter()
        .filter(|record| !registered.contains(&catalog_path(&record.route_path, "{}")))
        .map(|record| (record.route_id.as_str(), record.route_path.as_str()))
        .collect()
}

#[tokio::test]
async fn marketplace_link_catalog_matches_registered_routes() {
    let mut records: Vec<LinkRoute> = serde_json::from_str(include_str!("../link-routes.json")).unwrap();
    let router = app_with_middleware(
        Config {
            platform: Platform::new("http://localhost:1"),
            proto: "http",
            stripe_publishable_key: None,
            indexing: true,
            claim_token_entry: false,
        },
        RecordMatch,
    )
    .router();
    let mut registered = BTreeSet::new();
    for record in &records {
        if let Some(pattern) = matched_pattern(&router, record).await {
            registered.insert(pattern);
        }
    }

    let mut exceptions: Vec<_> = EXCEPTIONS.iter().map(|&(id, path, _)| (id, path)).collect();
    assert_eq!(unmatched(&records, &registered), exceptions, "documented exceptions: {EXCEPTIONS:?}");

    // A new record for a literal URL is not a new registration, even under a dynamic route.
    let added = ("zz-parity-control", "items/route-parity-unregistered");
    let new_record = LinkRoute { route_id: added.0.into(), route_path: added.1.into() };
    assert_eq!(matched_pattern(&router, &new_record).await.as_deref(), Some("/items/{}"));
    records.push(new_record);
    exceptions.push(added);
    assert_eq!(unmatched(&records, &registered), exceptions);
    records.pop();
    exceptions.pop();

    // Losing a pattern from the live route inventory must expose its existing catalog record.
    assert!(registered.remove("/items/{}"));
    exceptions.insert(0, ("item-detail", "items/:id"));
    assert_eq!(unmatched(&records, &registered), exceptions);
}
