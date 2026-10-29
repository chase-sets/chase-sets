//! A set's page (discovery's `routes/set.tsx`), to anyone: `/sets/{slug}`, the set and its
//! cataloged items. An old slug moves to the set's own for good, with the address's query; a set
//! the API does not have is a 404 and a failed read a 502, where marketplace answers both with
//! 200 (chase-sets/chase-sets#10612).
use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use serde_json::{Value, json};

use crate::{
    api::{Search, SetPage},
    app::{Shared, marketplace_origin, url},
    auth::Session,
    text::SearchMsg,
    views,
};

pub(crate) async fn page(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<crate::app::url::sets::Set<'_>>,
) -> HtmlResult {
    let slug = route.slug;
    let caller = config.platform.caller(&headers, config.proto, None);
    let set = match caller.set(&slug).await {
        Ok(Some(set)) => set,
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    if !set.slug.is_empty() && set.slug != slug {
        let to = url::Set { slug: &set.slug }.href();
        let to = match uri.query() {
            Some(query) if !query.is_empty() => format!("{to}?{query}"),
            _ => to,
        };
        let to: Uri = to.parse().map_err(corten::Error::new)?;
        return req.moved(&to);
    }
    let t: SearchMsg = req.t();
    let canonical = format!("{}{}", marketplace_origin(), url::Set { slug: &set.slug }.href());
    let title = t.set_card_list_meta_title(&set.name).to_string();
    let description = t.set_browse_card_list_description(&set.name, set.item_count).to_string();
    let breadcrumb = breadcrumb(t, &set, &canonical);
    let (og_title, og_description) = (title.as_str(), description.as_str());
    let head = html! {
        <meta name="description" content={og_description}>
        <link rel="canonical" href={&canonical}>
        <meta property="og:title" content={og_title}>
        <meta property="og:description" content={og_description}>
        <meta property="og:type" content="website">
        <JsonLd value={&breadcrumb} />
    };
    let session = session.as_deref();
    let viewer = session.and_then(Session::viewer);
    req.page(html! {
        <views::Layout req={&req} viewer={viewer} title={&title} head={head}>
            <views::SetPage t={t} set={&set} />
        </views::Layout>
    })
}

/// Marketplace, Browse and the set, as a schema.org BreadcrumbList (`buildBreadcrumbListJsonLd`).
fn breadcrumb(t: SearchMsg, set: &SetPage, canonical: &str) -> Value {
    let origin = marketplace_origin();
    let trail = [
        (t.set_marketplace(), format!("{origin}/")),
        (t.set_browse(), format!("{origin}/search")),
        (set.name.as_str(), canonical.to_owned()),
    ];
    let items: Vec<Value> = trail
        .iter()
        .enumerate()
        .map(|(i, (name, url))| json!({ "@type": "ListItem", "position": i + 1, "name": name, "item": url }))
        .collect();
    json!({ "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": items })
}
