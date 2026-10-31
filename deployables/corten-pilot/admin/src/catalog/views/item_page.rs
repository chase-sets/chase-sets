//! A catalog item's page (admin-web's \`CatalogItemDetailPage\`): its values, where it came from,
//! its field values and the reference records they name, its categories, its product contents,
//! tags, images and external references, and a dialog for each change. Every dialog is a form
//! that works without JavaScript. The two whose lists are long (Set Field Value: the fields and
//! reference records; Add content line: the content types, policies and catalog items) are drawn
//! by the server when opened, so the page does not carry a thousand options it rarely uses.
use std::collections::{BTreeMap, BTreeSet, HashSet};

use corten::{
    form::Within,
    prelude::*,
    view::{AttrValue, Id},
};
use serde_json::Value;

use super::{
    Draft,
    detail_page::{ActionBar, DetailPage, KeyValues, LifecycleForm, Transition},
    dialog::{Dialog, Input, Toasts, Trigger},
    ids::item as ids,
    item_list::language,
    list_page::{Empty, Table},
};
use crate::{
    catalog::{
        api::{ContentChoice, ContentLine, Field, ItemDetail, ItemRow, Readiness, Reference, ReferenceRow, SelectedOption},
        form::{
            ContentLineInput, FallbackInput, FieldValueInput, IdInput, ListInput, MetadataInput, PublishInput, ReferenceInput,
        },
        url::{self, item as at},
    },
    text::{Cat, Pilot},
    views::admin_web,
};

const DASH: &str = "\u{2014}";

/// The item page's view model: the item, what it contains and what contains it (none when the
/// API could not say), and the names the content lines are shown with.
#[derive(serde::Serialize, ToJson)]
pub struct ItemScreen {
    pub item: ItemDetail,
    pub contents: Option<Vec<ContentLine>>,
    pub containers: Option<Vec<ContentLine>>,
    pub labels: Labels,
}

/// Names by id: catalog items, content types and inclusion policies.
#[derive(Default, serde::Serialize, ToJson)]
pub struct Labels {
    pub items: BTreeMap<String, String>,
    pub content_types: BTreeMap<String, String>,
    pub inclusion_policies: BTreeMap<String, String>,
}

impl Labels {
    fn item<'a>(&'a self, id: &'a str) -> &'a str {
        self.items.get(id).map_or(id, String::as_str)
    }

    fn content_type<'a>(&'a self, id: &'a str) -> &'a str {
        self.content_types.get(id).map_or(id, String::as_str)
    }

    fn policy<'a>(&'a self, id: &'a str) -> &'a str {
        self.inclusion_policies.get(id).map_or(id, String::as_str)
    }
}

/// What Set Field Value picks from: the active fields and reference records.
#[derive(Clone, Debug, Default)]
pub struct FieldChoices {
    pub fields: Vec<Field>,
    pub references: Vec<ReferenceRow>,
}

/// What Add content line picks from: the active content types, policies and catalog items.
#[derive(Clone, Debug, Default)]
pub struct ContentChoices {
    pub types: Vec<ContentChoice>,
    pub policies: Vec<ContentChoice>,
    pub items: Vec<ItemRow>,
}

/// \`localizedDisplayName(display_name) || key\`.
pub fn choice_label(choice: &ContentChoice) -> String {
    let values = choice.display_name.get("values");
    let default = choice.display_name.get("defaultLocale").and_then(Value::as_str).unwrap_or("en");
    let text = values
        .and_then(|v| v.get("en").or_else(|| v.get(default)).or_else(|| v.as_object().and_then(|m| m.values().next())))
        .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
        .unwrap_or_default();
    if text.is_empty() { choice.key.clone() } else { text }
}

/// A form the server drew again (refused, or a dialog it was asked to open), in place of its
/// default, drawn in its open dialog.
#[derive(Default)]
pub enum ItemBack {
    #[default]
    Nothing,
    Lifecycle(Errors),
    Publish(Draft<PublishInput>),
    Blueprint(Draft<IdInput>),
    Field(Draft<FieldValueInput>, FieldChoices),
    Category(Draft<IdInput>),
    Metadata(Draft<MetadataInput>),
    Tags(Draft<ListInput>),
    Urls(Draft<ListInput>),
    Fallback(Draft<FallbackInput>),
    CatalogRef(Draft<ReferenceInput>),
    ProductRef(Draft<ReferenceInput>),
    Content(Draft<ContentLineInput>, ContentChoices),
    /// A row's form, by its id, and its refusal.
    Row(String, Errors),
}

/// A part of the page that folds (admin-web's \`ProgressiveDisclosure\`), drawn open when the
/// write before changed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fold {
    Contents,
    Tags,
    Urls,
    Fallback,
    CatalogRefs,
    ProductRefs,
}

/// \`formatFieldValue\`.
pub fn field_text(value: &Value) -> String {
    match value {
        Value::Null => DASH.into(),
        Value::String(s) => s.clone(),
        Value::Bool(_) | Value::Number(_) => value.to_string(),
        Value::Object(map) if map.contains_key("values") => {
            let values = map.get("values").and_then(Value::as_object);
            values
                .and_then(|v| v.get("en").or_else(|| v.values().next()))
                .map_or_else(|| DASH.into(), |v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
        }
        _ => value.to_string(),
    }
}

fn capitalize(part: &str) -> String {
    let mut chars = part.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

/// \`formatReferenceTypeLabel\`: \`tcg_set\` is "TCG Set".
pub fn type_label(type_key: &str) -> String {
    type_key
        .split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|p| if p == "tcg" { "TCG".to_owned() } else { capitalize(p) })
        .collect::<Vec<_>>()
        .join(" ")
}

/// \`formatRelationshipType\`.
pub fn relationship_label(kind: &str) -> String {
    kind.split(['-', '_']).filter(|p| !p.is_empty()).map(capitalize).collect::<Vec<_>>().join(" ")
}

/// \`resolveFieldLabel\`: a name that is a field id (\`fld_seed_card_number\`) reads "Card Number".
fn field_label(name: &str) -> String {
    let Some(rest) = name.strip_prefix("fld_").or_else(|| name.strip_prefix("fld-")) else {
        return name.to_owned();
    };
    let rest = rest.strip_prefix("seed_").unwrap_or(rest);
    relationship_label(rest)
}

/// A row of the field values table: a field's value, or a reference record that a value's
/// record relates to (\`buildReferenceDetailRows\`).
pub struct DetailRow<'a> {
    pub label: String,
    pub value: String,
    pub reference: Option<&'a Reference>,
    /// The field, for a field's own row (which can be cleared).
    pub field_id: Option<&'a str>,
}

