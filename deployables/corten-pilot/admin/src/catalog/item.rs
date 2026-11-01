//! A catalog item's page (\`/catalog/catalog-items/{id}\`, admin-web's), through the Catalog API's
//! item routes (\`/api/catalog/items/{id}\`) and its product contents (\`/api/catalog/product-contents\`).
//!
//! | Route | Answers |
//! |---|---|
//! | \`GET /catalog/catalog-items/{id}?after_write&done\` | the page |
//! | \`GET .../publish\`, \`POST .../publish\` | the publish form with the readiness now (Recheck); publishes |
//! | \`POST .../lifecycle\` | archives |
//! | \`POST .../blueprint\`, \`.../metadata\`, \`.../tags\`, \`.../image-urls\`, \`.../image-fallback\` | the item's values |
//! | \`GET .../fields\`, \`POST .../fields\`, \`POST .../fields/{field_id}/clear\` | Set Field Value (drawn when opened); sets; clears |
//! | \`POST .../categories\`, \`.../categories/{category_id}/remove\` | assigns, removes a category |
//! | \`POST .../catalog-item-references\`, \`.../product-references\`, each \`/unlink\` | external references |
//! | \`GET .../contents\`, \`POST .../contents\`, \`POST .../contents/{line_id}/remove\` | Add content line (drawn when opened); adds; removes |
//!
//! Every write is a form that works without JavaScript and answers with the page, its receipt
//! and what it did (the toast), or with the form and the API's refusal. Product contents are
//! replaced as a whole list (the API's only write for them): the pilot reads the lines when the
//! write is sent, not when the page was drawn, and sends them back with one more or one less
//! (chase-sets/chase-sets#10538 asks for a write that cannot drop another's line).
use corten::{axum::http::HeaderMap, prelude::*};
use futures_util::future::{join, join3};
use platform::receipt::Receipt;
use serde_json::{Value, json};

