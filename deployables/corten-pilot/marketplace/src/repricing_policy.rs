//! A repricing policy's page (marketplace's `account-desk-repricing-policy` route,
//! `/account/desk/repricing/{id}`): the policy's status, settings and rules, the account-wide halt,
//! and the policy's activity with its filters and next page; Pause or Resume, Delete (asked
//! first) and the halt.
//!
//! Reads, as marketplace's loader makes them: the policy, after the write whose receipt the address
//! carries (while that read catches up, or does not find a policy just written, the page says the
//! change is saved and reads itself again; without a receipt a missing policy is a 404). Only once
//! the policy is found, and without the receipt: the halt, the day's changes and the activity, each
//! best-effort (a failed halt reads as released with its switch off, failed changes as none, and
//! failed activity says so).
//!
//! Every write posts to the page and goes back to it, a policy's write with its receipt; Delete
//! goes to the list with the receipt. A refusal is drawn on the page (422).
//!
//! Edit opens the editor on the page (marketplace's `PolicyEditorDrawer` with the policy's body):
//! `?edit=open` as the page's Edit opens it, `?edit=1` as marketplace's own address writes it (Pricing
//! Health's link), which opens a custom policy in the advanced editor (`initialTier`). A policy whose
//! authoring intent its rules still say opens in its preset's or Pricing Goal's simple controls
//! (`repricing_body`); Open up this preset, Open advanced editor and Return to simple controls move
//! between them. The editor is one form that works without a script: each post carries the body it
//! drew, and the page answers with the editor drawn again over what was posted (Apply, each button
//! that adds, removes or moves a rule, condition or anchor, and a choice that changes with a
//! script), with the dry run Preview started (its part relayed live, `repricing::live`), or, for
//! Save policy, Pricing's revise and the page read after it. Save needs no preview, as
//! marketplace's does not. A refusal keeps what was posted (422).
use std::{collections::BTreeMap, time::Duration};

use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    api::{
        ApiError, RepricingActivityPage, RepricingCalls as _, RepricingCategory, RepricingHalt, RepricingPolicy,
        RepricingPrerequisites, RepricingScopePreview,
    },
    app::{PRICING_MANAGE, Shared, read_failed, sign_in, url},
    auth::{PricingManager, Viewer},
    repricing::{self, DryRunView, Editor, EditorInput, ended, messages},
    repricing_body::{self, AnchorFields, ConditionFields, Op, Posted, RuleFields, Source, Tier},
    text::RepricingMsg,
    views::{self, Layout},
};

/// The activity's filters in marketplace's strip order (`repricingActivityFilterOrder`): changed,
/// each skip reason, then the three that are not an outcome.
pub const FILTERS: [&str; 19] = [
    "changed",
    "within-tolerance",
    "anchor-chain-exhausted",
    "terminal-hold",
    "terminal-pause",
    "terminal-notify-only",
    "currency-input-incomplete-or-mismatched",
    "budget-exhausted",
    "manual-edit-conflict",
    "domain-no-op",
    "policy-precondition-failed",
    "spiral-breaker-frozen",
    "resume-hysteresis",
    "repause-cooldown",
    "command-error",
    "hopeless-forecast-hold",
    "paused-for-missing-input",
    "floor-binding",
    "spiral-breaker",
];

/// The three counts shown whatever the filter (`repricingAlwaysVisibleFilters`).
pub const ALWAYS_COUNTED: [&str; 3] = ["paused-for-missing-input", "floor-binding", "budget-exhausted"];

/// The page's address: the receipt of the write it follows, and the activity's filter and page.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub filter: Option<String>,
    /// The activity after this listing (Show more activity).
    pub after: Option<String>,
    /// The editor is open: `open` from the page's Edit, `1` from marketplace's own address.
    pub edit: Option<String>,
}

impl Place {
    /// The editor's address (the page's Edit).
    pub fn edit() -> Place {
        Place { edit: Some("open".into()), ..Place::default() }
    }

    /// Whether the address opens the editor, and the tier it asks for (`initialTier`).
    fn opens(&self) -> Option<Option<Tier>> {
        match self.edit.as_deref()? {
            "1" => Some(Some(Tier::Advanced)),
            _ => Some(None),
        }
    }