/// \`MAX_REFERENCE_DISPLAY_DEPTH\`.
const DEPTH: usize = 4;

/// The field values, then the records they relate to (each once, at most four steps away).
pub fn detail_rows(values: &[crate::catalog::api::FieldValue]) -> Vec<DetailRow<'_>> {
    let mut rows: Vec<DetailRow<'_>> = values
        .iter()
        .map(|v| DetailRow {
            label: field_label(&v.field_name),
            value: v.reference.as_ref().map_or_else(|| field_text(&v.value), |r| r.name.clone()),
            reference: v.reference.as_ref(),
            field_id: Some(&v.field_id),
        })
        .collect();
    let direct: HashSet<&str> = values.iter().filter_map(|v| v.reference.as_ref()).map(|r| r.reference_id.as_str()).collect();
    let mut inherited = HashSet::new();
    let mut counts = BTreeMap::new();
    for reference in values.iter().filter_map(|v| v.reference.as_ref()) {
        let path = vec![reference.reference_id.as_str()];
        inherit(&mut rows, reference, &path, &direct, &mut inherited, &mut counts, 0);
    }
    rows
}

fn inherit<'a>(
    rows: &mut Vec<DetailRow<'a>>,
    reference: &'a Reference,
    path: &[&'a str],
    direct: &HashSet<&'a str>,
    inherited: &mut HashSet<&'a str>,
    counts: &mut BTreeMap<String, usize>,
    depth: usize,
) {
    if depth >= DEPTH {
        return;
    }
    for relationship in &reference.relationships {
        let Some(related) = relationship.reference.as_deref() else { continue };
        let id = related.reference_id.as_str();
        if path.contains(&id) {
            continue;
        }
        if !direct.contains(id) && inherited.insert(id) {
            let base = type_label(&related.type_key);
            let count = counts.entry(base.clone()).or_insert(0);
            let label =
                if *count == 0 { base } else { format!("{base} ({})", relationship_label(&relationship.relationship_type)) };
            *count += 1;
            rows.push(DetailRow { label, value: related.name.clone(), reference: Some(related), field_id: None });
        }
        let mut next = path.to_vec();
        next.push(id);
        inherit(rows, related, &next, direct, inherited, counts, depth + 1);
    }
}

/// \`formatSelectedOptions\`.
fn options_label(t: Cat, options: Option<&Vec<SelectedOption>>) -> String {
    match options {
        Some(options) if !options.is_empty() => options
            .iter()
            .map(|o| t.item_selected_option_reference(&o.dimension_id, &o.option_id).to_string())
            .collect::<Vec<_>>()
            .join(", "),
        _ => t.item_all_product_options().to_owned(),
    }
}

fn quantity(t: Cat, q: Option<f64>) -> String {
    q.map_or_else(|| t.item_unspecified().to_owned(), |q| Value::from(q).to_string().trim_end_matches(".0").to_owned())
}

/// The provider keys that link the item back to the imports that made it (its origin), each
/// once, sorted.
fn origins(item: &ItemDetail) -> BTreeSet<&str> {
    item.external_product_references
        .iter()
        .chain(&item.external_catalog_item_references)
        .map(|r| r.provider_key.trim())
        .filter(|k| !k.is_empty())
        .collect()
}

/// The status changes the item's status allows (\`getTransitions\`): a draft publishes from its
/// dialog, an active item archives after asking.
pub fn item_transitions(t: Cat, status: &str) -> Vec<Transition> {
    match status {
        "active" => vec![Transition { action: "archive", label: t.item_archive(), confirm: true }],
        _ => Vec::new(),
    }
}