use super::{
    Sent,
    api::{
        Catalog as _, ContentChoice, ContentLine, Field, ItemDetail, ItemRow, Kind, List, Readiness, ReferenceRow, Written, under,
    },
    command,
    form::{
        ActionInput, ContentLineInput, FallbackInput, FieldValueInput, IdInput, ListInput, MetadataInput, PublishInput,
        ReferenceInput, line_input, parts,
    },
    not_offered, receipt,
    views::{self, ContentChoices, Draft, FieldChoices, Fold, ItemBack, ItemScreen, Labels, choice_label, ids::item as ids},
};
use crate::{
    api::{ApiError, Caller, Method},
    app::{Shared, read_failed, refused},
    auth::{CatalogAccess, Staff, Viewer},
    text::Cat,
};

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use serde::Deserialize;

    /// What a write did, for the page it redirects to: the toast, and the part it opens.
    #[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, corten::UrlValue)]
    #[serde(rename_all = "snake_case")]
    pub enum Change {
        Published,
        Archived,
        BlueprintAssigned,
        FieldSet,
        FieldCleared,
        CategoryAssigned,
        CategoryRemoved,
        MetadataRevised,
        TagsUpdated,
        ImageUrlsUpdated,
        FallbackUpdated,
        FallbackCleared,
        CatalogRefLinked,
        CatalogRefUnlinked,
        ProductRefLinked,
        ProductRefUnlinked,
        ContentsUpdated,
    }

    /// The item's page, and the receipt and change of the write before.
    #[route("/catalog/catalog-items/{id}", get = page)]
    pub struct Item<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<Change>,
    }

    impl<'a> Item<'a> {
        pub fn of(id: &'a str) -> Self {
            Item { id, after_write: None, done: None }
        }
    }

    /// What the page reads after a write.
    #[derive(Debug, Default, Deserialize)]
    pub struct After {
        pub after_write: Option<String>,
        pub done: Option<Change>,
    }

    /// The publish form: \`GET\` draws it with the readiness now (keeping the typed ids), \`POST\`
    /// publishes.
    #[route("/catalog/catalog-items/{id}/publish", get = publish_form, post = publish)]
    pub struct Publish<'a> {
        pub id: &'a str,
    }

    impl<'a> Publish<'a> {
        pub fn of(id: &'a str) -> Self {
            Publish { id }
        }
    }

    /// Set Field Value: \`GET\` draws its dialog, \`POST\` sets.
    #[route("/catalog/catalog-items/{id}/fields", get = field_dialog, post = set_field)]
    pub struct Fields<'a> {
        pub id: &'a str,
    }

    impl<'a> Fields<'a> {
        pub fn of(id: &'a str) -> Self {
            Fields { id }
        }
    }

    /// Add content line: \`GET\` draws its dialog, \`POST\` adds.
    #[route("/catalog/catalog-items/{id}/contents", get = content_dialog, post = add_content)]
    pub struct Contents<'a> {
        pub id: &'a str,
    }

    impl<'a> Contents<'a> {
        pub fn of(id: &'a str) -> Self {
            Contents { id }
        }
    }

    #[route("/catalog/catalog-items/{id}/lifecycle", post = lifecycle)]
    pub struct Lifecycle<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/blueprint", post = blueprint)]
    pub struct Blueprint<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/fields/{field_id}/clear", post = clear_field)]
    pub struct FieldClear<'a> {
        pub id: &'a str,
        pub field_id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/categories", post = assign_category)]
    pub struct Categories<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/categories/{category_id}/remove", post = remove_category)]
    pub struct CategoryRemove<'a> {
        pub id: &'a str,
        pub category_id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/metadata", post = metadata)]
    pub struct Metadata<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/tags", post = tags)]
    pub struct Tags<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/image-urls", post = image_urls)]
    pub struct ImageUrls<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/image-fallback", post = fallback)]
    pub struct Fallback<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/image-fallback/clear", post = clear_fallback)]
    pub struct FallbackClear<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/catalog-item-references", post = link_catalog_ref)]
    pub struct CatalogRefs<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/catalog-item-references/unlink", post = unlink_catalog_ref)]
    pub struct CatalogRefUnlink<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/product-references", post = link_product_ref)]
    pub struct ProductRefs<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/product-references/unlink", post = unlink_product_ref)]
    pub struct ProductRefUnlink<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/catalog-items/{id}/contents/{line_id}/remove", post = remove_content)]
    pub struct ContentRemove<'a> {
        pub id: &'a str,
        pub line_id: &'a str,
    }
}

use url::Change;

impl Change {
    /// The toast (admin-web's).
    pub fn notice(self, t: Cat) -> String {
        match self {
            Change::Published => t.item_catalog_item_published().into(),
            Change::Archived => t.item_lifecycle_completed(t.item_archived()).to_string(),
            Change::BlueprintAssigned => t.item_blueprint_assigned().into(),
            Change::FieldSet => t.item_field_value_set().into(),
            Change::FieldCleared => t.item_field_value_cleared().into(),
            Change::CategoryAssigned => t.item_category_assigned().into(),
            Change::CategoryRemoved => t.item_category_removed().into(),
            Change::MetadataRevised => t.item_metadata_revised().into(),
            Change::TagsUpdated => t.item_tags_updated().into(),
            Change::ImageUrlsUpdated => t.item_image_urls_updated().into(),
            Change::FallbackUpdated => t.item_image_fallback_updated().into(),
            Change::FallbackCleared => t.item_image_fallback_cleared().into(),
            Change::CatalogRefLinked => t.item_external_catalog_item_reference_linked().into(),
            Change::CatalogRefUnlinked => t.item_external_catalog_item_reference_unlinked().into(),
            Change::ProductRefLinked => t.item_external_reference_linked().into(),
            Change::ProductRefUnlinked => t.item_external_reference_unlinked().into(),
            Change::ContentsUpdated => t.item_product_contents_updated().into(),
        }
    }

