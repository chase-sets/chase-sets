//! The catalog area's views. Their stylesheets are the area's own file, `sections/catalog.css`,
//! linked only from pages under `/catalog`; the frame (`AdminNav`, the tokens) is the app's.
//! Every dialog is a `<dialog>` its button opens with `command="show-modal"` and every write a
//! form, so the pages work without JavaScript; with it, a refused form is patched in place, and a
//! list's rows are drawn again when the Catalog API says the list changed (`<corten-live>`).
//! A bulk change is a form too: the rows' boxes join it, its preview is a dialog the server
//! answers with, and its job's dialog follows the job's progress (`<corten-live>`).
use corten::{Component, prelude::*};

use serde_json::Value;

use super::{
    api::{Dimension, DimensionDetail, Field, Job},
    form::{DimensionInput, FieldInput, OptionInput, ReorderInput},
    url,
};
use crate::text::{Cat, Pilot};
pub use crate::views::Draft;

mod attention_panel;
mod blueprints;
mod bulk_dialogs;
mod bulk_rows;
mod categories;
mod components;
mod coverage;
mod detail_page;
mod dialog;
mod display_templates;
mod item_list;
mod item_page;
mod list_page;
mod observation_page;
mod reference_records;
mod reference_types;
mod scope_list;
mod scope_page;
mod status_pill;
mod sync_batches;

pub use attention_panel::{AttentionBanner, AttentionPanel, AttentionSheet, park_form};
pub use blueprints::{
    BlueprintForms, DimensionRulesDialog, FieldRulesDialog, OrderDialog, Set, SetRules, blueprint_actions, blueprint_list,
    blueprint_page, blueprint_rows, blueprint_transitions,
};
pub use bulk_dialogs::{Candidates, JobDialog, PreviewDialog, Previewed, job_status};
pub use bulk_rows::{Bar, BulkRows, SelectAll, SelectRow};
pub use categories::{CategoryForms, category_actions, category_list, category_page, category_rows, category_transitions};
pub use components::{ComponentForms, component_list, component_page, component_rows};
pub use coverage::{coverage_inbox, coverage_page};
pub use detail_page::{
    ActionBar, DetailPage, KeyValues, LifecycleForm, OptionLifecycleForm, OptionTable, Part, RemoveForm, Transition,
};
pub use dialog::{
    AttachForm, BlueprintForm, CategoryForm, ComponentForm, Dialog, DimensionForm, DimensionRuleForm, DimensionRulesForm,
    FieldForm, FieldRuleForm, FieldRulesForm, Input, Opens, OptionForm, OrderForm, RefRecordForm, RefTypeForm, ReorderForm,
    TemplateForm, Toasts, Trigger, value_kinds, value_types,
};
pub use display_templates::{TemplateForms, template_list, template_page, template_rows, template_transitions};
pub use item_list::{
    DraftsDialog, ItemDialog, ItemForm, ItemJobOutcome, ItemParts, ItemPreview, ItemPreviewDialog, Pending, item_changes,
    item_list, item_live, item_operations, item_rows,
};
pub use item_page::{
    ContentChoices, ContentDialog, ContentForm, FallbackForm, FieldChoices, FieldDialog, FieldValueForm, Fold, IdForm, ItemBack,
    ItemPage, ItemScreen, Labels, ListForm, MetadataForm, PublishForm, ReferenceForm, RowForm, choice_label, item_page,
    item_transitions,
};
pub use list_page::{
    BlueprintRow, CategoryRow, ComponentRow, DimensionRow, Empty, FieldRow, Filters, ListPage, MoreFilters, Pager, Pick,
    RefRecordRow, RefTypeRow, Search, Table, TemplateRow, TextFilter,
};
pub use observation_page::{ObservationPage, ReviewForm, observation_page};
pub use reference_records::{
    RecordDraft, RefChoices, RefRecordCreateDialog, RefRecordEditDialog, RefRecordForms, ref_record_actions, ref_record_list,
    ref_record_page, ref_record_rows, ref_record_transitions,
};
pub use reference_types::{RefTypeForms, ref_type_actions, ref_type_list, ref_type_page, ref_type_rows, ref_type_transitions};
pub use scope_list::{ScopeRowView, scope_list};
pub use scope_page::{CoveragePart, InboxHeader, InboxRow, InboxTone, Refused, Rows, ScopePage, scope_page};
pub use status_pill::{StatusPill, Tone, TonePill};
pub use sync_batches::{SyncBatchPage, sync_batch_page};