/// The page.
pub fn item_page<'a>(
    t: Cat,
    p: Pilot,
    screen: &'a ItemScreen,
    notice: Option<String>,
    open: Option<Fold>,
    back: ItemBack,
) -> impl Render + 'a {
    let item = &screen.item;
    let id = item.catalog_item_id.as_str();
    let editable = item.status != "archived";
    let list = url::Items::default().href();
    let lifecycle_errors = match &back {
        ItemBack::Lifecycle(errors) => errors.clone(),
        _ => Errors::new(),
    };
    let row_errors = match &back {
        ItemBack::Row(form, errors) => Some((form.clone(), errors.clone())),
        _ => None,
    };
    let lifecycle = at::Lifecycle { id }.href();
    let steps = item_transitions(t, &item.status);
    let items = [
        (t.item_title(), item.title.clone()),
        (t.item_subtitle(), item.subtitle.clone().unwrap_or_else(|| DASH.into())),
        (t.item_language(), language(t, &item.language_code).to_owned()),
        (t.item_description(), item.description.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| DASH.into())),
        (t.item_blueprint(), item.blueprint.as_ref().map_or_else(|| t.item_none().to_owned(), |b| b.name.clone())),
        (t.item_status(), item.status.clone()),
        (t.item_updated(), item.updated_at.clone()),
    ];
    let origin = origins(item);
    let rows = detail_rows(&item.field_values);
    html! {
        <DetailPage p={p} list={&list} list_label={t.item_catalog_items()} name={&item.title}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={super::ids::LIFECYCLE}
                    action={&lifecycle}
                    status={&item.status}
                    transitions={&steps}
                    errors={&lifecycle_errors}
                />
                if item.status == "draft" {
                    <Trigger dialog={ids::PUBLISH_DIALOG} label={t.item_publish()} secondary={false} />
                }
                if editable {
                    <Trigger dialog={ids::METADATA_DIALOG} label={t.item_edit_description()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
            <PartList>
                if !origin.is_empty() {
                    <Origin t={t} providers={&origin} />
                }
                if item.status == "draft" && item.blueprint.is_none() {
                    <ItemPage title={t.item_blueprint()}>
                        <div><Trigger dialog={ids::BLUEPRINT_DIALOG} label={t.item_assign_blueprint()} secondary={false} /></div>
                    </ItemPage>
                }
                <FieldValues t={t} id={id} rows={&rows} editable={editable} refused={row_errors.as_ref()} />
                <Categories t={t} id={id} item={item} editable={editable} refused={row_errors.as_ref()} />
                <Contents
                    t={t}
                    p={p}
                    screen={screen}
                    editable={editable}
                    open={open == Some(Fold::Contents)}
                    refused={row_errors.as_ref()}
                />
                <Tags t={t} item={item} editable={editable} open={open == Some(Fold::Tags)} />
                <ImageUrls t={t} item={item} editable={editable} open={open == Some(Fold::Urls)} />
                <ImageFallback
                    t={t}
                    item={item}
                    editable={editable}
                    open={open == Some(Fold::Fallback)}
                    refused={row_errors.as_ref()}
                />
                <References
                    t={t}
                    item={item}
                    product={false}
                    editable={editable}
                    open={open == Some(Fold::CatalogRefs)}
                    refused={row_errors.as_ref()}
                />
                <References
                    t={t}
                    item={item}
                    product
                    editable={editable}
                    open={open == Some(Fold::ProductRefs)}
                    refused={row_errors.as_ref()}
                />
            </PartList>
        </DetailPage>
        <ReferenceDialogs t={t} rows={&rows} />
        if editable {
            {dialogs(t, p, item, back)}
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The page's dialogs, each with its default form or the one that came back.
fn dialogs<'a>(t: Cat, p: Pilot, item: &'a ItemDetail, back: ItemBack) -> impl Render + 'a {
    let id = item.catalog_item_id.as_str();
    let close = p.catalog_close();
    let mut publish = (Draft::new(PublishInput::default()), false);
    let mut blueprint = (Draft::new(IdInput::default()), false);
    let mut category = (Draft::new(IdInput::default()), false);
    let mut metadata = (Draft::new(MetadataInput::of(item)), false);
    let mut tags = (Draft::new(ListInput { text: item.tags.join(", ") }), false);
    let mut urls = (Draft::new(ListInput { text: item.image_urls.join("\n") }), false);
    let mut fallback = (Draft::new(FallbackInput::of(item)), false);
    let mut catalog_ref = (Draft::new(ReferenceInput::blank()), false);
    let mut product_ref = (Draft::new(ReferenceInput::blank()), false);
    let mut field = None;
    let mut content = None;
    match back {
        ItemBack::Publish(d) => publish = (d, true),
        ItemBack::Blueprint(d) => blueprint = (d, true),
        ItemBack::Category(d) => category = (d, true),
        ItemBack::Metadata(d) => metadata = (d, true),
        ItemBack::Tags(d) => tags = (d, true),
        ItemBack::Urls(d) => urls = (d, true),
        ItemBack::Fallback(d) => fallback = (d, true),
        ItemBack::CatalogRef(d) => catalog_ref = (d, true),
        ItemBack::ProductRef(d) => product_ref = (d, true),
        ItemBack::Field(d, choices) => field = Some((d, choices)),
        ItemBack::Content(d, choices) => content = Some((d, choices)),
        ItemBack::Nothing | ItemBack::Lifecycle(_) | ItemBack::Row(..) => {}
    }
    let readiness = item.display_identity_publication.clone().unwrap_or_else(Readiness::unavailable);
    html! {
        if item.status == "draft" {
            <Dialog
                id={ids::PUBLISH_DIALOG}
                title={t.item_publish_catalog_item()}
                description={Some(t.item_confirm_that_the_blueprint_is_active())}
                open={publish.1}
                close={&close}
            >
                <PublishForm t={t} id={id} form={&publish.0} readiness={&readiness} />
            </Dialog>
        }
        if item.status == "draft" && item.blueprint.is_none() {
            <Dialog
                id={ids::BLUEPRINT_DIALOG}
                title={t.item_assign_blueprint_2()}
                description={None}
                open={blueprint.1}
                close={&close}
            >
                <IdForm
                    id={ids::BLUEPRINT}
                    action={&at::Blueprint { id }.href()}
                    label={t.item_blueprint_id()}
                    submit={t.item_assign()}
                    form={&blueprint.0}
                />
            </Dialog>
        }
        if let Some((draft, choices)) = &field {
            <FieldDialog t={t} p={p} id={id} form={draft} choices={choices} />
        } else {
            <dialog id={ids::FIELD_DIALOG}></dialog>
        }
        <Dialog id={ids::CATEGORY_DIALOG} title={t.item_assign_category_2()} description={None} open={category.1} close={&close}>
            <IdForm
                id={ids::CATEGORY}
                action={&at::Categories { id }.href()}
                label={t.item_category_id()}
                submit={t.item_assign_2()}
                form={&category.0}
            />
        </Dialog>
        <Dialog id={ids::METADATA_DIALOG} title={t.item_edit_description_2()} description={None} open={metadata.1} close={&close}>
            <MetadataForm t={t} id={id} form={&metadata.0} />
        </Dialog>
        <Dialog
            id={ids::TAGS_DIALOG}
            title={t.item_set_tags_2()}
            description={Some(t.item_enter_tags_separated_by_commas())}
            open={tags.1}
            close={&close}
        >
            <ListForm
                id={ids::TAGS}
                action={&at::Tags { id }.href()}
                label={t.item_tags_2()}
                lines={false}
                submit={t.item_save_2()}
                form={&tags.0}
            />
        </Dialog>
        <Dialog
            id={ids::URLS_DIALOG}
            title={t.item_set_image_urls_2()}
            description={Some(t.item_enter_one_url_per_line())}
            open={urls.1}
            close={&close}
        >
            <ListForm
                id={ids::URLS}
                action={&at::ImageUrls { id }.href()}
                label={t.item_image_urls_2()}
                lines
                submit={t.item_save_3()}
                form={&urls.0}
            />
        </Dialog>
        <Dialog
            id={ids::FALLBACK_DIALOG}
            title={t.item_set_image_fallback_2()}
            description={Some(t.item_image_fallback_description())}
            open={fallback.1}
            close={&close}
        >
            <FallbackForm t={t} id={id} form={&fallback.0} />
        </Dialog>
        <Dialog
            id={ids::CATALOG_REF_DIALOG}
            title={t.item_link_external_catalog_item_reference_2()}
            description={Some(t.item_external_catalog_item_reference_description())}
            open={catalog_ref.1}
            close={&close}
        >
            <ReferenceForm t={t} id={id} form_id={ids::CATALOG_REF} product={false} form={&catalog_ref.0} />
        </Dialog>
        <Dialog
            id={ids::PRODUCT_REF_DIALOG}
            title={t.item_link_external_reference_2()}
            description={Some(t.item_external_reference_description())}
            open={product_ref.1}
            close={&close}
        >
            <ReferenceForm t={t} id={id} form_id={ids::PRODUCT_REF} product form={&product_ref.0} />
        </Dialog>
        if let Some((draft, choices)) = &content {
            <ContentDialog t={t} p={p} id={id} form={draft} choices={choices} />
        } else {
            <dialog id={ids::CONTENT_DIALOG}></dialog>
        }
    }
}

/// A part of the page (\`PageSection\`).
#[component(css)]
pub fn ItemPage<'a, C: Render>(title: &'a str, children: C) -> impl Render {
    html! {
        <section class={Part}>
            <h2 class={PartTitle}>{title}</h2>
            {children}
        </section>
    }
}

/// The page's parts, spaced.
#[component(css = ItemPage)]
fn PartList<C: Render>(children: C) -> impl Render {
    html! { <div class={Parts}>{children}</div> }
}

/// A part that folds (\`ProgressiveDisclosure\`): its title, a summary, and what it holds.
#[component(css = ItemPage)]
pub(super) fn Disclosure<'a, C: Render>(title: &'a str, summary: &'a str, tone: &'a str, open: bool, children: C) -> impl Render {
    html! {
        <details class={Fold} data-tone={tone} open={open}>
            <summary>
                <span class={FoldTitle}>{title}</span>
                <span class={Muted}>{summary}</span>
            </summary>
            <div class={FoldBody}>{children}</div>
        </details>
    }
}