    /// The folded part the change was made in, which the page draws open.
    pub fn fold(self) -> Option<Fold> {
        match self {
            Change::ContentsUpdated => Some(Fold::Contents),
            Change::TagsUpdated => Some(Fold::Tags),
            Change::ImageUrlsUpdated => Some(Fold::Urls),
            Change::FallbackUpdated | Change::FallbackCleared => Some(Fold::Fallback),
            Change::CatalogRefLinked | Change::CatalogRefUnlinked => Some(Fold::CatalogRefs),
            Change::ProductRefLinked | Change::ProductRefUnlinked => Some(Fold::ProductRefs),
            _ => None,
        }
    }
}

/// A write's answer: the page after it, or the refusal (the form's errors), or a sign-in or an
/// error page. Returns the refusal.
macro_rules! sent {
    ($req:expr, $id:expr, $sent:expr, $done:expr) => {
        match $sent {
            Sent::Written(written) => return to_item(&$req, &$id, &written, $done),
            Sent::Refused(errors) => errors,
            Sent::Denied(denied) => return denied.answer(&$req),
        }
    };
}

/// A read a write needs first: its value, or (as a refusal) the API's message.
macro_rules! read {
    ($req:expr, $read:expr) => {
        match $read {
            Ok(value) => Ok(value),
            Err(error) => match refused(error) {
                Ok(errors) => Err(errors),
                Err(denied) => return denied.answer(&$req),
            },
        }
    };
}

/// \`/containers/{id}\`: the lines a product contains (read and replaced there).
fn containers(id: &str) -> String {
    format!("/containers{}", under(id, &[]))
}

fn caller<'a>(config: &'a Shared, headers: &'a HeaderMap, receipt: Option<&'a Receipt>) -> Caller<'a> {
    config.platform.caller(headers, config.proto, receipt)
}

/// The page's reads: the item, what it contains and what contains it, at once; then, when it has
/// content lines, the names they are shown with (admin-web reads the same lists).
async fn screen(caller: &Caller<'_>, id: &str) -> Result<ItemScreen, ApiError> {
    let (item, contents, contained) = join3(
        caller.get::<ItemDetail>(Kind::Items, id),
        caller.read_at::<List<ContentLine>>(Kind::ProductContents, &containers(id)),
        caller.read_at::<List<ContentLine>>(Kind::ProductContents, &format!("/contained{}", under(id, &[]))),
    )
    .await;
    let item = item?;
    let (contents, containers) = (contents.ok().map(|l| l.items), contained.ok().map(|l| l.items));
    let any = |lines: &Option<Vec<ContentLine>>| lines.as_ref().is_some_and(|l| !l.is_empty());
    let labels = if any(&contents) || any(&containers) { labels(caller).await } else { Labels::default() };
    Ok(ItemScreen { item, contents, containers, labels })
}

/// The content types', policies' and active items' names (\`useProductContentTypes\`,
/// \`useProductContentInclusionPolicies\`, \`useCatalogItemList("limit=500&status=active")\`).
/// A line whose item is not among them shows its id, as admin-web's does.
async fn labels(caller: &Caller<'_>) -> Labels {
    let choices = content_choices(caller).await;
    Labels {
        items: choices.items.into_iter().map(|i| (i.catalog_item_id, i.title)).collect(),
        content_types: choices.types.iter().map(|c| (c.id.clone(), choice_label(c))).collect(),
        inclusion_policies: choices.policies.iter().map(|c| (c.id.clone(), choice_label(c))).collect(),
    }
}