    /// The filter the activity is read with; one the pilot does not know reads as all
    /// (`repricingActivityFilterFrom`).
    pub fn filter(&self) -> Option<&'static str> {
        self.filter.as_deref().and_then(|filter| FILTERS.into_iter().find(|known| *known == filter))
    }
}

/// A write: Pause, Resume, Delete, the halt, and the editor's posts. The editor's carry its tier,
/// the body it drew and its dry run, and its controls: the preset's, named as the create editor's
/// (`repricing::WriteForm`), and each rule's, condition's and anchor's as rows.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct PolicyForm {
    pub intent: String,
    /// A button that changes the rules' shape (`repricing_body::Op`).
    pub op: Option<String>,
    pub tier: Option<String>,
    pub body: Option<String>,
    pub dry_run: Option<String>,
    /// The dry run's samples after this listing (Next 100 results).
    pub after: Option<String>,
    pub name: Option<String>,
    pub preset: Option<String>,
    pub from: Option<String>,
    pub knob: Option<String>,
    pub age: Option<String>,
    pub currency: Option<String>,
    pub floor: Option<String>,
    pub amount: Option<String>,
    pub margin: Option<String>,
    pub fallback: Option<String>,
    pub scope: Option<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    pub listings: Option<String>,
    pub excluded: Option<String>,
    pub cap: Option<String>,
    #[fields(rows)]
    #[serde(default)]
    pub rules: BTreeMap<u32, RuleFields>,
    #[fields(rows)]
    #[serde(default)]
    pub conditions: BTreeMap<String, ConditionFields>,
    #[fields(rows)]
    #[serde(default)]
    pub anchors: BTreeMap<String, AnchorFields>,
}

impl PolicyForm {
    fn input(&self) -> EditorInput {
        EditorInput {
            name: self.name.clone(),
            preset: self.preset.clone(),
            from: self.from.clone(),
            knob: self.knob.clone(),
            age: self.age.clone(),
            currency: self.currency.clone(),
            floor: self.floor.clone(),
            amount: self.amount.clone(),
            margin: self.margin.clone(),
            fallback: self.fallback.clone(),
            scope: self.scope.clone(),
            categories: self.categories.clone(),
            listings: self.listings.clone(),
        }
    }

    fn posted(&self) -> Posted<'_> {
        Posted {
            name: self.name.as_deref(),
            scope: self.scope.as_deref(),
            categories: &self.categories,
            listings: self.listings.as_deref(),
            excluded: self.excluded.as_deref(),
            cap: self.cap.as_deref(),
            rules: &self.rules,
            conditions: &self.conditions,
            anchors: &self.anchors,
        }
    }
}

/// The editor as a post left it: its tier, the body its controls draw (a custom policy's or a
/// Pricing Goal's), or the preset's controls, and its dry run.
pub struct Revise {
    pub tier: Tier,
    pub body: Value,
    /// The preset tier's controls, which compile the body.
    pub preset: Option<Editor>,
    pub dry_run: Option<String>,
    pub after: Option<String>,
    pub errors: Vec<String>,
}

impl Revise {
    /// The editor at the policy as Pricing has it (`initialBody`), in the tier it opens in.
    fn open(raw: &Value, facts: &RepricingPrerequisites, requested: Option<Tier>) -> Revise {
        let body = json!({
            "authoringIntent": raw.get("authoringIntent").cloned().unwrap_or(Value::Null),
            "name": raw["name"].as_str().unwrap_or_default(),
            "scope": raw["scope"],
            "rules": raw["rules"],
            "excludedListingIds": raw.get("excludedListingIds").cloned().unwrap_or_else(|| json!([])),
            "maxChangesPerDay": raw["maxChangesPerDay"],
        });
        let tier = Tier::opened(&body, |goal, version| facts.selectable(goal, version), requested);
        let mut revise = Revise { tier, body, preset: None, dry_run: None, after: None, errors: Vec::new() };
        revise.simple(facts);
        revise
    }