/// The area's components: its stylesheet, and corten-ui's toaster and combobox scripts.
pub const COMPONENTS: &[Component] = &[
    StatusPill,
    ListPage,
    DetailPage,
    Dialog,
    BulkRows,
    ScopeRowView,
    ScopePage,
    SyncBatchPage,
    ObservationPage,
    AttentionPanel,
    PreviewDialog,
    ItemForm,
    ItemPage,
    corten_ui::Toaster,
    corten_ui::ComboBox,
    corten_ui::dialog::COMPONENT,
];

/// The text of element id `id` followed by `suffix`: the id of a part of that element (a
/// dialog's heading, a confirm dialog of a form).
pub fn id_with(id: &impl Id, suffix: &str) -> String {
    let mut text = String::new();
    id.write_id(&mut text);
    text.push_str(suffix);
    text
}

/// The ids a form's patch replaces it by, and the dialogs they sit in.
pub mod ids {
    use corten::prelude::*;

    /// A list's create form.
    #[derive(Id, Clone, Copy)]
    pub struct CatalogCreateId;
    pub const CREATE: CatalogCreateId = CatalogCreateId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogCreateDialogId;
    pub const CREATE_DIALOG: CatalogCreateDialogId = CatalogCreateDialogId;
    /// A record's edit form.
    #[derive(Id, Clone, Copy)]
    pub struct CatalogEditId;
    pub const EDIT: CatalogEditId = CatalogEditId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogEditDialogId;
    pub const EDIT_DIALOG: CatalogEditDialogId = CatalogEditDialogId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogLifecycleId;
    pub const LIFECYCLE: CatalogLifecycleId = CatalogLifecycleId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogAddOptionId;
    pub const ADD_OPTION: CatalogAddOptionId = CatalogAddOptionId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogAddOptionDialogId;
    pub const ADD_OPTION_DIALOG: CatalogAddOptionDialogId = CatalogAddOptionDialogId;
    /// A Source Observation's review form.
    #[derive(Id, Clone, Copy)]
    pub struct CatalogReviewId;
    pub const REVIEW: CatalogReviewId = CatalogReviewId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogReorderId;
    pub const REORDER: CatalogReorderId = CatalogReorderId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogReorderDialogId;
    pub const REORDER_DIALOG: CatalogReorderDialogId = CatalogReorderDialogId;
    /// A list's rows (or its empty state) and pager: what a change to the list re-renders.
    #[derive(Id, Clone, Copy)]
    pub struct CatalogRowsId;
    pub const ROWS: CatalogRowsId = CatalogRowsId;
    /// The bulk bar's form, which the rows' boxes join.
    pub const BULK: &str = "catalog-bulk";
    #[derive(Id, Clone, Copy)]
    pub struct CatalogBulkPreviewId;
    pub const PREVIEW_DIALOG: CatalogBulkPreviewId = CatalogBulkPreviewId;
    /// The preview's confirm form.
    #[derive(Id, Clone, Copy)]
    pub struct CatalogBulkConfirmId;
    pub const CONFIRM: CatalogBulkConfirmId = CatalogBulkConfirmId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogBulkJobId;
    pub const JOB_DIALOG: CatalogBulkJobId = CatalogBulkJobId;
    /// A job's status in its dialog: what each change to the job draws again.
    pub const JOB_STATUS: &str = "catalog-bulk-status";
    /// The element that streams a list's changes, and what it draws (the catalog items say how
    /// many changed rather than drawing the rows again).
    #[derive(Id, Clone, Copy)]
    pub struct CatalogLiveId;
    pub const LIVE: CatalogLiveId = CatalogLiveId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogChangesId;
    pub const CHANGES: CatalogChangesId = CatalogChangesId;

    /// The attention queue's Review form (each row's button submits it with its item), the
    /// item's sheet, and its two park forms.
    pub const ATTENTION_OPEN: &str = "attention-open";
    #[derive(Id, Clone, Copy)]
    pub struct AttentionSheetId;
    pub const ATTENTION_DIALOG: AttentionSheetId = AttentionSheetId;
    #[derive(Id, Clone, Copy)]
    pub struct AttentionDismissId;
    pub const ATTENTION_DISMISS: AttentionDismissId = AttentionDismissId; // attention-dismiss
    #[derive(Id, Clone, Copy)]
    pub struct AttentionDeferId;
    pub const ATTENTION_DEFER: AttentionDeferId = AttentionDeferId; // attention-defer