/// What Add content line picks from: the active content types, policies and items. A list the
/// API does not give is empty.
async fn content_choices(caller: &Caller<'_>) -> ContentChoices {
    let (types, policies, items) = join3(
        caller.read_at::<List<ContentChoice>>(Kind::ProductContents, "/content-types"),
        caller.read_at::<List<ContentChoice>>(Kind::ProductContents, "/inclusion-policies"),
        caller.list::<ItemRow>(Kind::Items, "limit=500&status=active"),
    )
    .await;
    let active = |list: Result<List<ContentChoice>, ApiError>| -> Vec<ContentChoice> {
        list.map(|l| l.items.into_iter().filter(|c| c.status == "active").collect()).unwrap_or_default()
    };
    ContentChoices { types: active(types), policies: active(policies), items: items.map(|l| l.items).unwrap_or_default() }
}

/// What Set Field Value picks from: the active fields and reference records.
async fn field_choices(caller: &Caller<'_>) -> FieldChoices {
    let (fields, references) = join(
        caller.list::<Field>(Kind::Fields, "limit=500&status=active"),
        caller.list::<ReferenceRow>(Kind::ReferenceRecords, "limit=500&status=active"),
    )
    .await;
    FieldChoices {
        fields: fields.map(|l| l.items).unwrap_or_default(),
        references: references.map(|l| l.items).unwrap_or_default(),
    }
}

async fn page(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Item<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, url::After { after_write: route.after_write, done: route.done });
    render(&req, &staff.viewer, &config, &headers, &id, &after, ItemBack::Nothing).await
}

/// The page, with \`back\` in place of a form's default.
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &url::After,
    back: ItemBack,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = caller(config, headers, receipt.as_ref());
    let screen = match screen(&caller, id).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let (notice, open) = (after.done.map(|done| done.notice(t)), after.done.and_then(Change::fold));
    let view = views::item_page(t, req.t(), &screen, notice, open, back);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_item()} head="">{view}</crate::views::Layout>
        },
    )
}

/// After a write to item \`id\`: its page, waiting for the write.
fn to_item(req: &Req, id: &str, written: &Written, done: Change) -> HtmlResult {
    req.redirect(&url::Item { id, after_write: receipt(written), done: Some(done) })
}

/// A form that came back: the form as a patch (422), or the page with it in its open dialog.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn invalid(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    errors: &Errors,
    form: impl Patch,
    back: ItemBack,
) -> HtmlResult {
    let after = url::After::default();
    req.invalid(errors, form, || render(req, viewer, config, headers, id, &after, back)).await
}

/// A dialog the server draws when it is opened: the dialog as a patch, or the page with it open.
async fn opened(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    dialog: impl Patch,
    back: ItemBack,
) -> HtmlResult {
    if req.mode == Mode::Action {
        return req.patch(dialog);
    }
    render(req, viewer, config, headers, id, &url::After::default(), back).await
}

/// A command to the item: \`/api/catalog/items/{id}/{rest..}\`.
async fn item_command(caller: &Caller<'_>, method: Method, id: &str, rest: &[&str], body: Option<&Value>) -> Sent {
    command(caller, method, Kind::Items, &under(id, rest), body).await
}

/// A row's one-button write that came back: the row's form with the refusal.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn row_refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    (form, action, label): (String, String, &str),
    hidden: &[(FieldName, &str)],
    errors: Errors,
) -> HtmlResult {
    let refusal = (form.clone(), errors.clone());
    let view = views::RowForm { id: &form, action: &action, label, hidden, refused: Some(&refusal) };
    invalid(req, viewer, config, headers, id, &errors, view, ItemBack::Row(form.clone(), errors.clone())).await
}

// Publish and archive.

async fn publish_form(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Publish<'_>>,
    Form(input): Form<PublishInput>,
) -> HtmlResult {
    let id = route.id;
    let draft = Draft::new(input);
    if req.mode == Mode::Action {
        let readiness = readiness_now(&caller(&config, &headers, None), &id).await;
        return req.patch(views::PublishForm { t: req.t(), id: &id, form: &draft, readiness: &readiness });
    }
    render(&req, &staff.viewer, &config, &headers, &id, &url::After::default(), ItemBack::Publish(draft)).await
}