/// A row's one-button form (clear, remove, unlink), its refusal next to it. `id`: its key
/// (`ids::row`).
#[component(css = ItemPage)]
pub fn RowForm<'a>(
    id: &'a str,
    action: &'a str,
    label: &'a str,
    hidden: &'a [(FieldName, &'a str)],
    refused: Option<&'a (String, Errors)>,
) -> impl Patch {
    let errors = refused.filter(|(form, _)| form == id).map(|(_, e)| e.clone()).unwrap_or_default();
    html! {
        <form class={RowForm} id={ids::ItemId(id)} method="post" action={action} data-patch>
            for (name, value) in hidden {
                <input type="hidden" name={*name} value={*value}>
            }
            <button type="submit" class={(Small, Danger)}>{label}</button>
            {errors.form_message()}
        </form>
    }
}

/// The imports that made the item, by provider (admin-web's Originating import).
#[component(css = ItemPage)]
fn Origin<'a>(t: Cat, providers: &'a BTreeSet<&'a str>) -> impl Render {
    html! {
        <ItemPage title={t.item_origin_title()}>
            <p class={Muted}>{t.item_origin_description()}</p>
            <div class={Buttons}>
                for provider in providers {
                    let query = format!("/catalog/integrations?providerKey={}", crate::api::segment(provider));
                    let href = admin_web(&query).map(|u| u.to_string()).unwrap_or_default();
                    <a class={Link} href={&href}>{t.item_view_source_observations()} " (" {*provider} ")"</a>
                }
            </div>
        </ItemPage>
    }
}

/// The field values and the records they relate to.
#[component(css = ItemPage)]
fn FieldValues<'a>(
    t: Cat,
    id: &'a str,
    rows: &'a [DetailRow<'a>],
    editable: bool,
    refused: Option<&'a (String, Errors)>,
) -> impl Render {
    let head = [t.item_field(), t.item_value(), ""];
    let open = at::Fields::of(id).href();
    html! {
        <ItemPage title={t.item_field_values()}>
            if editable {
                <form class={Opener} method="get" action={&open} data-patch>
                    <button type="submit" class={Small}>{t.item_set_field_value()}</button>
                </form>
            }
            if rows.is_empty() {
                <Empty title={t.item_no_field_values()} description="" />
            } else {
                <Table label={t.item_field_values()} head={&head} all={None}>
                    for row in rows {
                        <tr>
                            <td>{&row.label}</td>
                            <td>
                                if let Some(reference) = row.reference {
                                    let label = t.item_reference_value_aria(&row.label, &reference.name).to_string();
                                    <button
                                        type="button"
                                        class={Cue}
                                        command="show-modal"
                                        commandfor={ids::ItemId(&ids::reference(&reference.reference_id))}
                                        aria-label={&label}
                                        aria-haspopup="dialog"
                                    >
                                        {&reference.name}
                                    </button>
                                } else {
                                    {&row.value}
                                }
                            </td>
                            <td>
                                if let (true, Some(field)) = (editable, row.field_id) {
                                    let form = ids::row("field", field);
                                    let action = at::FieldClear { id, field_id: field }.href();
                                    <RowForm id={&form} action={&action} label={t.item_clear()} hidden={&[]} refused={refused} />
                                }
                            </td>
                        </tr>
                    }
                </Table>
            }
        </ItemPage>
    }
}

/// A dialog for each reference record the field values name (each once).
#[component(css = ItemPage)]
fn ReferenceDialogs<'a>(t: Cat, rows: &'a [DetailRow<'a>]) -> impl Render {
    let mut seen = HashSet::new();
    let references: Vec<&Reference> =
        rows.iter().filter_map(|r| r.reference).filter(|r| seen.insert(r.reference_id.as_str())).collect();
    html! {
        for reference in references {
            let dialog = ids::reference(&reference.reference_id);
            let kind = type_label(&reference.type_key);
            let about = [
                (t.item_reference_type(), kind.clone()),
                (t.item_reference_status(), reference.status.clone()),
                (t.item_reference_key(), reference.key.clone()),
            ];
            let attributes: Vec<(String, String)> = reference
                .attributes
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), field_text(v))).collect())
                .unwrap_or_default();
            let related: Vec<(String, String)> = reference
                .relationships
                .iter()
                .map(|r| (relationship_label(&r.relationship_type), r.reference.as_ref().map_or_else(|| r.reference_id.clone(), |x| x.name.clone())))
                .collect();
            <Dialog
                id={ids::ItemId(&dialog)}
                title={&reference.name}
                description={Some(&kind)}
                open={false}
                close={t.item_close_reference_detail()}
            >
                <KeyValues items={&about} />
                <h3 class={SubTitle}>{t.item_reference_attributes()}</h3>
                if attributes.is_empty() {
                    <p class={Muted}>{t.item_reference_no_attributes()}</p>
                } else {
                    <dl class={Pairs}>
                        for (key, value) in &attributes {
                            <dt>{key}</dt>
                            <dd>{value}</dd>
                        }
                    </dl>
                }
                <h3 class={SubTitle}>{t.item_reference_relationships()}</h3>
                if related.is_empty() {
                    <p class={Muted}>{t.item_reference_no_relationships()}</p>
                } else {
                    <dl class={Pairs}>
                        for (key, value) in &related {
                            <dt>{key}</dt>
                            <dd>{value}</dd>
                        }
                    </dl>
                }
            </Dialog>
        }
    }
}