    /// The catalog item page's dialogs and their forms (`item` = the form, `*_DIALOG` its dialog).
    pub mod item {
        use corten::prelude::*;

        #[derive(Id, Clone, Copy)]
        pub struct ItemPublishId;
        pub const PUBLISH: ItemPublishId = ItemPublishId; // item-publish
        #[derive(Id, Clone, Copy)]
        pub struct ItemPublishDialogId;
        pub const PUBLISH_DIALOG: ItemPublishDialogId = ItemPublishDialogId;
        #[derive(Id, Clone, Copy)]
        pub struct ItemBlueprintId;
        pub const BLUEPRINT: ItemBlueprintId = ItemBlueprintId; // item-blueprint
        #[derive(Id, Clone, Copy)]
        pub struct ItemBlueprintDialogId;
        pub const BLUEPRINT_DIALOG: ItemBlueprintDialogId = ItemBlueprintDialogId;
        /// Set Field Value: drawn by the server when it is opened (its lists are long).
        #[derive(Id, Clone, Copy)]
        pub struct ItemFieldId;
        pub const FIELD: ItemFieldId = ItemFieldId; // item-field
        #[derive(Id, Clone, Copy)]
        pub struct ItemFieldDialogId;
        pub const FIELD_DIALOG: ItemFieldDialogId = ItemFieldDialogId;
        #[derive(Id, Clone, Copy)]
        pub struct ItemCategoryId;
        pub const CATEGORY: ItemCategoryId = ItemCategoryId; // item-category
        #[derive(Id, Clone, Copy)]
        pub struct ItemCategoryDialogId;
        pub const CATEGORY_DIALOG: ItemCategoryDialogId = ItemCategoryDialogId;
        #[derive(Id, Clone, Copy)]
        pub struct ItemMetadataId;
        pub const METADATA: ItemMetadataId = ItemMetadataId; // item-metadata
        #[derive(Id, Clone, Copy)]
        pub struct ItemMetadataDialogId;
        pub const METADATA_DIALOG: ItemMetadataDialogId = ItemMetadataDialogId;
        #[derive(Id, Clone, Copy)]
        pub struct ItemTagsId;
        pub const TAGS: ItemTagsId = ItemTagsId; // item-tags
        #[derive(Id, Clone, Copy)]
        pub struct ItemTagsDialogId;
        pub const TAGS_DIALOG: ItemTagsDialogId = ItemTagsDialogId;
        #[derive(Id, Clone, Copy)]
        pub struct ItemImageUrlsId;
        pub const URLS: ItemImageUrlsId = ItemImageUrlsId; // item-image-urls
        #[derive(Id, Clone, Copy)]
        pub struct ItemImageUrlsDialogId;
        pub const URLS_DIALOG: ItemImageUrlsDialogId = ItemImageUrlsDialogId;
        #[derive(Id, Clone, Copy)]
        pub struct ItemFallbackId;
        pub const FALLBACK: ItemFallbackId = ItemFallbackId; // item-fallback
        #[derive(Id, Clone, Copy)]
        pub struct ItemFallbackDialogId;
        pub const FALLBACK_DIALOG: ItemFallbackDialogId = ItemFallbackDialogId;
        #[derive(Id, Clone, Copy)]
        pub struct ItemCatalogRefId;
        pub const CATALOG_REF: ItemCatalogRefId = ItemCatalogRefId; // item-catalog-ref
        pub const CATALOG_REF_DIALOG: ItemId<'static> = ItemId("catalog-ref-dialog");
        #[derive(Id, Clone, Copy)]
        pub struct ItemProductRefId;
        pub const PRODUCT_REF: ItemProductRefId = ItemProductRefId; // item-product-ref
        // `item-product-ref-dialog`: one type with the catalog's, since the page picks either.
        pub const PRODUCT_REF_DIALOG: ItemId<'static> = ItemId("product-ref-dialog");
        /// Add content line: drawn by the server when it is opened.
        #[derive(Id, Clone, Copy)]
        pub struct ItemContentId;
        pub const CONTENT: ItemContentId = ItemContentId; // item-content
        #[derive(Id, Clone, Copy)]
        pub struct ItemContentDialogId;
        pub const CONTENT_DIALOG: ItemContentDialogId = ItemContentDialogId;
        /// The image fallback's clear form.
        pub const FALLBACK_CLEAR: &str = "item-fallback-clear";