    /// The editor a post drew, with its controls laid over its body. None when the post carries
    /// no body the editor can read.
    fn posted(form: &PolicyForm, facts: &RepricingPrerequisites, t: RepricingMsg) -> Option<Revise> {
        let tier = form.tier.as_deref().and_then(Tier::read)?;
        let mut body: Value = serde_json::from_str(form.body.as_deref()?).ok().filter(Value::is_object)?;
        let preset = if tier == Tier::Preset {
            let editor = Editor::read(&form.input(), facts, t);
            body = editor.compile();
            Some(editor)
        } else {
            repricing_body::read(&mut body, tier, &form.posted());
            None
        };
        let text = |value: &Option<String>| value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
        Some(Revise { tier, body, preset, dry_run: text(&form.dry_run), after: text(&form.after), errors: Vec::new() })
    }

    /// In a preset's tier, its controls from the body's intent.
    fn simple(&mut self, facts: &RepricingPrerequisites) {
        match (self.tier, repricing_body::recognize(&self.body)) {
            (Tier::Preset, Some(Source::Preset { preset, knob, age })) => {
                self.preset = Some(Editor::of_preset(&self.body, preset, knob, age));
            }
            (Tier::Preset, _) => self.tier = Tier::opened(&self.body, |goal, version| facts.selectable(goal, version), None),
            _ => self.preset = None,
        }
    }

    /// The body the editor would save (`candidate`).
    pub fn candidate(&self) -> Value {
        self.preset.as_ref().map_or_else(|| self.body.clone(), Editor::compile)
    }

    /// The editor has what a preview or a save needs (`promptComplete`): a preset's currency and
    /// floor's amount; a body's controls are always complete.
    fn complete(&self) -> bool {
        self.preset.as_ref().is_none_or(Editor::complete)
    }

    /// Open up this preset, Open advanced editor, Return to simple controls (`openAdvanced`, and the
    /// intent's `setTier`), or a button that changes the rules' shape.
    fn change(&mut self, intent: &str, op: Option<Op>, facts: &RepricingPrerequisites) {
        match intent {
            "open-up" | "open-advanced" => {
                let one = self.tier == Tier::Preset && repricing_body::rules_of(&self.candidate()).len() == 1;
                self.body = self.candidate();
                self.preset = None;
                self.tier = if one { Tier::Structured } else { Tier::Advanced };
            }
            "simple" => {
                let goal_supported = |anchor: &Value| {
                    facts.selectable(
                        anchor["goalId"].as_str().unwrap_or_default(),
                        anchor["goalVersion"].as_f64().unwrap_or_default(),
                    )
                };
                if repricing_body::goal_anchor(&self.body).is_none_or(goal_supported) {
                    match repricing_body::recognize(&self.body) {
                        Some(Source::Preset { .. }) => {
                            self.tier = Tier::Preset;
                            self.simple(facts);
                        }
                        Some(Source::Goal { .. }) => self.tier = Tier::Goal,
                        None => {}
                    }
                }
            }
            _ => {}
        }
        if let Some(op) = op.filter(|_| matches!(self.tier, Tier::Structured | Tier::Advanced)) {
            let before = repricing_body::body_key(&self.body);
            op.apply(&mut self.body);
            repricing_body::unbind_if_changed(&mut self.body, &before);
        }
    }
}

/// The editor with what it read.
pub struct ReviseScreen {
    pub tier: Tier,
    /// The body the controls draw, and the post carries back.
    pub body: Value,
    pub preset: Option<Editor>,
    pub facts: RepricingPrerequisites,
    pub categories: Vec<RepricingCategory>,
    /// The intent the body's rules still say: Return to simple controls.
    pub intent: Option<Source>,
    /// A rule anchors on a Pricing Goal version a seller may not choose.
    pub unsupported_goal: bool,
    /// What the scope matches; none when Pricing could not say.
    pub preview: Option<RepricingScopePreview>,
    pub run: Option<DryRunView>,
    pub errors: Vec<String>,
}

/// The editor, or that it could not read what it starts from.
pub enum ReviseEditor {
    Ready(Box<ReviseScreen>),
    Unavailable,
}