#[component(css = ItemPage)]
fn Categories<'a>(
    t: Cat,
    id: &'a str,
    item: &'a ItemDetail,
    editable: bool,
    refused: Option<&'a (String, Errors)>,
) -> impl Render {
    let head = [t.item_category(), ""];
    html! {
        <ItemPage title={t.item_categories()}>
            if editable {
                <div><Trigger dialog={ids::CATEGORY_DIALOG} label={t.item_assign_category()} secondary={false} /></div>
            }
            if item.categories.is_empty() {
                <p class={Muted}>{t.item_no_categories_assigned()}</p>
            } else {
                <Table label={t.item_categories()} head={&head} all={None}>
                    for category in &item.categories {
                        <tr>
                            <td>{&category.name}</td>
                            <td>
                                if editable {
                                    let form = ids::row("category", &category.category_id);
                                    let action = at::CategoryRemove { id, category_id: &category.category_id }.href();
                                    <RowForm id={&form} action={&action} label={t.item_remove()} hidden={&[]} refused={refused} />
                                }
                            </td>
                        </tr>
                    }
                </Table>
            }
        </ItemPage>
    }
}

/// What the item contains, its unresolved provider evidence, and what contains it.
#[component(css = ItemPage)]
fn Contents<'a>(
    t: Cat,
    p: Pilot,
    screen: &'a ItemScreen,
    editable: bool,
    open: bool,
    refused: Option<&'a (String, Errors)>,
) -> impl Render {
    let id = screen.item.catalog_item_id.as_str();
    let lines = screen.contents.as_deref().unwrap_or_default();
    let containers = screen.containers.as_deref().unwrap_or_default();
    let resolved: Vec<&ContentLine> = lines.iter().filter(|l| l.resolution_status == "resolved").collect();
    let unresolved: Vec<&ContentLine> = lines.iter().filter(|l| l.resolution_status == "unresolved").collect();
    let summary = if lines.is_empty() {
        t.item_no_product_contents().to_owned()
    } else {
        t.item_product_contents_summary(lines.len()).to_string()
    };
    let evidence = if unresolved.is_empty() {
        t.item_no_unresolved_provider_evidence().to_owned()
    } else {
        t.item_unresolved_provider_evidence_summary(unresolved.len()).to_string()
    };
    let contained_in = if containers.is_empty() {
        t.item_no_product_containers().to_owned()
    } else {
        t.item_product_containers_summary(containers.len()).to_string()
    };
    let add = at::Contents::of(id).href();
    let tone = |any: bool, on: &'static str| if any { on } else { "neutral" };
    html! {
        <ItemPage title={t.item_product_contents()}>
            if screen.contents.is_none() || screen.containers.is_none() {
                <p class={Alert} role="alert">{p.item_contents_unavailable()}</p>
            }
            <Disclosure title={t.item_contents()} summary={&summary} tone={tone(!lines.is_empty(), "info")} open={open}>
                if editable && screen.contents.is_some() {
                    <form class={Opener} method="get" action={&add} data-patch>
                        <button type="submit" class={Small}>{t.item_add_content_line()}</button>
                    </form>
                }
                <LineTable
                    t={t}
                    screen={screen}
                    lines={&resolved}
                    empty={t.item_no_resolved_contents()}
                    editable={editable}
                    refused={refused}
                />
            </Disclosure>
            <Disclosure
                title={t.item_unresolved_provider_evidence()}
                summary={&evidence}
                tone={tone(!unresolved.is_empty(), "warning")}
                open={open && !unresolved.is_empty()}
            >
                <LineTable
                    t={t}
                    screen={screen}
                    lines={&unresolved}
                    empty={t.item_no_unresolved_provider_evidence()}
                    editable={editable}
                    refused={refused}
                />
            </Disclosure>
            <Disclosure
                title={t.item_included_in()}
                summary={&contained_in}
                tone={tone(!containers.is_empty(), "info")}
                open={false}
            >
                if containers.is_empty() {
                    <p class={Muted}>{t.item_no_product_containers()}</p>
                } else {
                    let head = [t.item_container_catalog_item(), t.item_content_type(), t.item_quantity(), t.item_selected_options()];
                    <Table label={t.item_included_in()} head={&head} all={None}>
                        for line in containers {
                            <tr>
                                <td>{screen.labels.item(&line.container_catalog_item_id)}</td>
                                <td>{screen.labels.content_type(&line.content_type_id)}</td>
                                <td>{quantity(t, line.quantity)}</td>
                                <td>{options_label(t, line.container_selected_options.as_ref())}</td>
                            </tr>
                        }
                    </Table>
                }
            </Disclosure>
        </ItemPage>
    }
}

/// Content lines: the contained item, its type, quantity, options and policy.
#[component(css = ItemPage)]
fn LineTable<'a>(
    t: Cat,
    screen: &'a ItemScreen,
    lines: &'a [&'a ContentLine],
    empty: &'a str,
    editable: bool,
    refused: Option<&'a (String, Errors)>,
) -> impl Render {
    let id = screen.item.catalog_item_id.as_str();
    let head = [
        t.item_contained_catalog_item(),
        t.item_content_type(),
        t.item_quantity(),
        t.item_selected_options(),
        t.item_inclusion_policy(),
        "",
    ];
    html! {
        if lines.is_empty() {
            <p class={Muted}>{empty}</p>
        } else {
            <Table label={t.item_contents()} head={&head} all={None}>
                for line in lines {
                    <tr>
                        <td>
                            match &line.contained_catalog_item_id {
                                Some(contained) => { {screen.labels.item(contained)} }
                                None => { {t.item_unresolved_provider_evidence()} }
                            }
                        </td>
                        <td>{screen.labels.content_type(&line.content_type_id)}</td>
                        <td>{quantity(t, line.quantity)}</td>
                        <td>{options_label(t, line.contained_selected_options.as_ref())}</td>
                        <td>
                            {line.inclusion_policy_id.as_deref().map_or(t.item_none(), |policy| screen.labels.policy(policy))}
                        </td>
                        <td>
                            if editable && screen.contents.is_some() {
                                let form = ids::row("line", &line.line_id);
                                let action = at::ContentRemove { id, line_id: &line.line_id }.href();
                                <RowForm id={&form} action={&action} label={t.item_remove()} hidden={&[]} refused={refused} />
                            }
                        </td>
                    </tr>
                }
            </Table>
        }
    }
}