        /// A part of the page that is one of many, by its key (`row`): `item-{key}`.
        #[derive(Id, Clone, Copy)]
        pub struct ItemId<'a>(pub &'a str);

        /// A row's form's key (`ItemId`): a field value's clear, a category's remove, a
        /// reference's unlink, a content line's remove.
        pub fn row(kind: &str, key: &str) -> String {
            // Hex, so two keys never share an id (a provider's keys may hold any character).
            let key: String = key.bytes().map(|b| format!("{b:02x}")).collect();
            format!("{kind}-{key}")
        }

        /// A reference record's detail dialog's key (`ItemId`).
        pub fn reference(id: &str) -> String {
            row("reference", id)
        }
    }

    /// An option's edit form: `option-{id}`.
    #[derive(Id, Clone, Copy)]
    pub struct OptionId<'a>(pub &'a str);

    pub fn option_form(option_id: &str) -> OptionId<'_> {
        OptionId(option_id)
    }

    /// An option's edit dialog: `option-dialog-{id}`.
    #[derive(Id, Clone, Copy)]
    pub struct OptionDialogId<'a>(pub &'a str);

    pub fn option_dialog(option_id: &str) -> OptionDialogId<'_> {
        OptionDialogId(option_id)
    }

    /// An option's deprecate or reactivate form: `option-lifecycle-{id}`.
    #[derive(Id, Clone, Copy)]
    pub struct OptionLifecycleId<'a>(pub &'a str);

    pub fn option_lifecycle(option_id: &str) -> OptionLifecycleId<'_> {
        OptionLifecycleId(option_id)
    }

    /// A component's Add Field Rule and Add Dimension Rule forms, and their dialogs.
    #[derive(Id, Clone, Copy)]
    pub struct CatalogAddFieldRuleId;
    pub const ADD_FIELD_RULE: CatalogAddFieldRuleId = CatalogAddFieldRuleId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogAddFieldRuleDialogId;
    pub const ADD_FIELD_RULE_DIALOG: CatalogAddFieldRuleDialogId = CatalogAddFieldRuleDialogId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogAddDimensionRuleId;
    pub const ADD_DIMENSION_RULE: CatalogAddDimensionRuleId = CatalogAddDimensionRuleId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogAddDimensionRuleDialogId;
    pub const ADD_DIMENSION_RULE_DIALOG: CatalogAddDimensionRuleDialogId = CatalogAddDimensionRuleDialogId;

    /// A blueprint's Attach Component form, and its dialog.
    #[derive(Id, Clone, Copy)]
    pub struct CatalogAttachId;
    pub const ATTACH: CatalogAttachId = CatalogAttachId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogAttachDialogId;
    pub const ATTACH_DIALOG: CatalogAttachDialogId = CatalogAttachDialogId;

    /// A blueprint's Set Field Rules, Set Dimension Rules and Set Product Resolution Rules
    /// forms, and their dialogs (drawn by the server when opened).
    #[derive(Id, Clone, Copy)]
    pub struct CatalogSetFieldsId;
    pub const SET_FIELDS: CatalogSetFieldsId = CatalogSetFieldsId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogSetFieldsDialogId;
    pub const SET_FIELDS_DIALOG: CatalogSetFieldsDialogId = CatalogSetFieldsDialogId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogSetDimensionsId;
    pub const SET_DIMENSIONS: CatalogSetDimensionsId = CatalogSetDimensionsId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogSetDimensionsDialogId;
    pub const SET_DIMENSIONS_DIALOG: CatalogSetDimensionsDialogId = CatalogSetDimensionsDialogId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogSetOrderId;
    pub const SET_ORDER: CatalogSetOrderId = CatalogSetOrderId;
    #[derive(Id, Clone, Copy)]
    pub struct CatalogSetOrderDialogId;
    pub const SET_ORDER_DIALOG: CatalogSetOrderDialogId = CatalogSetOrderDialogId;

    /// A row's Remove form: `rule-{kind}-{id}` (`field` or `dimension` rule, or a blueprint's
    /// `component`).
    #[derive(Id, Clone, Copy)]
    pub struct RuleId<'a>(pub &'a str);

    pub fn rule(kind: &str, id: &str) -> String {
        format!("{kind}-{id}")
    }
}

