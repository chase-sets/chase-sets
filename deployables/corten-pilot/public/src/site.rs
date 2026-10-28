//! The site's own files, as public-web's routes serve them (`app/routes.ts`): the web app
//! manifest (`createWebManifestLoader`), the favicon at both addresses (`createFaviconLoader`,
//! the design system's `chaseSetsLogoSvg`, compiled in from `favicon.svg`, which
//! scripts/export.mjs writes), and Chrome's devtools probe (`createChromeDevtoolsLoader`).
//! `/health/ready` and `/health/live` are Corten's own.
use std::time::Duration;

use corten::{Media, NoStore, axum::http::StatusCode, prelude::*};
use serde_json::json;

use crate::text::HomeMsg;

/// The design system's logo, which public-web serves as its favicon.
const FAVICON: &str = include_str!("../favicon.svg");

/// How long a browser keeps the manifest (`public, max-age=3600`, as public-web sends it).
const MANIFEST_LIFE: Duration = Duration::from_secs(3600);

/// How long a browser keeps the favicon (`public, max-age=86400`).
const FAVICON_LIFE: Duration = Duration::from_secs(86_400);

/// The manifest's fields (public-web's `buildPublicManifest`).
pub fn manifest(t: HomeMsg) -> serde_json::Value {
    json!({
        "name": "Chase Sets",
        "short_name": "Chase Sets",
        "description": t.home_description(),
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "any",
        "categories": ["shopping", "productivity"],
        "theme_color": "#4845c6",
        "background_color": "#f7f5f1",
        "icons": [],
    })
}

/// `/manifest.webmanifest`.
pub(crate) async fn web_manifest(req: Req) -> Public<Media> {
    let body = manifest(req.t()).to_string();
    Public::new(MANIFEST_LIFE, Media::new("application/manifest+json; charset=utf-8", body))
}

/// `/favicon.svg` and `/favicon.ico`: the same SVG at both, as public-web serves it.
pub(crate) async fn favicon() -> Public<Media> {
    Public::new(FAVICON_LIFE, Media::new("image/svg+xml; charset=utf-8", FAVICON))
}

/// `/.well-known/appspecific/com.chrome.devtools.json`: nothing, so Chrome stops asking and the
/// log has no 404 for it.
pub(crate) async fn devtools() -> NoStore<StatusCode> {
    NoStore(StatusCode::NO_CONTENT)
}