#[component(css = ItemPage)]
fn Tags<'a>(t: Cat, item: &'a ItemDetail, editable: bool, open: bool) -> impl Render {
    let summary =
        if item.tags.is_empty() { t.item_no_tags().to_owned() } else { t.item_tags_summary(item.tags.len()).to_string() };
    html! {
        <ItemPage title={t.item_tags()}>
            <Disclosure title={t.item_tags()} summary={&summary} tone="info" open={open}>
                if editable {
                    <div><Trigger dialog={ids::TAGS_DIALOG} label={t.item_set_tags()} secondary={false} /></div>
                }
                if item.tags.is_empty() {
                    <p class={Muted}>{t.item_no_tags()}</p>
                } else {
                    <p class={Text}>{item.tags.join(", ")}</p>
                }
            </Disclosure>
        </ItemPage>
    }
}

#[component(css = ItemPage)]
fn ImageUrls<'a>(t: Cat, item: &'a ItemDetail, editable: bool, open: bool) -> impl Render {
    let summary = if item.image_urls.is_empty() {
        t.item_no_image_urls().to_owned()
    } else {
        t.item_image_urls_summary(item.image_urls.len()).to_string()
    };
    html! {
        <ItemPage title={t.item_image_urls()}>
            <Disclosure title={t.item_image_urls()} summary={&summary} tone="info" open={open}>
                if editable {
                    <div><Trigger dialog={ids::URLS_DIALOG} label={t.item_set_image_urls()} secondary={false} /></div>
                }
                if item.image_urls.is_empty() {
                    <p class={Muted}>{t.item_no_image_urls()}</p>
                } else {
                    <ul class={Urls}>
                        for url in &item.image_urls {
                            <li>{url}</li>
                        }
                    </ul>
                }
            </Disclosure>
        </ItemPage>
    }
}

#[component(css = ItemPage)]
fn ImageFallback<'a>(
    t: Cat,
    item: &'a ItemDetail,
    editable: bool,
    open: bool,
    refused: Option<&'a (String, Errors)>,
) -> impl Render {
    let id = item.catalog_item_id.as_str();
    let summary = item
        .image_fallback
        .as_ref()
        .map_or_else(|| t.item_no_image_fallback().to_owned(), |f| t.item_image_fallback_summary(&f.usage).to_string());
    let clear = at::FallbackClear { id }.href();
    html! {
        <ItemPage title={t.item_image_fallback()}>
            <Disclosure title={t.item_image_fallback()} summary={&summary} tone="info" open={open}>
                if editable {
                    <div class={Buttons}>
                        <Trigger dialog={ids::FALLBACK_DIALOG} label={t.item_set_image_fallback()} secondary={false} />
                        if item.image_fallback.is_some() {
                            <RowForm
                                id={ids::FALLBACK_CLEAR}
                                action={&clear}
                                label={t.item_clear_image_fallback()}
                                hidden={&[]}
                                refused={refused}
                            />
                        }
                    </div>
                }
                if let Some(fallback) = &item.image_fallback {
                    let values = [
                        (t.item_url(), fallback.url.clone()),
                        (t.item_alt_text(), fallback.alt.clone()),
                        (t.item_usage(), fallback.usage.clone()),
                        (t.item_variants(), fallback.variants.to_string()),
                    ];
                    <KeyValues items={&values} />
                } else {
                    <p class={Muted}>{t.item_no_image_fallback()}</p>
                }
            </Disclosure>
        </ItemPage>
    }
}

/// The external catalog item references, or (\`product\`) the product references.
#[component(css = ItemPage)]
fn References<'a>(
    t: Cat,
    item: &'a ItemDetail,
    product: bool,
    editable: bool,
    open: bool,
    refused: Option<&'a (String, Errors)>,
) -> impl Render {
    let id = item.catalog_item_id.as_str();
    let (title, refs, none, dialog, link) = if product {
        (
            t.item_external_product_references(),
            &item.external_product_references,
            t.item_no_external_references(),
            ids::PRODUCT_REF_DIALOG,
            t.item_link_external_reference(),
        )
    } else {
        (
            t.item_external_catalog_item_references(),
            &item.external_catalog_item_references,
            t.item_no_external_catalog_item_references(),
            ids::CATALOG_REF_DIALOG,
            t.item_link_external_catalog_item_reference(),
        )
    };
    let summary = match (refs.is_empty(), product) {
        (true, _) => none.to_owned(),
        (false, true) => t.item_external_references_summary(refs.len()).to_string(),
        (false, false) => t.item_external_catalog_item_references_summary(refs.len()).to_string(),
    };
    let head: Vec<&str> = if product {
        vec![t.item_provider(), t.item_external_key(), t.item_selected_options(), ""]
    } else {
        vec![t.item_provider(), t.item_external_key(), ""]
    };
    let unlink = if product { at::ProductRefUnlink { id }.href() } else { at::CatalogRefUnlink { id }.href() };
    let f = ReferenceInput::FIELDS;
    let tone = if refs.is_empty() { "neutral" } else { "info" };
    html! {
        <ItemPage title={title}>
            <Disclosure title={title} summary={&summary} tone={tone} open={open}>
                if editable {
                    <div><Trigger dialog={dialog} label={link} secondary={false} /></div>
                }
                if refs.is_empty() {
                    <p class={Muted}>{none}</p>
                } else {
                    <Table label={title} head={&head} all={None}>
                        for r in refs {
                            <tr>
                                <td>{&r.provider_key}</td>
                                <td>{&r.external_key}</td>
                                if product {
                                    <td>
                                        if r.selected_options.is_empty() {
                                            {t.item_none()}
                                        } else {
                                            {options_label(t, Some(&r.selected_options))}
                                        }
                                    </td>
                                }
                                <td>
                                    if editable {
                                        let key = format!("{}\u{0}{}", r.provider_key, r.external_key);
                                        let form = ids::row(if product { "product-ref" } else { "catalog-ref" }, &key);
                                        let hidden = [(f.provider_key, r.provider_key.as_str()), (f.external_key, r.external_key.as_str())];
                                        <RowForm
                                            id={&form}
                                            action={&unlink}
                                            label={t.item_unlink()}
                                            hidden={&hidden}
                                            refused={refused}
                                        />
                                    }
                                </td>
                            </tr>
                        }
                    </Table>
                }
            </Disclosure>
        </ItemPage>
    }
}

/// A labelled select, its error next to it; \`placeholder\` is the empty choice.
#[component(css = ItemPage)]
fn Select<'a, I: Id>(
    label: &'a str,
    name: FieldName,
    placeholder: &'a str,
    options: &'a [(String, String, bool)],
    value: &'a str,
    errors: &'a Within<'a, I>,
) -> impl Render {
    html! {
        <div class={Field}>
            <label class={Field}>
                <span class={Label}>{label}</span>
                <select name={name} {..errors.aria(name)}>
                    <option value="">{placeholder}</option>
                    for (option, text, reference) in options {
                        <option value={option} selected={option == value} data-reference={*reference}>{text}</option>
                    }
                </select>
            </label>
            {errors.message(name)}
        </div>
    }
}