/// A list page's view model: its rows, the total, which page of how many, and the bulk change
/// the page shows (its preview, or its job, whose outcome is the kind's).
#[derive(serde::Serialize, ToJson)]
pub struct ListScreen<T, P = super::api::Preview> {
    pub items: Vec<T>,
    pub total: u32,
    pub page: u32,
    pub pages: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<P>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<Job<Value>>,
}

/// A list page's bulk parts: whether the viewer may change the records (the bar and the boxes),
/// a preview the API answered (its dialog drawn open), and the job the page follows.
#[derive(Default)]
pub struct Bulk<'a> {
    pub manage: bool,
    pub preview: Option<Previewed<'a>>,
    pub job: Option<Followed<'a>>,
}

/// A job the list page shows, after its confirm: the job (none when the API does not know it),
/// the action's label, and its stream while it runs.
pub struct Followed<'a> {
    pub job: Option<&'a Job<Value>>,
    pub label: &'a str,
    pub live: Option<String>,
}

/// The lifecycle actions a bulk change offers, with their labels (admin-web's `lifecycleActions`).
pub fn bulk_actions(activate: &'static str, deprecate: &'static str, archive: &'static str) -> [(&'static str, &'static str); 3] {
    [("activate", activate), ("deprecate", deprecate), ("archive", archive)]
}

/// A dimension page's forms that came back from a submit (refused, or a label row added), in
/// place of the record's values; a form here is drawn in its open dialog.
#[derive(Default)]
pub struct DimensionForms {
    pub edit: Option<Draft<DimensionInput>>,
    pub lifecycle: Option<Errors>,
    pub add: Option<Draft<OptionInput>>,
    /// An option's edit form, by the option's id.
    pub option: Option<(String, Draft<OptionInput>)>,
    pub option_lifecycle: Option<(String, Errors)>,
    pub reorder: Option<Draft<ReorderInput>>,
}

#[derive(Default)]
pub struct FieldForms {
    pub edit: Option<Draft<FieldInput>>,
    pub lifecycle: Option<Errors>,
}

/// The transitions a status allows (`getTransitions` on both detail pages).
pub fn transitions(status: &str, activate: &'static str, deprecate: &'static str, archive: &'static str) -> Vec<Transition> {
    match status {
        "draft" => vec![Transition { action: "activate", label: activate, confirm: false }],
        "active" => vec![Transition { action: "deprecate", label: deprecate, confirm: true }],
        "deprecated" => vec![Transition { action: "archive", label: archive, confirm: true }],
        _ => Vec::new(),
    }
}

fn statuses(t: Cat) -> [(&'static str, &'static str); 4] {
    [
        ("draft", t.dimension_list_draft()),
        ("active", t.dimension_list_active()),
        ("deprecated", t.dimension_list_deprecated()),
        ("archived", t.dimension_list_archived()),
    ]
}

/// A page's link, or none for the page itself.
fn pages_around<Q, P>(screen: &ListScreen<Q, P>, at: impl Fn(u32) -> String) -> (Option<String>, Option<String>) {
    let previous = (screen.page > 1).then(|| at(screen.page - 1));
    let next = (screen.page < screen.pages).then(|| at(screen.page + 1));
    (previous, next)
}

/// The query's value, or nothing.
fn value(of: &Option<String>) -> &str {
    of.as_deref().unwrap_or("")
}