/// The item's display identity readiness as the API has it now (admin-web's Recheck); unavailable
/// when it cannot say.
async fn readiness_now(caller: &Caller<'_>, id: &str) -> Readiness {
    let item = caller.get::<ItemDetail>(Kind::Items, id).await;
    item.ok().and_then(|item| item.display_identity_publication).unwrap_or_else(Readiness::unavailable)
}

async fn publish(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Publish<'_>>,
    Form(input): Form<PublishInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = caller(&config, &headers, None);
    let errors =
        sent!(req, id, item_command(&caller, Method::POST, &id, &["publish"], Some(&input.body())).await, Change::Published);
    let readiness = readiness_now(&caller, &id).await;
    let draft = Draft { input, errors };
    let form = views::PublishForm { t: req.t(), id: &id, form: &draft, readiness: &readiness };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Publish(draft.clone())).await
}

async fn lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Lifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.of(&["archive"]) {
        Some(action) => {
            let caller = caller(&config, &headers, None);
            sent!(req, id, item_command(&caller, Method::POST, &id, &[action], None).await, Change::Archived)
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::item_transitions(t, &input.status);
    let action = url::Lifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: views::ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    invalid(&req, &staff.viewer, &config, &headers, &id, &errors, form, ItemBack::Lifecycle(errors.clone())).await
}

// The item's values.

async fn blueprint(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Blueprint<'_>>,
    Form(input): Form<IdInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.check(req.t()) {
        Ok(blueprint) => {
            let body = json!({ "blueprintId": blueprint });
            let caller = caller(&config, &headers, None);
            sent!(req, id, item_command(&caller, Method::POST, &id, &["blueprint"], Some(&body)).await, Change::BlueprintAssigned)
        }
        Err(errors) => errors,
    };
    let t: Cat = req.t();
    let draft = Draft { input, errors };
    let action = url::Blueprint { id: &id }.href();
    let form = views::IdForm {
        id: ids::BLUEPRINT,
        action: &action,
        label: t.item_blueprint_id(),
        submit: t.item_assign(),
        form: &draft,
    };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Blueprint(draft.clone())).await
}

async fn metadata(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Metadata<'_>>,
    Form(input): Form<MetadataInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = caller(&config, &headers, None);
    // The title and subtitle go back as the API holds them now, not as the page was drawn.
    let errors = match read!(req, caller.get::<ItemDetail>(Kind::Items, &id).await) {
        Ok(item) => sent!(
            req,
            id,
            item_command(&caller, Method::PUT, &id, &["metadata"], Some(&input.body(&item))).await,
            Change::MetadataRevised
        ),
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::MetadataForm { t: req.t(), id: &id, form: &draft };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Metadata(draft.clone())).await
}

async fn tags(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Tags<'_>>,
    Form(input): Form<ListInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = caller(&config, &headers, None);
    let body = json!({ "tags": parts(&input.text, ',') });
    let errors = sent!(req, id, item_command(&caller, Method::PUT, &id, &["tags"], Some(&body)).await, Change::TagsUpdated);
    let t: Cat = req.t();
    let draft = Draft { input, errors };
    let action = url::Tags { id: &id }.href();
    let form = views::ListForm {
        id: ids::TAGS,
        action: &action,
        label: t.item_tags_2(),
        lines: false,
        submit: t.item_save_2(),
        form: &draft,
    };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Tags(draft.clone())).await
}

async fn image_urls(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::ImageUrls<'_>>,
    Form(input): Form<ListInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = caller(&config, &headers, None);
    let body = json!({ "imageUrls": parts(&input.text, '\n') });
    let errors =
        sent!(req, id, item_command(&caller, Method::PUT, &id, &["image-urls"], Some(&body)).await, Change::ImageUrlsUpdated);
    let t: Cat = req.t();
    let draft = Draft { input, errors };
    let action = url::ImageUrls { id: &id }.href();
    let form = views::ListForm {
        id: ids::URLS,
        action: &action,
        label: t.item_image_urls_2(),
        lines: true,
        submit: t.item_save_3(),
        form: &draft,
    };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Urls(draft.clone())).await
}