/// The editor for `revise` (a post's) or for the policy as Pricing has it, with its scope preview
/// and dry run.
async fn revise_part(
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    raw: &Value,
    requested: Option<Tier>,
    revise: Option<Revise>,
) -> Result<ReviseEditor, ApiError> {
    let caller = config.platform.caller(headers, config.proto, None);
    let (facts, categories) = tokio::join!(caller.repricing_prerequisites(), caller.repricing_categories());
    let (facts, categories) = match (facts, categories) {
        (Ok(facts), Ok(categories)) => (facts, categories),
        (Err(error), _) | (_, Err(error)) => {
            if ended(&error) {
                return Err(error);
            }
            tracing::warn!("the repricing editor's prerequisites could not be read: {error}");
            return Ok(ReviseEditor::Unavailable);
        }
    };
    let revise = revise.unwrap_or_else(|| Revise::open(raw, &facts, requested));
    let candidate = revise.candidate();
    let unsupported_goal = repricing_body::goal_anchor(&candidate).is_some_and(|anchor| {
        !facts.selectable(anchor["goalId"].as_str().unwrap_or_default(), anchor["goalVersion"].as_f64().unwrap_or_default())
    });
    let intent = if unsupported_goal { None } else { repricing_body::recognize(&candidate) };
    let scope = json!({
        "scope": candidate["scope"],
        "excludedListingIds": candidate.get("excludedListingIds").cloned().unwrap_or_else(|| json!([])),
        "replacingPolicyId": id,
    });
    let run = async {
        match revise.dry_run.as_deref() {
            Some(run) => Some(repricing::dry_run(config, headers, run, revise.after.as_deref()).await),
            None => None,
        }
    };
    let (preview, run) = tokio::join!(caller.repricing_scope_preview(&scope), run);
    let preview = preview.map_err(|error| tracing::warn!("the scope preview failed: {error}")).ok();
    let run = match run {
        Some(Ok((run, traces))) => {
            let current = repricing_body::body_key(&candidate) == repricing_body::body_key(&run.body);
            let place = repricing::Place { revise: Some(id.to_owned()), ..repricing::Place::default() };
            Some(DryRunView { run, traces, current, place, revise: true })
        }
        Some(Err(error)) if ended(&error) => return Err(error),
        Some(Err(error)) => {
            tracing::warn!("the editor's dry run could not be read: {error}");
            None
        }
        None => None,
    };
    let Revise { tier, preset, errors, .. } = revise;
    let body = candidate;
    Ok(ReviseEditor::Ready(Box::new(ReviseScreen {
        tier,
        body,
        preset,
        facts,
        categories,
        intent,
        unsupported_goal,
        preview,
        run,
        errors,
    })))
}

/// What the page shows.
pub struct PolicyScreen {
    pub id: String,
    pub policy: RepricingPolicy,
    pub halt: RepricingHalt,
    /// The halt could not be read: it shows as released and its switch is off.
    pub halt_failed: bool,
    pub changes_used_today: u64,
    /// The activity, or none when it could not be read.
    pub activity: Option<RepricingActivityPage>,
    pub filter: Option<&'static str>,
    /// What a write was refused for.
    pub refusal: Option<Vec<String>>,
    /// The reader may change the policy and the halt (`pricing.manage`).
    pub manage: bool,
    /// The editor, when the address or a post opens it.
    pub editor: Option<ReviseEditor>,
}