/// The dimensions list, its filters, and the create dialog (with `create`, the form that came
/// back, drawn open).
pub fn dimension_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::DimensionQuery,
    screen: &'a ListScreen<Dimension>,
    create: Option<Draft<DimensionInput>>,
    notice: Option<String>,
    bulk: Bulk<'a>,
) -> impl Render + 'a {
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(DimensionInput::blank()));
    let title = t.dimension_list_dimensions();
    let list = url::Dimensions::of(query);
    let create_action = list.href();
    let live = url::DimensionsLive { query: query.clone() }.href();
    let filters = url::Dimensions::default().href();
    let (states, kinds) = (statuses(t), value_kinds(t));
    let f = url::DimensionQuery::FIELDS;
    html! {
        <ListPage title={title}>
            <Trigger dialog={ids::CREATE_DIALOG} label={t.dimension_list_new_dimension()} secondary={false} />
        </ListPage>
        <Filters t={t} action={&filters}>
            <Search t={t} name={f.search} title={title} value={value(&query.search)} />
            <Pick
                label={t.list_status()}
                name={f.status}
                all={t.list_all_statuses()}
                options={&states}
                value={value(&query.status)}
            />
            <Pick
                label={t.dimension_list_value_kind_2()}
                name={f.value_kind}
                all={t.list_all_value_kinds()}
                options={&kinds}
                value={value(&query.value_kind)}
            />
        </Filters>
        <corten-live src={&live}>{dimension_rows(t, p, query, screen, bulk.manage)}</corten-live>
        <Dialog
            id={ids::CREATE_DIALOG}
            title={t.dimension_list_create_dimension()}
            description={None}
            open={open}
            close={p.catalog_close()}
        >
            <DimensionForm t={t} id={ids::CREATE} action={&create_action} create form={&create} />
        </Dialog>
        {bulk_dialogs(t, p, bulk.preview, bulk.job)}
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The fields list, its filters, and the create dialog.
pub fn field_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::FieldQuery,
    screen: &'a ListScreen<Field>,
    create: Option<Draft<FieldInput>>,
    notice: Option<String>,
    bulk: Bulk<'a>,
) -> impl Render + 'a {
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(FieldInput::blank()));
    let title = t.field_list_fields();
    let list = url::Fields::of(query);
    let create_action = list.href();
    let live = url::FieldsLive { query: query.clone() }.href();
    let filters = url::Fields::default().href();
    let (states, types) = (statuses(t), value_types(t));
    let flags = [("true", t.list_yes()), ("false", t.list_no())];
    let f = url::FieldQuery::FIELDS;
    html! {
        <ListPage title={title}>
            <Trigger dialog={ids::CREATE_DIALOG} label={t.field_list_new_field()} secondary={false} />
        </ListPage>
        <Filters t={t} action={&filters}>
            <Search t={t} name={f.search} title={title} value={value(&query.search)} />
            <Pick
                label={t.list_status()}
                name={f.status}
                all={t.list_all_statuses()}
                options={&states}
                value={value(&query.status)}
            />
            <Pick
                label={t.field_list_value_type()}
                name={f.value_type}
                all={t.list_all_value_types()}
                options={&types}
                value={value(&query.value_type)}
            />
            <Pick
                label={t.field_list_filterable()}
                name={f.filterable}
                all={t.list_all()}
                options={&flags}
                value={value(&query.filterable)}
            />
            <Pick
                label={t.field_list_searchable()}
                name={f.searchable}
                all={t.list_all()}
                options={&flags}
                value={value(&query.searchable)}
            />
            <Pick
                label={t.field_list_sortable()}
                name={f.sortable}
                all={t.list_all()}
                options={&flags}
                value={value(&query.sortable)}
            />
        </Filters>
        <corten-live src={&live}>{field_rows(t, p, query, screen, bulk.manage)}</corten-live>
        <Dialog
            id={ids::CREATE_DIALOG}
            title={t.field_list_create_field()}
            description={None}
            open={open}
            close={p.catalog_close()}
        >
            <FieldForm t={t} id={ids::CREATE} action={&create_action} create form={&create} />
        </Dialog>
        {bulk_dialogs(t, p, bulk.preview, bulk.job)}
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// A list page's bulk dialogs: the preview (closed and empty until a preview answers) and the
/// job it follows.
fn bulk_dialogs<'a>(t: Cat, p: Pilot, preview: Option<Previewed<'a>>, job: Option<Followed<'a>>) -> impl Render + 'a {
    html! {
        if let Some(shown) = preview {
            <PreviewDialog t={t} p={p} shown={shown} />
        } else {
            <dialog id={ids::PREVIEW_DIALOG}></dialog>
        }
        if let Some(followed) = job {
            <JobDialog t={t} p={p} job={followed.job} label={followed.label} live={followed.live.as_deref()} />
        }
    }
}

/// The dimensions list's rows (or its empty state) and pager, by `ids::ROWS`: drawn in the page,
/// and again on each change to the list (`dimensions_live`). With `manage`, the bulk bar above
/// them and a box on each row.
pub fn dimension_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::DimensionQuery,
    screen: &'a ListScreen<Dimension>,
    manage: bool,
) -> impl Render + 'a {
    let title = t.dimension_list_dimensions();
    let filtered = query.search.is_some() || query.status.is_some() || query.value_kind.is_some();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if filtered {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.dimension_dimension().to_lowercase()).to_string()
    };
    let head = [t.dimension_list_key(), t.dimension_list_name(), t.dimension_list_value_kind(), t.dimension_list_status(), ""];
    let (previous, next) = pages_around(screen, |page| {
        url::Dimensions::of(&url::DimensionQuery { page: (page > 1).then_some(page), ..query.clone() }).href()
    });
    let preview = url::DimensionsBulk { query: query.clone() }.href();
    let actions = bulk_actions(t.dimension_activate(), t.dimension_deprecate(), t.dimension_archive());
    let select = manage.then_some(p);
    html! {
        let body = html! {
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={select}>
                    for row in &screen.items {
                        <DimensionRow t={t} row={row} select={select} />
                    }
                </Table>
                <Pager
                    t={t}
                    p={p}
                    page={screen.page}
                    pages={screen.pages}
                    previous={previous.as_deref()}
                    next={next.as_deref()}
                />
            }
        };
        if manage {
            let bar = Bar { entity: title, action: &preview, total: screen.total, actions: &actions };
            <BulkRows t={t} p={p} bar={bar} fields={()} more={()}>{body}</BulkRows>
        } else {
            <div id={ids::ROWS}>{body}</div>
        }
    }
}