async fn fallback(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Fallback<'_>>,
    Form(input): Form<FallbackInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.body(req.t()) {
        Ok(body) => {
            let caller = caller(&config, &headers, None);
            sent!(
                req,
                id,
                item_command(&caller, Method::PUT, &id, &["image-fallback"], Some(&body)).await,
                Change::FallbackUpdated
            )
        }
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::FallbackForm { t: req.t(), id: &id, form: &draft };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Fallback(draft.clone())).await
}

async fn clear_fallback(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::FallbackClear<'_>>,
) -> HtmlResult {
    let id = route.id;
    let caller = caller(&config, &headers, None);
    let errors =
        sent!(req, id, item_command(&caller, Method::DELETE, &id, &["image-fallback"], None).await, Change::FallbackCleared);
    let t: Cat = req.t();
    let row = (ids::FALLBACK_CLEAR.to_owned(), url::FallbackClear { id: &id }.href(), t.item_clear_image_fallback());
    row_refused(&req, &staff.viewer, &config, &headers, &id, row, &[], errors).await
}

// Field values and categories.

async fn field_dialog(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Fields<'_>>,
) -> HtmlResult {
    let id = route.id;
    let choices = field_choices(&caller(&config, &headers, None)).await;
    let draft = Draft::new(FieldValueInput::default());
    let dialog = views::FieldDialog { t: req.t(), p: req.t(), id: &id, form: &draft, choices: &choices };
    opened(&req, &staff.viewer, &config, &headers, &id, dialog, ItemBack::Field(draft.clone(), choices.clone())).await
}

async fn set_field(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Fields<'_>>,
    Form(input): Form<FieldValueInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = caller(&config, &headers, None);
    let field_id = input.field_id.trim().to_owned();
    // Whether the field takes a reference record is the field's own (admin-web reads it from the
    // field it picked), so a record left picked for another field is not sent.
    let reference =
        !field_id.is_empty() && caller.get::<Field>(Kind::Fields, &field_id).await.is_ok_and(|f| f.value_type == "reference");
    let errors = match input.body(reference, req.t()) {
        Ok(body) => {
            sent!(req, id, item_command(&caller, Method::PUT, &id, &["fields", &field_id], Some(&body)).await, Change::FieldSet)
        }
        Err(errors) => errors,
    };
    let choices = field_choices(&caller).await;
    let draft = Draft { input, errors };
    let form = views::FieldValueForm { t: req.t(), id: &id, form: &draft, choices: &choices };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Field(draft.clone(), choices.clone()))
        .await
}

async fn clear_field(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::FieldClear<'_>>,
) -> HtmlResult {
    let (id, field_id) = (route.id, route.field_id);
    let caller = caller(&config, &headers, None);
    let errors =
        sent!(req, id, item_command(&caller, Method::DELETE, &id, &["fields", &field_id], None).await, Change::FieldCleared);
    let t: Cat = req.t();
    let row = (ids::row("field", &field_id), url::FieldClear { id: &id, field_id: &field_id }.href(), t.item_clear());
    row_refused(&req, &staff.viewer, &config, &headers, &id, row, &[], errors).await
}

async fn assign_category(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Categories<'_>>,
    Form(input): Form<IdInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.check(req.t()) {
        Ok(category) => {
            let caller = caller(&config, &headers, None);
            sent!(
                req,
                id,
                item_command(&caller, Method::POST, &id, &["categories", category], None).await,
                Change::CategoryAssigned
            )
        }
        Err(errors) => errors,
    };
    let t: Cat = req.t();
    let draft = Draft { input, errors };
    let action = url::Categories { id: &id }.href();
    let form = views::IdForm {
        id: ids::CATEGORY,
        action: &action,
        label: t.item_category_id(),
        submit: t.item_assign_2(),
        form: &draft,
    };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Category(draft.clone())).await
}