/// The publish form: the display identity's readiness and Recheck (a
/// \`GET\` of the same address, which draws the form again with the readiness now).
#[component(css = ItemPage)]
pub fn PublishForm<'a>(t: Cat, id: &'a str, form: &'a Draft<PublishInput>, readiness: &'a Readiness) -> impl Patch {
    let action = at::Publish::of(id).href();
    let status = [(t.item_display_identity_readiness(), readiness.status.clone())];
    let missing = readiness.missing_tokens.join(", ");
    html! {
        <form class={Form} id={ids::PUBLISH} method="post" action={&action} data-patch>
            <button type="submit" class={Default} tabindex="-1" aria-hidden="true">{t.item_publish_2()}</button>
            {form.errors.form_message()}
            <KeyValues items={&status} />
            if !readiness.missing_tokens.is_empty() {
                <p class={Alert}>{t.item_display_identity_missing_tokens(&missing)}</p>
            }
            <div class={Footer}>
                if readiness.retryable || !form.errors.is_empty() {
                    <button type="submit" class={Secondary} formmethod="get" formnovalidate>
                        {t.item_recheck_display_identity()}
                    </button>
                }
                <button type="submit">{t.item_publish_2()}</button>
            </div>
        </form>
    }
}

/// A form of one id (a blueprint's, a category's).
#[component(css = ItemPage)]
pub fn IdForm<'a, I: Id + AttrValue + Copy>(
    id: I,
    action: &'a str,
    label: &'a str,
    submit: &'a str,
    form: &'a Draft<IdInput>,
) -> impl Patch {
    let f = IdInput::FIELDS;
    let e = form.errors.within(id);
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            <Input label={label} name={f.id} value={&form.input.id} errors={&e} />
            <div class={Footer}><button type="submit">{submit}</button></div>
        </form>
    }
}

/// Set Field Value's dialog, drawn open: the server draws it when it is opened.
#[component(css = ItemPage)]
pub fn FieldDialog<'a>(t: Cat, p: Pilot, id: &'a str, form: &'a Draft<FieldValueInput>, choices: &'a FieldChoices) -> impl Patch {
    html! {
        <Dialog id={ids::FIELD_DIALOG} title={t.item_set_field_value_2()} description={None} open close={p.catalog_close()}>
            <FieldValueForm t={t} id={id} form={form} choices={choices} />
        </Dialog>
    }
}

/// The field, and its value: a reference record for a reference field (shown only when one is
/// chosen, with CSS \`:has\`), text for any other.
#[component(css = ItemPage)]
pub fn FieldValueForm<'a>(t: Cat, id: &'a str, form: &'a Draft<FieldValueInput>, choices: &'a FieldChoices) -> impl Patch {
    let f = FieldValueInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(ids::FIELD));
    let action = at::Fields::of(id).href();
    let fields: Vec<(String, String, bool)> = choices
        .fields
        .iter()
        .map(|field| {
            (field.field_id.clone(), t.item_field_option(&field.name, &field.key).to_string(), field.value_type == "reference")
        })
        .collect();
    let references: Vec<(String, String, bool)> = choices
        .references
        .iter()
        .map(|r| (r.reference_record_id.clone(), t.item_reference_record_option(&r.name, &r.type_key, &r.key).to_string(), false))
        .collect();
    html! {
        <form class={(Form, FieldValue)} id={ids::FIELD} method="post" action={&action} data-patch>
            {form.errors.form_message()}
            if fields.is_empty() {
                <Input label={t.item_field_id()} name={f.field_id} value={&i.field_id} errors={&e} />
            } else {
                <Select
                    label={t.item_field()}
                    name={f.field_id}
                    placeholder={t.item_choose_field()}
                    options={&fields}
                    value={&i.field_id}
                    errors={&e}
                />
            }
            <div class={Reference}>
                <Select
                    label={t.item_reference_record()}
                    name={f.reference_id}
                    placeholder={t.item_choose_reference_record()}
                    options={&references}
                    value={&i.reference_id}
                    errors={&e}
                />
            </div>
            <div class={(Field, TextValue)}>
                <label class={Field}>
                    <span class={Label}>{t.item_value_2()}</span>
                    <textarea name={f.value} rows="4" {..e.aria(f.value)}>{&i.value}</textarea>
                </label>
                <span class={Muted}>{t.item_value_description()}</span>
                {e.message(f.value)}
            </div>
            <div class={Footer}><button type="submit">{t.item_set()}</button></div>
        </form>
    }
}

#[component(css = ItemPage)]
pub fn MetadataForm<'a>(t: Cat, id: &'a str, form: &'a Draft<MetadataInput>) -> impl Patch {
    let f = MetadataInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(ids::METADATA));
    let action = at::Metadata { id }.href();
    html! {
        <form class={Form} id={ids::METADATA} method="post" action={&action} data-patch>
            {form.errors.form_message()}
            <Input label={t.item_language_code()} name={f.language_code} value={&i.language_code} errors={&e} />
            <Input label={t.item_description()} name={f.description} value={&i.description} errors={&e} />
            <div class={Footer}><button type="submit">{t.item_save()}</button></div>
        </form>
    }
}

/// Set Tags (comma-separated, one input) or Set Image URLs (\`lines\`: one per line).
#[component(css = ItemPage)]
pub fn ListForm<'a, I: Id + AttrValue + Copy>(
    id: I,
    action: &'a str,
    label: &'a str,
    lines: bool,
    submit: &'a str,
    form: &'a Draft<ListInput>,
) -> impl Patch {
    let f = ListInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            if lines {
                <div class={Field}>
                    <label class={Field}>
                        <span class={Label}>{label}</span>
                        <textarea name={f.text} rows="5" {..e.aria(f.text)}>{&i.text}</textarea>
                    </label>
                    {e.message(f.text)}
                </div>
            } else {
                <Input label={label} name={f.text} value={&i.text} errors={&e} />
            }
            <div class={Footer}><button type="submit">{submit}</button></div>
        </form>
    }
}