/// The fields list's rows and pager, by `ids::ROWS` (see `dimension_rows`).
pub fn field_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::FieldQuery,
    screen: &'a ListScreen<Field>,
    manage: bool,
) -> impl Render + 'a {
    let title = t.field_list_fields();
    let filtered = query.search.is_some()
        || query.status.is_some()
        || query.value_type.is_some()
        || query.filterable.is_some()
        || query.searchable.is_some()
        || query.sortable.is_some();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if filtered {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.field_field().to_lowercase()).to_string()
    };
    let head = [t.field_list_key(), t.field_list_name(), t.field_list_type(), t.field_list_status(), ""];
    let (previous, next) = pages_around(screen, |page| {
        url::Fields::of(&url::FieldQuery { page: (page > 1).then_some(page), ..query.clone() }).href()
    });
    let preview = url::FieldsBulk { query: query.clone() }.href();
    let actions = bulk_actions(t.field_activate(), t.field_deprecate(), t.field_archive());
    let select = manage.then_some(p);
    html! {
        let body = html! {
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={select}>
                    for row in &screen.items {
                        <FieldRow t={t} row={row} select={select} />
                    }
                </Table>
                <Pager
                    t={t}
                    p={p}
                    page={screen.page}
                    pages={screen.pages}
                    previous={previous.as_deref()}
                    next={next.as_deref()}
                />
            }
        };
        if manage {
            let bar = Bar { entity: title, action: &preview, total: screen.total, actions: &actions };
            <BulkRows t={t} p={p} bar={bar} fields={()} more={()}>{body}</BulkRows>
        } else {
            <div id={ids::ROWS}>{body}</div>
        }
    }
}