async fn remove_category(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::CategoryRemove<'_>>,
) -> HtmlResult {
    let (id, category_id) = (route.id, route.category_id);
    let caller = caller(&config, &headers, None);
    let errors = sent!(
        req,
        id,
        item_command(&caller, Method::DELETE, &id, &["categories", &category_id], None).await,
        Change::CategoryRemoved
    );
    let t: Cat = req.t();
    let row =
        (ids::row("category", &category_id), url::CategoryRemove { id: &id, category_id: &category_id }.href(), t.item_remove());
    row_refused(&req, &staff.viewer, &config, &headers, &id, row, &[], errors).await
}

// External references.

/// Which references: a catalog item reference, or a product reference (with options).
#[derive(Clone, Copy)]
enum Refs {
    CatalogItem,
    Product,
}

impl Refs {
    fn path(self) -> &'static str {
        match self {
            Refs::CatalogItem => "external-catalog-item-references",
            Refs::Product => "external-product-references",
        }
    }
}

async fn link(
    req: Req,
    viewer: &Viewer,
    config: Shared,
    headers: HeaderMap,
    id: String,
    input: ReferenceInput,
    refs: Refs,
) -> HtmlResult {
    let errors = match input.check(req.t()) {
        Ok((provider, key)) => {
            let caller = caller(&config, &headers, None);
            let (body, done) = match refs {
                Refs::CatalogItem => (None, Change::CatalogRefLinked),
                Refs::Product => (Some(input.product_body()), Change::ProductRefLinked),
            };
            sent!(req, id, item_command(&caller, Method::PUT, &id, &[refs.path(), provider, key], body.as_ref()).await, done)
        }
        Err(errors) => errors,
    };
    let product = matches!(refs, Refs::Product);
    let draft = Draft { input, errors };
    let t = req.t();
    if product {
        let form = views::ReferenceForm { t, id: &id, form_id: ids::PRODUCT_REF, product, form: &draft };
        invalid(&req, viewer, &config, &headers, &id, &draft.errors, form, ItemBack::ProductRef(draft.clone())).await
    } else {
        let form = views::ReferenceForm { t, id: &id, form_id: ids::CATALOG_REF, product, form: &draft };
        invalid(&req, viewer, &config, &headers, &id, &draft.errors, form, ItemBack::CatalogRef(draft.clone())).await
    }
}

async fn unlink(
    req: Req,
    viewer: &Viewer,
    config: Shared,
    headers: HeaderMap,
    id: String,
    input: ReferenceInput,
    refs: Refs,
) -> HtmlResult {
    let (provider, key) = (input.provider_key.as_str(), input.external_key.as_str());
    let errors = if provider.is_empty() || key.is_empty() {
        not_offered(req.t())
    } else {
        let caller = caller(&config, &headers, None);
        let done = if matches!(refs, Refs::Product) { Change::ProductRefUnlinked } else { Change::CatalogRefUnlinked };
        sent!(req, id, item_command(&caller, Method::DELETE, &id, &[refs.path(), provider, key], None).await, done)
    };
    let t: Cat = req.t();
    let f = ReferenceInput::FIELDS;
    let (kind, action) = match refs {
        Refs::CatalogItem => ("catalog-ref", url::CatalogRefUnlink { id: &id }.href()),
        Refs::Product => ("product-ref", url::ProductRefUnlink { id: &id }.href()),
    };
    let row = (ids::row(kind, &format!("{provider}\u{0}{key}")), action, t.item_unlink());
    row_refused(
        &req,
        viewer,
        &config,
        &headers,
        &id,
        row,
        &[(f.provider_key.untyped(), provider), (f.external_key.untyped(), key)],
        errors,
    )
    .await
}