/// The page at `place`, with what a write was refused for.
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    place: &Place,
    refusal: Option<Vec<String>>,
    revise: Option<Revise>,
    status: StatusCode,
) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let read = config.platform.caller(headers, config.proto, receipt.as_ref()).repricing_policy(id).await;
    let (policy, raw) = match read {
        Ok(read) => read,
        // A write the read has not reached, or a policy just written that it does not have yet.
        Err(error) if receipt.is_some() && (error.catching_up() || error.status() == Some(StatusCode::NOT_FOUND)) => {
            let here = url::RepricingPolicy { id, place: Place { after_write: place.after_write.clone(), ..Place::default() } };
            let head = html! {
                <meta name="robots" content="noindex">
                <ReadAgain after={Duration::from_secs(2)} />
            };
            let page = html! {
                <Layout req={req} viewer={Some(viewer)} title={t.route_policy_meta_title()} head={head}>
                    <views::RepricingPolicyCatchingUp t={t} refresh={here.href()} />
                </Layout>
            };
            return req.page(page);
        }
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return Err(corten::Error::status(StatusCode::NOT_FOUND));
        }
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let caller = config.platform.caller(headers, config.proto, None);
    let filter = place.filter();
    let (halt, budget, activity) = tokio::join!(
        caller.repricing_halt(),
        caller.repricing_budget(),
        caller.repricing_activity(id, filter, place.after.as_deref().filter(|after| !after.is_empty())),
    );
    let ended = |error: &ApiError| error.status() == Some(StatusCode::UNAUTHORIZED);
    if [halt.as_ref().err(), budget.as_ref().err(), activity.as_ref().err()].into_iter().flatten().any(ended) {
        return sign_in(req);
    }
    if let Err(error) = &halt {
        tracing::warn!("the repricing halt could not be read: {error}");
    }
    if let Err(error) = &budget {
        tracing::warn!("the repricing budget could not be read: {error}");
    }
    let activity = activity.map_err(|error| tracing::warn!("a repricing policy's activity could not be read: {error}")).ok();
    let manage = viewer.actor.can(PRICING_MANAGE);
    let opens = place.opens().filter(|_| manage && policy.status != "deleted");
    let editor = if revise.is_some() || opens.is_some() {
        match revise_part(config, headers, id, &raw, opens.flatten(), revise).await {
            Ok(part) => Some(part),
            Err(_) => return sign_in(req),
        }
    } else {
        None
    };
    let screen = PolicyScreen {
        id: id.to_owned(),
        policy,
        halt_failed: halt.is_err(),
        halt: halt.unwrap_or_default(),
        changes_used_today: budget.map(|budget| budget.changes_used).unwrap_or_default(),
        activity,
        filter,
        refusal,
        manage,
        editor,
    };
    let head = html! {
        <meta name="description" content={t.route_meta_description()}>
        <meta name="robots" content="noindex">
    };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_policy_meta_title()} head={head}>
            <views::RepricingPolicyPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The page, read after the write its address names.
pub(crate) async fn page(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::repricing::RepricingPolicy<'_>>,
) -> HtmlResult {
    render(&req, &viewer, &config, &headers, &route.id, &route.place, None, None, StatusCode::OK).await
}

/// Pause, Resume, Delete, the halt and the editor's posts (marketplace's action's intents). A
/// policy's write goes back to the page with its receipt and Delete to the list with it; the halt
/// is its own aggregate and goes back without one, as marketplace's does. An editor's post answers
/// with the editor (`editor`).
pub(crate) async fn write(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::repricing::RepricingPolicy<'_>>,
    Form(form): Form<PolicyForm>,
) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let id = route.id.to_string();
    if form.tier.is_some() {
        return editor(&req, &viewer, &config, &headers, &id, &form).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let here = |receipt: Option<&Receipt>| url::RepricingPolicy {
        id: &id,
        place: Place { after_write: receipt.map(Receipt::param), ..Place::default() },
    };
    let refused = match form.intent.as_str() {
        intent @ ("pause-policy" | "resume-policy" | "delete-policy") => {
            let change = intent.trim_end_matches("-policy");
            match caller.repricing_lifecycle(&id, change).await {
                Ok(receipt) if change == "delete" => {
                    return req.redirect(&url::Repricing { place: crate::repricing::Place::list(receipt.as_ref()) });
                }
                Ok(receipt) => return req.redirect(&here(receipt.as_ref())),
                Err(refusal) => refusal,
            }
        }
        intent @ ("engage-halt" | "release-halt") => match caller.set_repricing_halt(intent == "engage-halt").await {
            Ok(_) => return req.redirect(&here(None)),
            Err(refusal) => refusal,
        },
        _ => {
            let refusal = Some(vec![t.route_unknown_action().to_owned()]);
            let place = Place::default();
            return render(&req, &viewer, &config, &headers, &id, &place, refusal, None, StatusCode::UNPROCESSABLE_ENTITY).await;
        }
    };
    match messages(&req, refused, t.route_action_failed()) {
        Ok(details) => {
            let place = Place::default();
            render(&req, &viewer, &config, &headers, &id, &place, Some(details), None, StatusCode::UNPROCESSABLE_ENTITY).await
        }
        Err(answer) => *answer,
    }
}