#[component(css = ItemPage)]
pub fn FallbackForm<'a>(t: Cat, id: &'a str, form: &'a Draft<FallbackInput>) -> impl Patch {
    let f = FallbackInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(ids::FALLBACK));
    let action = at::Fallback { id }.href();
    html! {
        <form class={Form} id={ids::FALLBACK} method="post" action={&action} data-patch>
            {form.errors.form_message()}
            <Input label={t.item_url()} name={f.url} value={&i.url} errors={&e} />
            <Input label={t.item_alt_text()} name={f.alt} value={&i.alt} errors={&e} />
            <label class={Field}>
                <span class={Label}>{t.item_usage()}</span>
                <select name={f.usage}>
                    <option value="permanent" selected={i.usage != "loading-only"}>"permanent"</option>
                    <option value="loading-only" selected={i.usage == "loading-only"}>"loading-only"</option>
                </select>
            </label>
            <div class={Field}>
                <label class={Field}>
                    <span class={Label}>{t.item_variants_json()}</span>
                    <textarea name={f.variants} rows="4" {..e.aria(f.variants)}>{&i.variants}</textarea>
                </label>
                {e.message(f.variants)}
            </div>
            <div class={Footer}><button type="submit">{t.item_save_4()}</button></div>
        </form>
    }
}

/// Link an external catalog item reference, or (\`product\`) a product reference with options.
#[component(css = ItemPage)]
pub fn ReferenceForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: &'a str,
    form_id: I,
    product: bool,
    form: &'a Draft<ReferenceInput>,
) -> impl Patch {
    let f = ReferenceInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(form_id));
    let action = if product { at::ProductRefs { id }.href() } else { at::CatalogRefs { id }.href() };
    html! {
        <form class={Form} id={form_id} method="post" action={&action} data-patch>
            {form.errors.form_message()}
            <Input label={t.item_provider()} name={f.provider_key} value={&i.provider_key} errors={&e} />
            <Input label={t.item_external_key()} name={f.external_key} value={&i.external_key} errors={&e} />
            if product {
                <label class={Field}>
                    <span class={Label}>{t.item_selected_options_2()}</span>
                    <input
                        type="text"
                        name={f.selected_options}
                        value={&i.selected_options}
                        placeholder={t.item_selected_options_placeholder()}
                    >
                </label>
            }
            <div class={Footer}><button type="submit">{t.item_link()}</button></div>
        </form>
    }
}

/// Add content line's dialog, drawn open: the server draws it when it is opened.
#[component(css = ItemPage)]
pub fn ContentDialog<'a>(
    t: Cat,
    p: Pilot,
    id: &'a str,
    form: &'a Draft<ContentLineInput>,
    choices: &'a ContentChoices,
) -> impl Patch {
    html! {
        <Dialog id={ids::CONTENT_DIALOG} title={t.item_add_content_line()} description={None} open close={p.catalog_close()}>
            <ContentForm t={t} id={id} form={form} choices={choices} />
        </Dialog>
    }
}

#[component(css = ItemPage)]
pub fn ContentForm<'a>(t: Cat, id: &'a str, form: &'a Draft<ContentLineInput>, choices: &'a ContentChoices) -> impl Patch {
    let f = ContentLineInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(ids::CONTENT));
    let action = at::Contents::of(id).href();
    let choice = |list: &[ContentChoice]| -> Vec<(String, String, bool)> {
        list.iter().map(|c| (c.id.clone(), choice_label(c), false)).collect()
    };
    let (types, policies) = (choice(&choices.types), choice(&choices.policies));
    let items: Vec<(String, String, bool)> = choices
        .items
        .iter()
        .map(|item| {
            (item.catalog_item_id.clone(), t.item_catalog_item_option(&item.title, &item.catalog_item_id).to_string(), false)
        })
        .collect();
    html! {
        <form class={Form} id={ids::CONTENT} method="post" action={&action} data-patch>
            {form.errors.form_message()}
            <Select
                label={t.item_content_type()}
                name={f.content_type_id}
                placeholder={t.item_choose_content_type()}
                options={&types}
                value={&i.content_type_id}
                errors={&e}
            />
            <Select
                label={t.item_inclusion_policy()}
                name={f.inclusion_policy_id}
                placeholder={t.item_choose_inclusion_policy()}
                options={&policies}
                value={&i.inclusion_policy_id}
                errors={&e}
            />
            <Select
                label={t.item_contained_catalog_item()}
                name={f.contained_catalog_item_id}
                placeholder={t.item_choose_catalog_item()}
                options={&items}
                value={&i.contained_catalog_item_id}
                errors={&e}
            />
            <label class={Field}>
                <span class={Label}>{t.item_selected_options_2()}</span>
                <input
                    type="text"
                    name={f.contained_options}
                    value={&i.contained_options}
                    placeholder={t.item_selected_options_placeholder()}
                >
            </label>
            <Input label={t.item_quantity()} name={f.quantity} value={&i.quantity} errors={&e} />
            <div class={Footer}><button type="submit">{t.item_add_content_line()}</button></div>
        </form>
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::catalog::api::FieldValue;

    fn reference(id: &str, kind: &str, name: &str, related: &[(&str, Reference)]) -> Reference {
        serde_json::from_value(json!({
            "referenceId": id, "typeKey": kind, "key": id, "name": name, "attributes": {}, "status": "active",
            "relationships": related.iter().map(|(k, r)| json!({ "relationshipType": k, "referenceId": r.reference_id, "reference": r })).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    #[test]
    fn field_values_list_the_records_they_relate_to_once() {
        let game = reference("ref_game", "game", "Magic", &[]);
        let series = reference("ref_series", "series", "Modern", &[("parent", game.clone())]);
        let set = reference("ref_set", "tcg_set", "Horizons", &[("series", series.clone()), ("game", game.clone())]);
        let values: Vec<FieldValue> = serde_json::from_value(json!([
            { "fieldId": "fld_set", "fieldName": "fld_seed_card_set", "value": null, "reference": set },
            { "fieldId": "fld_number", "fieldName": "Number", "value": 42 },
        ]))
        .unwrap();
        let rows = detail_rows(&values);
        let shown: Vec<(&str, &str)> = rows.iter().map(|r| (r.label.as_str(), r.value.as_str())).collect();
        assert_eq!(shown, [("Card Set", "Horizons"), ("Number", "42"), ("Series", "Modern"), ("Game", "Magic")]);
        assert_eq!(rows[2].field_id, None, "an inherited row cannot be cleared");
        assert_eq!(type_label("tcg_set"), "TCG Set");
        assert_eq!(field_text(&json!({ "defaultLocale": "en", "values": { "fr": "Bonjour" } })), "Bonjour");
        assert_eq!(field_text(&json!([1, 2])), "[1,2]");
    }
}