async fn link_catalog_ref(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::CatalogRefs<'_>>,
    Form(input): Form<ReferenceInput>,
) -> HtmlResult {
    let id = route.id;
    link(req, &staff.viewer, config, headers, id, input, Refs::CatalogItem).await
}

async fn unlink_catalog_ref(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::CatalogRefUnlink<'_>>,
    Form(input): Form<ReferenceInput>,
) -> HtmlResult {
    let id = route.id;
    unlink(req, &staff.viewer, config, headers, id, input, Refs::CatalogItem).await
}

async fn link_product_ref(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::ProductRefs<'_>>,
    Form(input): Form<ReferenceInput>,
) -> HtmlResult {
    let id = route.id;
    link(req, &staff.viewer, config, headers, id, input, Refs::Product).await
}

async fn unlink_product_ref(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::ProductRefUnlink<'_>>,
    Form(input): Form<ReferenceInput>,
) -> HtmlResult {
    let id = route.id;
    unlink(req, &staff.viewer, config, headers, id, input, Refs::Product).await
}

// Product contents.

async fn content_dialog(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Contents<'_>>,
) -> HtmlResult {
    let id = route.id;
    let choices = content_choices(&caller(&config, &headers, None)).await;
    // admin-web's dialog opens with the first type and policy chosen.
    let first = |list: &[ContentChoice]| list.first().map(|c| c.id.clone()).unwrap_or_default();
    let input = ContentLineInput {
        content_type_id: first(&choices.types),
        inclusion_policy_id: first(&choices.policies),
        ..ContentLineInput::blank()
    };
    let draft = Draft::new(input);
    let dialog = views::ContentDialog { t: req.t(), p: req.t(), id: &id, form: &draft, choices: &choices };
    opened(&req, &staff.viewer, &config, &headers, &id, dialog, ItemBack::Content(draft.clone(), choices.clone())).await
}

/// Replaces the item's content lines with those the API holds now, changed by \`change\`.
async fn replace_lines(
    caller: &Caller<'_>,
    id: &str,
    change: impl FnOnce(Vec<&ContentLine>) -> Vec<Value>,
) -> Result<Sent, ApiError> {
    let current = caller.read_at::<List<ContentLine>>(Kind::ProductContents, &containers(id)).await?;
    let lines = change(current.items.iter().collect());
    Ok(command(caller, Method::PUT, Kind::ProductContents, &containers(id), Some(&json!({ "lines": lines }))).await)
}

async fn add_content(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::Contents<'_>>,
    Form(input): Form<ContentLineInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = caller(&config, &headers, None);
    let errors = match input.line(req.t()) {
        Ok(line) => {
            let replaced = replace_lines(&caller, &id, |lines| lines.into_iter().map(line_input).chain([line]).collect()).await;
            match read!(req, replaced) {
                Ok(sent) => sent!(req, id, sent, Change::ContentsUpdated),
                Err(errors) => errors,
            }
        }
        Err(errors) => errors,
    };
    let choices = content_choices(&caller).await;
    let draft = Draft { input, errors };
    let form = views::ContentForm { t: req.t(), id: &id, form: &draft, choices: &choices };
    invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, ItemBack::Content(draft.clone(), choices.clone()))
        .await
}

async fn remove_content(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::item::url::ContentRemove<'_>>,
) -> HtmlResult {
    let (id, line_id) = (route.id, route.line_id);
    let caller = caller(&config, &headers, None);
    let replaced =
        replace_lines(&caller, &id, |lines| lines.into_iter().filter(|l| l.line_id != line_id).map(line_input).collect()).await;
    let errors = match read!(req, replaced) {
        Ok(sent) => sent!(req, id, sent, Change::ContentsUpdated),
        Err(errors) => errors,
    };
    let t: Cat = req.t();
    let row = (ids::row("line", &line_id), url::ContentRemove { id: &id, line_id: &line_id }.href(), t.item_remove());
    row_refused(&req, &staff.viewer, &config, &headers, &id, row, &[], errors).await
}