/// An editor's post: its controls over the body it drew, then what it asked. Preview starts the
/// dry run of the policy as it is now, replacing this one; Save policy revises it and reads the page
/// after the revise; anything else draws the editor again. A refused preview or save keeps what was
/// posted (422).
async fn editor(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, id: &str, form: &PolicyForm) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, None);
    let facts = match caller.repricing_prerequisites().await {
        Ok(facts) => facts,
        Err(error) if ended(&error) => return sign_in(req),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    let Some(mut revise) = Revise::posted(form, &facts, t) else {
        // A post without a body the editor can read opens the editor at the policy again.
        let refusal = Some(vec![t.editor_validation_failed().to_owned()]);
        return render(req, viewer, config, headers, id, &Place::edit(), refusal, None, StatusCode::UNPROCESSABLE_ENTITY).await;
    };
    let again = |revise: Revise, status: StatusCode| answer(req, viewer, config, headers, id, revise, status);
    // Open up a preset only once it has what a preview needs, as marketplace's button is off until
    // then (`promptComplete`); without the script the post is how the pilot finds out.
    if matches!(form.intent.as_str(), "open-up" | "open-advanced") && !revise.complete() {
        revise.errors = vec![t.editor_validation_failed().to_owned()];
        return again(revise, StatusCode::UNPROCESSABLE_ENTITY).await;
    }
    revise.change(&form.intent, form.op.as_deref().and_then(Op::read), &facts);
    match form.intent.as_str() {
        "preview" | "revise-policy" if !revise.complete() => {
            revise.errors = vec![t.editor_validation_failed().to_owned()];
            again(revise, StatusCode::UNPROCESSABLE_ENTITY).await
        }
        "preview" => {
            let mut body = revise.candidate();
            body["replacingPolicyId"] = json!(id);
            match caller.start_repricing_dry_run(&body).await {
                Ok(run) => {
                    revise.dry_run = Some(run.dry_run_id);
                    revise.after = None;
                    again(revise, StatusCode::OK).await
                }
                Err(refusal) => match messages(req, refusal, t.editor_validation_failed()) {
                    Ok(errors) => {
                        revise.errors = errors;
                        again(revise, StatusCode::UNPROCESSABLE_ENTITY).await
                    }
                    Err(answer) => *answer,
                },
            }
        }
        "revise-policy" => match caller.revise_repricing_policy(id, &revise.candidate()).await {
            Ok(receipt) => req.redirect(&url::RepricingPolicy {
                id,
                place: Place { after_write: receipt.as_ref().map(Receipt::param), ..Place::default() },
            }),
            Err(refusal) => match messages(req, refusal, t.route_action_failed()) {
                Ok(errors) => {
                    revise.errors = errors;
                    again(revise, StatusCode::UNPROCESSABLE_ENTITY).await
                }
                Err(answer) => *answer,
            },
        },
        _ => again(revise, StatusCode::OK).await,
    }
}

/// The editor drawn again over `revise`: its part for the runtime's post (a patch), else the page.
async fn answer(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    revise: Revise,
    status: StatusCode,
) -> HtmlResult {
    if req.mode != corten::Mode::Action {
        return render(req, viewer, config, headers, id, &Place::edit(), None, Some(revise), status).await;
    }
    let part = match revise_part(config, headers, id, &Value::Null, None, Some(revise)).await {
        Ok(part) => part,
        Err(_) => return sign_in(req),
    };
    let (t, p): (RepricingMsg, crate::text::Pilot) = (req.t(), req.t());
    req.patch_with_status(status, html! { <views::ReviseSection t={t} p={p} id={id} editor={&part} /> })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_filter_the_pilot_does_not_know_reads_as_all() {
        let place = |filter: &str| Place { filter: Some(filter.into()), ..Place::default() };
        assert_eq!(place("floor-binding").filter(), Some("floor-binding"));
        assert_eq!(place("budget-exhausted").filter(), Some("budget-exhausted"));
        assert_eq!(place("everything").filter(), None);
        assert_eq!(Place::default().filter(), None);
    }

    #[test]
    fn the_always_counted_filters_are_filters() {
        assert!(ALWAYS_COUNTED.iter().all(|counted| FILTERS.contains(counted)));
    }
}