/// A dimension: its values, its status change, its options, and the dialogs that edit them.
pub fn dimension_page<'a>(
    t: Cat,
    p: Pilot,
    d: &'a DimensionDetail,
    notice: Option<String>,
    forms: DimensionForms,
) -> impl Render + 'a {
    let DimensionForms { edit, lifecycle, add, option, option_lifecycle, reorder } = forms;
    let dimension = &d.dimension;
    let id = dimension.dimension_id.as_str();
    let editable = dimension.status != "archived";
    let (edit_open, add_open, reorder_open) = (edit.is_some(), add.is_some(), reorder.is_some());
    let edit = edit.unwrap_or_else(|| Draft::new(DimensionInput::of(dimension)));
    let add = add.unwrap_or_else(|| Draft::new(OptionInput::blank()));
    let order = d.options.iter().map(|o| o.option_id.as_str()).collect::<Vec<_>>().join(", ");
    let reorder = reorder.unwrap_or_else(|| Draft::new(ReorderInput { option_ids: order }));
    let lifecycle = lifecycle.unwrap_or_default();
    let steps = transitions(&dimension.status, t.dimension_activate(), t.dimension_deprecate(), t.dimension_archive());
    let dash = "\u{2014}";
    let items = [
        (t.dimension_key(), dimension.key.clone()),
        (t.dimension_name(), dimension.name.clone()),
        (t.dimension_description(), dimension.description.clone().unwrap_or_else(|| dash.into())),
        (t.dimension_value_kind(), dimension.value_kind.clone()),
        (t.dimension_status(), dimension.status.clone()),
        (t.dimension_updated(), dimension.updated_at.clone()),
    ];
    let count = t.dimension_option_count(d.options.len()).to_string();
    let list = url::Dimensions::default().href();
    let (edit_action, lifecycle_action) = (url::DimensionEdit { id }.href(), url::DimensionLifecycle { id }.href());
    let (add_action, reorder_action) = (url::Options { id }.href(), url::OptionOrder { id }.href());
    html! {
        <DetailPage p={p} list={&list} list_label={t.dimension_dimensions()} name={&dimension.name}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={ids::LIFECYCLE}
                    action={&lifecycle_action}
                    status={&dimension.status}
                    transitions={&steps}
                    errors={&lifecycle}
                />
                if editable {
                    <Trigger dialog={ids::EDIT_DIALOG} label={t.dimension_edit()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
            <Part title={t.dimension_options()} description={&count}>
                if editable {
                    <ActionBar>
                        <Trigger dialog={ids::ADD_OPTION_DIALOG} label={t.dimension_add_option()} secondary={false} />
                        if d.options.len() > 1 {
                            <Trigger dialog={ids::REORDER_DIALOG} label={t.dimension_reorder()} secondary />
                        }
                    </ActionBar>
                }
                <OptionTable t={t} p={p} dimension={d} editing={option.as_ref()} refused={option_lifecycle.as_ref()} />
            </Part>
        </DetailPage>
        if editable {
            <Dialog
                id={ids::EDIT_DIALOG}
                title={t.dimension_edit_dimension()}
                description={None}
                open={edit_open}
                close={p.catalog_close()}
            >
                <DimensionForm t={t} id={ids::EDIT} action={&edit_action} create={false} form={&edit} />
            </Dialog>
            <Dialog
                id={ids::ADD_OPTION_DIALOG}
                title={t.dimension_add_option_2()}
                description={None}
                open={add_open}
                close={p.catalog_close()}
            >
                <OptionForm t={t} id={ids::ADD_OPTION} action={&add_action} add form={&add} />
            </Dialog>
            <Dialog
                id={ids::REORDER_DIALOG}
                title={t.dimension_reorder_options()}
                description={Some(t.dimension_enter_option_ids_separated_by_commas())}
                open={reorder_open}
                close={p.catalog_close()}
            >
                <ReorderForm t={t} id={ids::REORDER} action={&reorder_action} form={&reorder} />
            </Dialog>
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// A field: its values, its status change, and its configure dialog.
pub fn field_page<'a>(t: Cat, p: Pilot, field: &'a Field, notice: Option<String>, forms: FieldForms) -> impl Render + 'a {
    let FieldForms { edit, lifecycle } = forms;
    let id = field.field_id.as_str();
    let editable = field.status != "archived";
    let edit_open = edit.is_some();
    let edit = edit.unwrap_or_else(|| Draft::new(FieldInput::of(field)));
    let lifecycle = lifecycle.unwrap_or_default();
    let steps = transitions(&field.status, t.field_activate(), t.field_deprecate(), t.field_archive());
    let yes_no = |on: bool, yes: &str, no: &str| if on { yes.to_owned() } else { no.to_owned() };
    let items = [
        (t.field_key(), field.key.clone()),
        (t.field_name(), field.name.clone()),
        (t.field_description(), field.description.clone().unwrap_or_else(|| "\u{2014}".into())),
        (t.field_value_type(), field.value_type.clone()),
        (t.field_filterable(), yes_no(field.filterable, t.field_yes(), t.field_no())),
        (t.field_searchable(), yes_no(field.searchable, t.field_yes_2(), t.field_no_2())),
        (t.field_sortable(), yes_no(field.sortable, t.field_yes_3(), t.field_no_3())),
        (t.field_status(), field.status.clone()),
        (t.field_updated(), field.updated_at.clone()),
    ];
    let list = url::Fields::default().href();
    let (edit_action, lifecycle_action) = (url::FieldEdit { id }.href(), url::FieldLifecycle { id }.href());
    html! {
        <DetailPage p={p} list={&list} list_label={t.field_fields()} name={&field.name}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={ids::LIFECYCLE}
                    action={&lifecycle_action}
                    status={&field.status}
                    transitions={&steps}
                    errors={&lifecycle}
                />
                if editable {
                    <Trigger dialog={ids::EDIT_DIALOG} label={t.field_configure()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
        </DetailPage>
        if editable {
            <Dialog
                id={ids::EDIT_DIALOG}
                title={t.field_configure_field()}
                description={None}
                open={edit_open}
                close={p.catalog_close()}
            >
                <FieldForm t={t} id={ids::EDIT} action={&edit_action} create={false} form={&edit} />
            </Dialog>
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}
