//! The catalog items list (`/catalog/catalog-items`, admin-web's `/catalog/catalog-items`), through
//! the Catalog API's items routes (`/api/catalog/items`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/catalog-items?<filters>&page` | the list; `POST` creates; with the script, a Reload (its rows, and a new stream of changes) |
//! | `GET /catalog/catalog-items/live?<filters>&page` | how many items changed since, on each change (`<corten-live>`) |
//! | `POST /catalog/catalog-items/bulk?...` | a bulk preview: a publish's, an archive's or an edit's |
//! | `POST /catalog/catalog-items/bulk/confirm?...` | starts it: a redirect to the list, following its job (`?job=`) |
//! | `POST /catalog/catalog-items/drafts?...`, `.../drafts/confirm` | the checked drafts' removal; removes each |
//!
//! The list is live as admin-web's is (`useCatalogRealtimeRevalidation` in manual mode): a change
//! to the topic `catalog:admin:catalog-items` is counted, not drawn, so a long list being edited
//! by an import does not move under the user. Each count carries the realtime cursor, so a
//! browser that reconnects goes on counting from it. A record changed both before and after a
//! reconnect counts twice (the ids it saw are not kept); admin-web's page keeps them.
//!
//! The bulk bar's operations are the API's three bulk changes: a publish (its confirm takes the
//! preview's items), an archive (the lifecycle change the other lists have), and the edits
//! (`assignBlueprint`, `assignCategory`, `removeCategory`, `setTags`, `mergeTags`, `clearTags`).
//! Each runs as a job, which the list's dialog follows. Remove drafts has no bulk route in the
//! API: as admin-web does, the pilot removes each checked draft in turn
//! (chase-sets/chase-sets#10530 asks for a bulk route).
use std::collections::HashSet;

use corten::{
    Fragment, LiveSince,
    axum::{http::HeaderMap, response::IntoResponse},
    prelude::*,
};
use futures_util::StreamExt;
use platform::{realtime::Tick, receipt::Receipt};
use serde_json::{Value, json};

use super::{
    Sent, action_label,
    api::{Catalog as _, ItemRow, Job, Kind, List},
    command, filter_query, follow, list_query, manages, receipt, screen,
    views::{self, Followed, ItemDialog, ItemPreview, ListScreen, Pending},
};
use super::{
    api::under,
    form::{Family, ItemBulkInput, ItemInput},
    views::{DraftsDialog, ItemPreviewDialog},
};
use crate::{
    api::Method,
    app::{Denied, Shared, read_failed, refused},
    text::{Cat, Pilot},
};

/// The Catalog's realtime topic for the items (`catalogRealtimeRouteTopics.catalogItems`).
const TOPIC: &str = "catalog:admin:catalog-items";

/// The list's filters (`catalogItemListQueryFromRecord`), with their API names.
macro_rules! filters {
    ($query:expr) => {{
        let q = $query;
        [
            ("search", &q.search),
            ("status", &q.status),
            ("language", &q.language),
            ("source", &q.source),
            ("blueprintId", &q.blueprint_id),
            ("tag", &q.tag),
            ("blueprintState", &q.blueprint_state),
            ("hasImages", &q.has_images),
            ("hasSourceReferences", &q.has_source_references),
            ("missingRequiredFields", &q.missing_required_fields),
        ]
    }};
}

pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// What a write did, for the list it redirects to.
    #[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum ItemDone {
        Created,
        DraftsRemoved,
    }

    impl std::fmt::Display for ItemDone {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(match self {
                ItemDone::Created => "created",
                ItemDone::DraftsRemoved => "drafts_removed",
            })
        }
    }

    /// The items list: its filters (the filter form's fields), the page (from 1), the receipt and
    /// notice of the write before (and how many drafts it removed), and the job the page follows.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route("/catalog/catalog-items")]
    pub struct Items {
        pub search: Option<String>,
        pub status: Option<String>,
        pub language: Option<String>,
        pub source: Option<String>,
        pub blueprint_id: Option<String>,
        pub tag: Option<String>,
        pub blueprint_state: Option<String>,
        pub has_images: Option<String>,
        pub has_source_references: Option<String>,
        pub missing_required_fields: Option<String>,
        pub page: Option<u32>,
        pub after_write: Option<String>,
        pub done: Option<ItemDone>,
        pub removed: Option<u32>,
        pub job: Option<String>,
    }

    impl Items {
        /// The list with its filters and page, without what the write before left.
        pub fn bare(&self) -> Items {
            Items { after_write: None, done: None, removed: None, job: None, ..self.clone() }
        }

        /// Whether a filter is set.
        pub fn filtered(&self) -> bool {
            filters!(self).iter().any(|(_, value)| value.is_some())
        }

        /// The filters and page that are set, by the list's query names: a Reload's fields.
        pub fn kept(&self) -> Vec<(corten::FieldName, String)> {
            let f = Items::FIELDS;
            let names = [
                (f.search, &self.search),
                (f.status, &self.status),
                (f.language, &self.language),
                (f.source, &self.source),
                (f.blueprint_id, &self.blueprint_id),
                (f.tag, &self.tag),
                (f.blueprint_state, &self.blueprint_state),
                (f.has_images, &self.has_images),
                (f.has_source_references, &self.has_source_references),
                (f.missing_required_fields, &self.missing_required_fields),
            ];
            let mut kept: Vec<_> = names.into_iter().filter_map(|(name, value)| Some((name, value.clone()?))).collect();
            if let Some(page) = self.page.filter(|page| *page > 1) {
                kept.push((f.page, page.to_string()));
            }
            kept
        }
    }

    /// The routes that carry the list's filters and page, so their answer can be the list.
    /// (`#[derive(Route)]` cannot share a set of query fields between routes: todd-skelton/corten#32.)
    macro_rules! filtered {
        ($($(#[$meta:meta])* $name:ident $path:tt;)*) => {$(
            $(#[$meta])*
            #[derive(Clone, Debug, Default, Deserialize, Route)]
            #[route($path)]
            pub struct $name {
                pub search: Option<String>,
                pub status: Option<String>,
                pub language: Option<String>,
                pub source: Option<String>,
                pub blueprint_id: Option<String>,
                pub tag: Option<String>,
                pub blueprint_state: Option<String>,
                pub has_images: Option<String>,
                pub has_source_references: Option<String>,
                pub missing_required_fields: Option<String>,
                pub page: Option<u32>,
            }

            impl $name {
                pub fn of(list: &Items) -> Self {
                    let Items {
                        search, status, language, source, blueprint_id, tag, blueprint_state, has_images,
                        has_source_references, missing_required_fields, page, ..
                    } = list.clone();
                    $name {
                        search, status, language, source, blueprint_id, tag, blueprint_state, has_images,
                        has_source_references, missing_required_fields, page,
                    }
                }

                pub fn list(self) -> Items {
                    let $name {
                        search, status, language, source, blueprint_id, tag, blueprint_state, has_images,
                        has_source_references, missing_required_fields, page,
                    } = self;
                    Items {
                        search, status, language, source, blueprint_id, tag, blueprint_state, has_images,
                        has_source_references, missing_required_fields, page, ..Items::default()
                    }
                }
            }
        )*};
    }

    filtered! {
        /// How many items changed, streamed on each change.
        ItemsLive "/catalog/catalog-items/live";
        /// A bulk change's preview.
        ItemsBulk "/catalog/catalog-items/bulk";
        /// The preview's confirm: it starts the change.
        ItemsBulkConfirm "/catalog/catalog-items/bulk/confirm";
        /// The checked drafts' removal: its dialog.
        ItemsDrafts "/catalog/catalog-items/drafts";
        /// Its confirm: removes each.
        ItemsDraftsConfirm "/catalog/catalog-items/drafts/confirm";
    }
}

pub fn routes(
    area: Area<crate::auth::Session, super::url::Catalog>,
    shared: Shared,
) -> Area<crate::auth::Session, super::url::Catalog> {
    area.route::<url::Items>(get(items).post(create).with_state(shared.clone()))
        .route::<url::ItemsLive>(get(items_live).with_state(shared.clone()))
        .route::<url::ItemsBulk>(post(preview).with_state(shared.clone()))
        .route::<url::ItemsBulkConfirm>(post(confirm).with_state(shared.clone()))
        .route::<url::ItemsDrafts>(post(drafts).with_state(shared.clone()))
        .route::<url::ItemsDraftsConfirm>(post(remove_drafts).with_state(shared))
}

/// The list's API query (`buildCatalogListApiQuery`).
fn api_query(query: &url::Items, page: u32) -> String {
    list_query(&filters!(query), page)
}

/// The toast after a write.
fn notice(t: Cat, query: &url::Items) -> Option<String> {
    query.done.map(|done| match done {
        url::ItemDone::Created => t.item_list_catalog_item_created().to_owned(),
        url::ItemDone::DraftsRemoved => t.item_list_draft_catalog_items_removed(query.removed.unwrap_or(0)).to_string(),
    })
}

/// The list page, or with the script (a Reload's `GET`), its rows and a new stream of changes.
async fn items(req: Req, State(config): State<Shared>, headers: HeaderMap, Query(query): Query<url::Items>) -> corten::Result {
    if req.mode == Mode::Action {
        let caller = config.platform.caller(&headers, config.proto, None);
        let page = query.page.unwrap_or(1).max(1);
        let list = match caller.list::<ItemRow>(Kind::Items, &api_query(&query, page)).await {
            Ok(list) => list,
            Err(error) => return read_failed(&req, error, false),
        };
        let screen: ListScreen<ItemRow, ItemPreview> = screen(list, page);
        let (t, p): (Cat, Pilot) = (req.t(), req.t());
        let manage = manages(&req);
        let view = html! {
            {views::item_rows(t, p, &query, &screen, manage)}
            {views::item_live(t, &query)}
        };
        return req.patch(view);
    }
    item_list(&req, &config, &headers, &query, None, None).await
}

/// The items page; `create` is a create form that came back, drawn open, and `dialog` a bulk
/// preview's or the drafts' answer, drawn open.
async fn item_list(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::Items,
    create: Option<views::Draft<ItemInput>>,
    dialog: Option<ItemDialog<'_>>,
) -> corten::Result {
    let receipt = Receipt::from_param(query.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let list = match caller.list::<ItemRow>(Kind::Items, &api_query(query, page)).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let mut screen: ListScreen<ItemRow, ItemPreview> = screen(list, page);
    if let Some(ItemDialog::Preview { preview, .. }) = dialog {
        screen.preview = preview.cloned();
    }
    screen.job = follow(&caller, query.job.as_deref()).await;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let job = query.job.is_some().then(|| Followed {
        job: screen.job.as_ref(),
        label: screen.job.as_ref().map_or("", |job| action_label(t, job.of().unwrap_or(Kind::Items), &job.action)),
        live: screen.job.as_ref().filter(|job| !job.done()).map(|job| super::url::JobLive { id: &job.job_id }.href()),
    });
    let parts = views::ItemParts { create, notice: notice(t, query), manage: manages(req), dialog, job };
    let view = views::item_list(t, p, query, &screen, parts);
    req.screen(Meta::new(t.route_items()), &screen, view)
}

/// How many items changed for `<corten-live>`: drawn on each change to the items until the API
/// refuses the stream. Each count carries the realtime stream's cursor after it, with the count
/// (`{count}.{sync}.{cursor}`), so a browser that reconnects (`since`) goes on from there.
async fn items_live(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Query(at): Query<url::ItemsLive>,
) -> impl IntoResponse {
    let t: Cat = req.t();
    let query = at.list();
    let (before, from) = resume(since.0);
    let changes = config.platform.caller(&headers, config.proto, None).changes(&[TOPIC], from);
    let mut seen = HashSet::new();
    let mut sync = before.sync;
    let fragments = changes
        .take_while(|tick| std::future::ready(!matches!(tick, Tick::Refused(_))))
        .filter_map(|tick| {
            std::future::ready(match tick {
                Tick::Changed(cursor, changes) => Some((cursor, changes)),
                _ => None,
            })
        })
        .map(move |(cursor, changes)| {
            seen.extend(changes.ids);
            sync |= changes.sync;
            let pending = Pending { count: before.count + seen.len() as u32, sync };
            let html = views::item_changes(t, &query, pending).to_html();
            match cursor {
                Some(cursor) => Fragment::new(html).cursor(format!("{}.{}.{cursor}", pending.count, u8::from(pending.sync))),
                None => Fragment::new(html),
            }
        });
    corten::live(fragments)
}

/// What a reconnecting browser had counted, and the realtime cursor to go on from.
fn resume(since: Option<String>) -> (Pending, Option<String>) {
    let Some(since) = since else { return (Pending::default(), None) };
    let mut parts = since.splitn(3, '.');
    match (parts.next().and_then(|n| n.parse().ok()), parts.next(), parts.next()) {
        (Some(count), Some(sync @ ("0" | "1")), Some(cursor)) => (Pending { count, sync: sync == "1" }, Some(cursor.to_owned())),
        _ => (Pending::default(), Some(since)),
    }
}

async fn create(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::Items>,
    Form(input): Form<ItemInput>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Items, "", Some(&input.body())).await {
        Sent::Written(written) => {
            let done = url::Items { after_write: receipt(&written), done: Some(url::ItemDone::Created), ..query.bare() };
            return req.redirect(&done);
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = views::Draft { input, errors };
    let action = query.bare().href();
    let form = views::ItemForm { t: req.t(), id: views::ids::CREATE, action: &action, form: &draft };
    req.invalid(&draft.errors, form, || item_list(&req, &config, &headers, &query, Some(draft.clone()), None)).await
}

/// What a bulk preview came to.
enum Previewing {
    Shown(ItemPreview),
    Refused(Errors),
    Denied(Denied),
}

/// The API's preview for the operation: `bulk-publish`, `bulk-lifecycle` or `bulk-edit`.
async fn ask_preview(p: Pilot, caller: &crate::api::Caller<'_>, input: &ItemBulkInput, query: &url::Items) -> Previewing {
    if let Some(errors) = input.refusal(p) {
        return Previewing::Refused(errors);
    }
    let body = input.preview_body(filter_query(&filters!(query)));
    let answer = match input.family() {
        Some(Family::Publish) => caller.post(Kind::Items, "/bulk-publish/preview", &body).await.map(ItemPreview::Publish),
        Some(Family::Lifecycle) => caller.bulk_preview(Kind::Items, &body).await.map(ItemPreview::Lifecycle),
        _ => caller.post(Kind::Items, "/bulk-edit/preview", &body).await.map(ItemPreview::Edit),
    };
    match answer {
        Ok(preview) => Previewing::Shown(preview),
        Err(error) => match refused(error) {
            Ok(errors) => Previewing::Refused(errors),
            Err(denied) => Previewing::Denied(denied),
        },
    }
}

/// A dialog's answer: the dialog as a patch, or the list page with it open; a refusal is the
/// dialog with the message (422).
async fn answer(req: &Req, config: &Shared, headers: &HeaderMap, query: &url::Items, dialog: ItemDialog<'_>) -> corten::Result {
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let errors = match dialog {
        ItemDialog::Preview { errors, .. } | ItemDialog::Drafts { errors, .. } => errors,
    };
    let view = html! {
        match dialog {
            ItemDialog::Preview { input, preview, errors, confirm, label } => {
                <ItemPreviewDialog t={t} p={p} input={input} preview={preview} errors={errors} confirm={confirm} label={label} />
            }
            ItemDialog::Drafts { ids, errors, confirm } => <DraftsDialog t={t} p={p} ids={ids} errors={errors} confirm={confirm} />,
        }
    };
    if !errors.is_empty() {
        return req.invalid(errors, view, || item_list(req, config, headers, query, None, Some(dialog))).await;
    }
    if req.mode == Mode::Action {
        return req.patch(view);
    }
    item_list(req, config, headers, query, None, Some(dialog)).await
}

async fn preview(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(at): Query<url::ItemsBulk>,
    Form(input): Form<ItemBulkInput>,
) -> corten::Result {
    let confirm = url::ItemsBulkConfirm::of(&at.clone().list()).href();
    let query = at.list();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (preview, errors) = match ask_preview(req.t(), &caller, &input, &query).await {
        Previewing::Shown(preview) => (Some(preview), Errors::new()),
        Previewing::Refused(errors) => (None, errors),
        Previewing::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Items, &input.action);
    let dialog = ItemDialog::Preview { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &confirm, label };
    answer(&req, &config, &headers, &query, dialog).await
}

async fn confirm(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(at): Query<url::ItemsBulkConfirm>,
    Form(input): Form<ItemBulkInput>,
) -> corten::Result {
    let action = at.clone().href();
    let query = at.list();
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match input.refusal(req.t()) {
        Some(errors) => errors,
        None => {
            let filter = filter_query(&filters!(&query));
            let started: Result<Job<Value>, _> = match input.family() {
                Some(Family::Publish) => {
                    caller.post(Kind::Items, "/bulk-publish/confirm", &json!({ "itemIds": input.ids })).await
                }
                Some(Family::Lifecycle) => caller.post(Kind::Items, "/bulk-lifecycle/confirm", &input.preview_body(filter)).await,
                _ => caller.post(Kind::Items, "/bulk-edit/confirm", &input.preview_body(filter)).await,
            };
            match started {
                Ok(job) => return req.redirect(&url::Items { job: Some(job.job_id), ..query }),
                Err(error) => match refused(error) {
                    Ok(errors) => errors,
                    Err(denied) => return denied.answer(&req),
                },
            }
        }
    };
    // Refused: the preview again, with the message.
    let preview = match ask_preview(req.t(), &caller, &input, &query).await {
        Previewing::Shown(preview) => Some(preview),
        _ => None,
    };
    let label = action_label(req.t(), Kind::Items, &input.action);
    let dialog = ItemDialog::Preview { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &action, label };
    answer(&req, &config, &headers, &query, dialog).await
}

/// The checked rows' statuses, from the list they were checked on: none checked, or one that is
/// not a draft, is the form's message (admin-web enables Remove Drafts only when every checked row
/// is a draft). Workaround for chase-sets/chase-sets#10530: this restates the Catalog's rule; remove
/// it once the API previews the removal.
async fn draft_refusal(
    p: Pilot,
    caller: &crate::api::Caller<'_>,
    query: &url::Items,
    ids: &[String],
) -> Result<Option<Errors>, Denied> {
    let mut errors = Errors::new();
    if ids.is_empty() {
        errors.add_form(p.bulk_none_selected());
        return Ok(Some(errors));
    }
    let page = query.page.unwrap_or(1).max(1);
    let list: List<ItemRow> = match caller.list(Kind::Items, &api_query(query, page)).await {
        Ok(list) => list,
        Err(error) => return refused(error).map(Some),
    };
    let draft = |id: &String| list.items.iter().any(|row| row.catalog_item_id == *id && row.status == "draft");
    if !ids.iter().all(draft) {
        errors.add_form(p.catalog_drafts_only());
        return Ok(Some(errors));
    }
    Ok(None)
}

async fn drafts(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(at): Query<url::ItemsDrafts>,
    Form(input): Form<ItemBulkInput>,
) -> corten::Result {
    let confirm = url::ItemsDraftsConfirm::of(&at.clone().list()).href();
    let query = at.list();
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match draft_refusal(req.t(), &caller, &query, &input.ids).await {
        Ok(errors) => errors.unwrap_or_default(),
        Err(denied) => return denied.answer(&req),
    };
    let dialog = ItemDialog::Drafts { ids: &input.ids, errors: &errors, confirm: &confirm };
    answer(&req, &config, &headers, &query, dialog).await
}

/// Removes each checked draft in turn (`removeDraftCatalogItem`); the first refusal stops it and
/// is the dialog's message (the drafts before it stay removed, as in admin-web).
async fn remove_drafts(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(at): Query<url::ItemsDraftsConfirm>,
    Form(input): Form<ItemBulkInput>,
) -> corten::Result {
    let action = at.clone().href();
    let query = at.list();
    let caller = config.platform.caller(&headers, config.proto, None);
    let mut errors = match draft_refusal(req.t(), &caller, &query, &input.ids).await {
        Ok(errors) => errors.unwrap_or_default(),
        Err(denied) => return denied.answer(&req),
    };
    let mut last = None;
    let mut removed = 0;
    if errors.is_empty() {
        for id in &input.ids {
            match command(&caller, Method::DELETE, Kind::Items, &under(id, &[]), None).await {
                Sent::Written(written) => {
                    removed += 1;
                    last = Some(written);
                }
                Sent::Refused(refusal) => {
                    errors = refusal;
                    break;
                }
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
    }
    if errors.is_empty() {
        let done = url::Items {
            after_write: last.as_ref().and_then(receipt),
            done: Some(url::ItemDone::DraftsRemoved),
            removed: Some(removed),
            ..query.bare()
        };
        return req.redirect(&done);
    }
    let dialog = ItemDialog::Drafts { ids: &input.ids, errors: &errors, confirm: &action };
    answer(&req, &config, &headers, &query, dialog).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reconnect_goes_on_counting_from_its_cursor() {
        assert_eq!(resume(None), (Pending::default(), None));
        assert_eq!(resume(Some("3.0.c2".into())), (Pending { count: 3, sync: false }, Some("c2".into())));
        assert_eq!(resume(Some("0.1.a.b".into())), (Pending { count: 0, sync: true }, Some("a.b".into())));
        assert_eq!(resume(Some("c9".into())), (Pending::default(), Some("c9".into())), "a cursor it did not draw");
    }
}
