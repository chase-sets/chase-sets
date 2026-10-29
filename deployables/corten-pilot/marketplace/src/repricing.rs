//! The Seller Desk's repricing page (marketplace's `account-desk-repricing` route,
//! `/account/desk/repricing`): the account's repricing policies with Pause and Resume, the
//! account-wide halt, the recent dry runs, and the preset editor that previews a policy as a dry
//! run and activates it.
//!
//! Reads, as marketplace's loader makes them: the policies (after the write whose receipt the
//! address carries; while that read catches up the page says the change is saved and reads itself
//! again), the halt and the recent dry runs (best-effort: a failed halt read leaves the halt as
//! released and its switch off, and says the list could not load, as marketplace does).
//!
//! The editor is at its own address (`?create=1`) and works without a script: its controls are a
//! GET form, so the address holds the policy being written and the page draws it, with the scope
//! preview Pricing answers for it. Preview posts the form; the pilot compiles the preset into the
//! dry run's body (`Editor::compile`, marketplace's `compileRepricingPreset`; Pricing does not
//! compile it, chase-sets/chase-sets#10682), starts the dry run and goes to the editor's address
//! with the run. While the run is not finished the page relays its status stream
//! (`<corten-live>` on `live`), which draws the result when it completes; without a script the
//! result part has a link to read the page again. Activate posts the form with the run: the pilot
//! activates only a completed, unused run whose body is the form's policy (marketplace's
//! `canActivate`), so a setting changed after the preview asks for a new preview. With a script
//! the form applies a choice as it changes (search's pattern); a text field waits for Apply or
//! Enter.
//!
//! A policy's own page and its activity are `repricing_policy`, which a policy's name opens.
//!
//! Not ported: the structured and advanced rule editors (Open up this preset) and revising a policy.
use std::time::Duration;

use corten::{
    LiveResponse,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use futures_util::StreamExt;
use platform::receipt::Receipt;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    api::{
        ApiError, PRICING_CONTEXT, PricingRefusal, RepricingCalls as _, RepricingCategory, RepricingDryRun, RepricingHalt,
        RepricingPolicyRow, RepricingPrerequisites, RepricingScope, RepricingScopePreview, RepricingTrace,
        repricing_dry_run_events,
    },
    app::{PRICING_MANAGE, Shared, sign_in, url},
    auth::{PricingManager, Viewer},
    text::{Pilot, RepricingMsg},
    views::{self, Layout},
};

/// A seller's preset strategy (marketplace's `repricingPresets`), in the editor's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    Track,
    Beat,
    Premium,
    Slow,
}

impl Preset {
    pub const ALL: [Preset; 4] = [Preset::Track, Preset::Beat, Preset::Premium, Preset::Slow];

    pub fn key(self) -> &'static str {
        match self {
            Preset::Track => "track-market",
            Preset::Beat => "beat-lowest",
            Preset::Premium => "premium",
            Preset::Slow => "slow-stock",
        }
    }

    pub fn read(key: &str) -> Option<Preset> {
        Preset::ALL.into_iter().find(|preset| preset.key() == key)
    }

    /// The knob's range and default (`min`, `max`, `defaultValue`).
    pub fn knob(self) -> (i64, i64, i64) {
        match self {
            Preset::Track => (-25, 25, 0),
            Preset::Beat => (0, 15, 2),
            Preset::Premium => (0, 30, 5),
            Preset::Slow => (0, 30, 10),
        }
    }

    pub fn title(self, t: RepricingMsg) -> &'static str {
        match self {
            Preset::Track => t.editor_preset_track(),
            Preset::Beat => t.editor_preset_beat(),
            Preset::Premium => t.editor_preset_premium(),
            Preset::Slow => t.editor_preset_slow(),
        }
    }
}

/// Slow stock's age bounds and default, in days (the editor's slider).
pub const AGE: (i64, i64, i64) = (14, 180, 45);

/// The price floor (`RepricingFloor`).
#[derive(Clone, Debug, PartialEq)]
pub enum Floor {
    Absolute { amount: String },
    CostPlus { margin: f64, fallback: String },
}

/// The policy the editor is writing.
#[derive(Clone, Debug, PartialEq)]
pub struct Editor {
    pub name: String,
    pub preset: Preset,
    pub knob: i64,
    pub age: i64,
    pub currency: String,
    pub floor: Floor,
    pub scope: RepricingScope,
}

/// A whole number when it is one, so the body says 10 and not 10.0, as the browser's JSON does.
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 { json!(n as i64) } else { json!(n) }
}

impl Editor {
    /// The editor's controls read with what the account has (`listingCurrencyCodes`,
    /// `hasCostBasis`): a preset chosen anew starts from its own name, knob and age, as
    /// marketplace's Strategy select does; a value out of range is held to it.
    pub fn read(input: &EditorInput, facts: &RepricingPrerequisites, t: RepricingMsg) -> Editor {
        let text = |value: &Option<String>| value.as_deref().map(str::trim).unwrap_or_default().to_owned();
        let whole = |value: &Option<String>| {
            value.as_deref().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite()).map(|v| v.round() as i64)
        };
        let preset = input.preset.as_deref().and_then(Preset::read).unwrap_or(Preset::Track);
        let changed = input.from.as_deref().and_then(Preset::read).is_some_and(|from| from != preset);
        let (min, max, default) = preset.knob();
        let name = if changed || input.name.is_none() { preset.title(t).to_owned() } else { text(&input.name) };
        let knob = if changed { default } else { whole(&input.knob).map_or(default, |k| k.clamp(min, max)) };
        let age = if changed { AGE.2 } else { whole(&input.age).map_or(AGE.2, |a| a.clamp(AGE.0, AGE.1)) };
        let currency = match input.currency.as_deref().map(str::trim) {
            Some(code) => code.to_owned(),
            None if facts.listing_currency_codes.len() == 1 => facts.listing_currency_codes[0].clone(),
            None => String::new(),
        };
        let cost = match input.floor.as_deref() {
            Some("cost-basis-plus-margin") => true,
            Some("absolute") => false,
            _ => facts.has_cost_basis,
        };
        let floor = if cost {
            let margin = input.margin.as_deref().and_then(|m| m.trim().parse::<f64>().ok()).filter(|m| m.is_finite());
            Floor::CostPlus { margin: margin.unwrap_or(10.0), fallback: text(&input.fallback) }
        } else {
            Floor::Absolute { amount: text(&input.amount) }
        };
        let scope = match input.scope.as_deref() {
            Some("catalog-filter") => RepricingScope::CatalogFilter { category_ids: distinct(input.categories.iter().cloned()) },
            Some("listing-set") => {
                RepricingScope::ListingSet { listing_ids: distinct(text(&input.listings).split(',').map(str::to_owned)) }
            }
            _ => RepricingScope::AllListings,
        };
        Editor { name, preset, knob, age, currency, floor, scope }
    }

    /// The prompt has what a preview needs: a currency and a floor's amount (marketplace's
    /// `promptComplete`).
    pub fn complete(&self) -> bool {
        let amount = match &self.floor {
            Floor::Absolute { amount } => amount,
            Floor::CostPlus { fallback, .. } => fallback,
        };
        !self.currency.is_empty() && !amount.is_empty()
    }

    /// The dry run's body for the preset (marketplace's `compileRepricingPreset`), with the name.
    pub fn compile(&self) -> Value {
        let preset = self.preset;
        let anchors = match preset {
            Preset::Beat => json!([{ "source": "lowest-competing-ask" }, { "source": "market-estimate" }]),
            Preset::Premium => json!([{ "source": "comp-percentile", "percentile": 75 }, { "source": "market-estimate" }]),
            Preset::Track | Preset::Slow => {
                json!([{ "source": "market-estimate" }, { "source": "lowest-competing-ask" }, { "source": "last-sold" }])
            }
        };
        let percent = if matches!(preset, Preset::Beat | Preset::Slow) { -self.knob } else { self.knob };
        let floor = match &self.floor {
            Floor::Absolute { amount } => json!({ "mode": "absolute", "amount": amount }),
            Floor::CostPlus { margin, fallback } => {
                json!({ "mode": "cost-basis-plus-margin", "marginPercent": number(*margin), "absoluteFallbackAmount": fallback })
            }
        };
        let tolerance = match preset {
            Preset::Beat => 1,
            Preset::Premium => 3,
            Preset::Track | Preset::Slow => 2,
        };
        let max_move = match preset {
            Preset::Premium => 15,
            Preset::Slow => 25,
            Preset::Track | Preset::Beat => 20,
        };
        let directive = json!({
            "currencyCode": self.currency,
            "anchorChain": anchors,
            "offset": { "mode": "percent", "percent": percent },
            "floor": floor,
            "ceiling": null,
            "tolerance": { "mode": "percent", "percent": tolerance },
            "rounding": { "mode": "none" },
            "maxMovePercent": max_move,
            "terminal": { "kind": "hold" },
        });
        let rules = if preset == Preset::Slow {
            let mut rest = directive.clone();
            rest["offset"] = json!({ "mode": "percent", "percent": 0 });
            rest["tolerance"] = json!({ "mode": "percent", "percent": 5 });
            rest["maxMovePercent"] = json!(10);
            json!([
                { "conditions": [{ "type": "listing-age-at-least", "days": self.age }], "directive": directive },
                { "conditions": [], "directive": rest },
            ])
        } else {
            json!([{ "conditions": [], "directive": directive }])
        };
        json!({
            "name": self.name,
            "scope": serde_json::to_value(&self.scope).unwrap_or(Value::Null),
            "excludedListingIds": [],
            "maxChangesPerDay": 250,
            "rules": rules,
        })
    }

    /// Whether `run` previewed this policy: Pricing keeps the body without its name.
    pub fn previewed_by(&self, run: &RepricingDryRun) -> bool {
        let unnamed = |mut body: Value| {
            if let Some(body) = body.as_object_mut() {
                body.remove("name");
            }
            body
        };
        unnamed(self.compile()) == unnamed(run.body.clone())
    }

    /// The editor's address with this policy, and the dry run that previews it.
    pub fn place(&self, dry_run: Option<&str>) -> Place {
        let (floor, amount, margin, fallback) = match &self.floor {
            Floor::Absolute { amount } => ("absolute", Some(amount.clone()), None, None),
            Floor::CostPlus { margin, fallback } => {
                ("cost-basis-plus-margin", None, Some(number(*margin).to_string()), Some(fallback.clone()))
            }
        };
        let (scope, categories, listings) = match &self.scope {
            RepricingScope::AllListings => ("all-listings", Vec::new(), None),
            RepricingScope::CatalogFilter { category_ids } => ("catalog-filter", category_ids.clone(), None),
            RepricingScope::ListingSet { listing_ids } => ("listing-set", Vec::new(), Some(listing_ids.join(","))),
        };
        Place {
            create: Some("1".into()),
            name: Some(self.name.clone()),
            preset: Some(self.preset.key().into()),
            from: Some(self.preset.key().into()),
            knob: Some(self.knob.to_string()),
            age: (self.preset == Preset::Slow).then(|| self.age.to_string()),
            currency: Some(self.currency.clone()),
            floor: Some(floor.into()),
            amount,
            margin,
            fallback,
            scope: Some(scope.into()),
            categories,
            listings,
            dry_run: dry_run.map(str::to_owned),
            ..Place::default()
        }
    }
}

/// Each value once, trimmed, in order; empty ones left out.
fn distinct(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
        if !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// The page's address: the editor (open, its controls and the dry run that previews them), the
/// receipt of the write the list waits for, and where the dry run's samples start.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub create: Option<String>,
    pub after_write: Option<String>,
    pub name: Option<String>,
    pub preset: Option<String>,
    /// The preset the form was drawn with: a different one is a new choice.
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
    pub dry_run: Option<String>,
    /// The dry run's samples after this listing (Next 100 results).
    pub after: Option<String>,
}

/// The editor's controls, from the address or a post.
#[derive(Clone, Debug, Default)]
pub struct EditorInput {
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
    pub categories: Vec<String>,
    pub listings: Option<String>,
}

impl Place {
    pub fn editing(&self) -> bool {
        self.create.as_deref() == Some("1")
    }

    pub fn input(&self) -> EditorInput {
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

    /// The list, read after `receipt`'s write.
    pub fn list(receipt: Option<&Receipt>) -> Place {
        Place { after_write: receipt.map(Receipt::param), ..Place::default() }
    }

    /// The editor, empty.
    pub fn create() -> Place {
        Place { create: Some("1".into()), ..Place::default() }
    }
}

/// A write: Pause, Resume, the halt, Preview and Activate. The editor's posts carry its controls,
/// named as the address names them.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct WriteForm {
    pub intent: String,
    pub policy_id: String,
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
    pub categories: Vec<String>,
    pub listings: Option<String>,
    pub dry_run: Option<String>,
}

impl WriteForm {
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
}

/// The policies, or why the page cannot show them.
pub enum Policies {
    Read(Vec<RepricingPolicyRow>),
    /// A write's receipt the read has not reached yet: the change is saved.
    CatchingUp,
    Failed,
}

/// A dry run's samples (`listRepricingDryRunTraces`).
pub enum Traces {
    NotYet,
    Read(Vec<RepricingTrace>),
    Failed,
}

/// A dry run as the editor shows it.
pub struct DryRunView {
    pub run: RepricingDryRun,
    pub traces: Traces,
    /// The run previewed the editor's policy as it is now.
    pub current: bool,
    /// The editor's address with this run: Next 100 results, and the read again without a script.
    pub place: Place,
}

impl DryRunView {
    /// Activate is possible: a completed run, not used yet, of this policy (`canActivate`).
    pub fn activates(&self) -> bool {
        self.run.status == "completed" && self.run.consumed_at.is_none() && self.current
    }
}

/// The editor with what it read.
pub struct EditorScreen {
    pub editor: Editor,
    pub facts: RepricingPrerequisites,
    pub categories: Vec<RepricingCategory>,
    /// What the scope matches; none when Pricing could not say.
    pub preview: Option<RepricingScopePreview>,
    pub run: Option<DryRunView>,
    /// What Pricing refused the last post for.
    pub errors: Vec<String>,
}

/// The editor, or that it could not read what it starts from (`authoring-prerequisites`,
/// `categories`).
pub enum EditorPart {
    Ready(Box<EditorScreen>),
    Unavailable,
}

/// What the page shows.
pub struct RepricingScreen {
    pub policies: Policies,
    pub halt: RepricingHalt,
    /// The halt could not be read: its switch is off and the list says it could not load.
    pub halt_failed: bool,
    pub dry_runs: Vec<RepricingDryRun>,
    pub editor: Option<EditorPart>,
    /// What a list write was refused for: the message and Pricing's details.
    pub refusal: Option<(String, Vec<String>)>,
    /// The reader may change policies and the halt (`pricing.manage`).
    pub manage: bool,
}

/// What a post's refusal puts on the page.
enum Refused {
    None,
    List(String, Vec<String>),
    Editor(Vec<String>),
}

/// The session ended: the seller signs in again.
fn ended(error: &ApiError) -> bool {
    error.status() == Some(StatusCode::UNAUTHORIZED)
}

/// What Pricing refused a write for, to draw where it was posted: its validation details, else
/// its message, else `fallback`. A refusal of the page itself is the answer instead: signed out
/// goes to sign in, and Pricing failing is a 502.
pub(crate) fn messages(req: &Req, refusal: PricingRefusal, fallback: &str) -> Result<Vec<String>, Box<HtmlResult>> {
    match refusal.error.status() {
        Some(StatusCode::UNAUTHORIZED) => Err(Box::new(sign_in(req))),
        Some(status) if status.is_client_error() => Ok(if refusal.details.is_empty() {
            vec![refusal.error.refusal().map_or_else(|| fallback.to_owned(), str::to_owned)]
        } else {
            refusal.details
        }),
        _ => Err(Box::new(Err(corten::Error::new(refusal.error).with_status(StatusCode::BAD_GATEWAY)))),
    }
}

/// The run and, once it completed, its samples from `after`.
async fn dry_run(
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: Option<&str>,
) -> Result<(RepricingDryRun, Traces), ApiError> {
    let caller = config.platform.caller(headers, config.proto, None);
    let run = caller.repricing_dry_run(id).await?;
    let traces = if run.status == "completed" {
        match caller.repricing_dry_run_traces(id, after).await {
            Ok(traces) => Traces::Read(traces),
            Err(error) => {
                tracing::warn!("a dry run's samples could not be read: {error}");
                Traces::Failed
            }
        }
    } else {
        Traces::NotYet
    };
    Ok((run, traces))
}

/// The editor for `input` (the address's, or a refused post's), at `place`'s dry run and samples.
async fn editor(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    input: &EditorInput,
    errors: Vec<String>,
) -> Result<EditorPart, ApiError> {
    let caller = config.platform.caller(headers, config.proto, None);
    let (facts, categories) = tokio::join!(caller.repricing_prerequisites(), caller.repricing_categories());
    let (facts, categories) = match (facts, categories) {
        (Ok(facts), Ok(categories)) => (facts, categories),
        (Err(error), _) | (_, Err(error)) => {
            if ended(&error) {
                return Err(error);
            }
            tracing::warn!("the repricing editor's prerequisites could not be read: {error}");
            return Ok(EditorPart::Unavailable);
        }
    };
    let editor = Editor::read(input, &facts, req.t());
    let scope = json!({ "scope": editor.scope, "excludedListingIds": [] });
    let run = async {
        match place.dry_run.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => Some(dry_run(config, headers, id, place.after.as_deref()).await),
            None => None,
        }
    };
    let (preview, run) = tokio::join!(caller.repricing_scope_preview(&scope), run);
    let preview = match preview {
        Ok(preview) => Some(preview),
        Err(error) => {
            tracing::warn!("the scope preview failed: {error}");
            None
        }
    };
    let run = match run {
        Some(Ok((run, traces))) => {
            let current = editor.previewed_by(&run);
            let mut at = editor.place(Some(&run.dry_run_id));
            at.after = place.after.clone();
            Some(DryRunView { run, traces, current, place: at })
        }
        Some(Err(error)) if ended(&error) => return Err(error),
        Some(Err(error)) => {
            tracing::warn!("the editor's dry run could not be read: {error}");
            None
        }
        None => None,
    };
    Ok(EditorPart::Ready(Box::new(EditorScreen { editor, facts, categories, preview, run, errors })))
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    input: Option<EditorInput>,
    refused: Refused,
    status: StatusCode,
) -> HtmlResult {
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let waiting = config.platform.caller(headers, config.proto, receipt.as_ref());
    let caller = config.platform.caller(headers, config.proto, None);
    let (policies, halt, dry_runs) =
        tokio::join!(waiting.repricing_policies(), caller.repricing_halt(), caller.repricing_dry_runs(20));
    if [policies.as_ref().err(), halt.as_ref().err(), dry_runs.as_ref().err()].into_iter().flatten().any(ended) {
        return sign_in(req);
    }
    let policies = match policies {
        Ok(policies) => Policies::Read(policies),
        Err(error) if receipt.is_some() && error.catching_up() => Policies::CatchingUp,
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => {
            return Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN));
        }
        Err(error) => {
            tracing::warn!("the repricing policies could not be read: {error}");
            Policies::Failed
        }
    };
    if let Err(error) = &halt {
        tracing::warn!("the repricing halt could not be read: {error}");
    }
    let halt_failed = halt.is_err();
    let halt = halt.unwrap_or_default();
    let dry_runs = dry_runs.unwrap_or_default();
    let (refusal, errors) = match refused {
        Refused::None => (None, Vec::new()),
        Refused::List(message, details) => (Some((message, details)), Vec::new()),
        Refused::Editor(errors) => (None, errors),
    };
    let editor = if place.editing() {
        let input = input.unwrap_or_else(|| place.input());
        match editor(req, config, headers, place, &input, errors).await {
            Ok(part) => Some(part),
            Err(_) => return sign_in(req),
        }
    } else {
        None
    };
    let catching_up = matches!(policies, Policies::CatchingUp);
    let manage = viewer.actor.can(PRICING_MANAGE);
    let screen = RepricingScreen { policies, halt, halt_failed, dry_runs, editor, refusal, manage };
    let t: RepricingMsg = req.t();
    let head = html! {
        <meta name="description" content={t.route_meta_description()}>
        <meta name="robots" content="noindex">
        {catching_up.then_some(ReadAgain { after: Duration::from_secs(2) })}
    };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_meta_title()} head={head}>
            <views::RepricingPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn page(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::repricing::Repricing>,
) -> HtmlResult {
    let place = route.place;
    render(&req, &viewer, &config, &headers, &place, None, Refused::None, StatusCode::OK).await
}

/// The list again with what a write was refused for (422).
async fn list_refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    message: &str,
    details: Vec<String>,
) -> HtmlResult {
    let refused = Refused::List(message.to_owned(), details);
    render(req, viewer, config, headers, &Place::default(), None, refused, StatusCode::UNPROCESSABLE_ENTITY).await
}

/// The editor again at `place` with what its post was refused for (422).
async fn editor_refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: Place,
    errors: Vec<String>,
) -> HtmlResult {
    let input = place.input();
    render(req, viewer, config, headers, &place, Some(input), Refused::Editor(errors), StatusCode::UNPROCESSABLE_ENTITY).await
}

/// Pause, Resume, the halt, Preview and Activate (marketplace's action's intents). Each list write
/// goes back to the list, a policy's with its receipt; Preview goes to the editor with its run and
/// Activate to the list with the new policy's receipt. A refusal is drawn where it was posted.
pub(crate) async fn write(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(form): Form<WriteForm>,
) -> HtmlResult {
    let (t, p): (RepricingMsg, Pilot) = (req.t(), req.t());
    let caller = config.platform.caller(&headers, config.proto, None);
    let title = t.shared_action_error_title();
    match form.intent.as_str() {
        intent @ ("pause-policy" | "resume-policy") => {
            let change = if intent == "pause-policy" { "pause" } else { "resume" };
            match caller.repricing_lifecycle(form.policy_id.trim(), change).await {
                Ok(receipt) => req.redirect(&url::Repricing { place: Place::list(receipt.as_ref()) }),
                Err(refusal) => match messages(&req, refusal, t.route_action_failed()) {
                    Ok(details) => list_refused(&req, &viewer, &config, &headers, title, details).await,
                    Err(answer) => *answer,
                },
            }
        }
        intent @ ("engage-halt" | "release-halt") => match caller.set_repricing_halt(intent == "engage-halt").await {
            // The halt is its own aggregate, read without a receipt (as marketplace's redirect).
            Ok(_) => req.redirect(&url::Repricing { place: Place::default() }),
            Err(refusal) => match messages(&req, refusal, t.route_action_failed()) {
                Ok(details) => list_refused(&req, &viewer, &config, &headers, title, details).await,
                Err(answer) => *answer,
            },
        },
        intent @ ("preview" | "create-policy") => {
            let facts = match caller.repricing_prerequisites().await {
                Ok(facts) => facts,
                Err(error) if ended(&error) => return sign_in(&req),
                Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            };
            let editor = Editor::read(&form.input(), &facts, t);
            let run_id = form.dry_run.as_deref().map(str::trim).filter(|id| !id.is_empty());
            if intent == "preview" {
                if !editor.complete() {
                    let errors = vec![t.editor_validation_failed().to_owned()];
                    return editor_refused(&req, &viewer, &config, &headers, editor.place(None), errors).await;
                }
                return match caller.start_repricing_dry_run(&editor.compile()).await {
                    Ok(run) => req.redirect(&url::Repricing { place: editor.place(Some(&run.dry_run_id)) }),
                    Err(refusal) => match messages(&req, refusal, t.editor_validation_failed()) {
                        Ok(errors) => editor_refused(&req, &viewer, &config, &headers, editor.place(None), errors).await,
                        Err(answer) => *answer,
                    },
                };
            }
            let Some(run_id) = run_id else {
                let errors = vec![p.repricing_preview_first().to_owned()];
                return editor_refused(&req, &viewer, &config, &headers, editor.place(None), errors).await;
            };
            let run = match caller.repricing_dry_run(run_id).await {
                Ok(run) => run,
                Err(error) if ended(&error) => return sign_in(&req),
                Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            };
            // Only the completed, unused run of the policy as the form has it now (`canActivate`).
            let refusal = if !editor.previewed_by(&run) {
                Some(p.repricing_changed())
            } else if run.status != "completed" || run.consumed_at.is_some() {
                Some(p.repricing_preview_first())
            } else {
                None
            };
            if let Some(refusal) = refusal {
                let errors = vec![refusal.to_owned()];
                return editor_refused(&req, &viewer, &config, &headers, editor.place(Some(run_id)), errors).await;
            }
            match caller.create_repricing_policy(run_id, &editor.name).await {
                Ok(receipt) => req.redirect(&url::Repricing { place: Place::list(receipt.as_ref()) }),
                Err(refusal) => match messages(&req, refusal, t.route_action_failed()) {
                    Ok(errors) => editor_refused(&req, &viewer, &config, &headers, editor.place(Some(run_id)), errors).await,
                    Err(answer) => *answer,
                },
            }
        }
        _ => list_refused(&req, &viewer, &config, &headers, t.route_unknown_action(), Vec::new()).await,
    }
}

/// The dry run's result, drawn again on each status its stream sends (marketplace's
/// `subscribeDurableJobStatus` on `/dry-runs/{id}/events`, which reads the run on each event): the
/// pilot relays Pricing's stream, reads the run and, once it completed, its first samples, and
/// ends with the run.
pub(crate) async fn live(
    req: Req,
    Caller(PricingManager(_)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::repricing::RepricingDryRunLive<'_>>,
) -> LiveResponse {
    let (id, place) = (route.id, route.place);
    let (t, p): (RepricingMsg, Pilot) = (req.t(), req.t());
    let open = config
        .platform
        .caller(&headers, config.proto, None)
        .request(reqwest::Method::GET, &repricing_dry_run_events(&id), PRICING_CONTEXT)
        .header(reqwest::header::ACCEPT, "text/event-stream");
    let statuses = futures_util::stream::once(async move { open.send().await })
        .filter_map(|res| {
            std::future::ready(match res {
                Ok(res) if res.status().is_success() => Some(res),
                Ok(res) => {
                    tracing::warn!("a dry run's status stream answered {}", res.status());
                    None
                }
                Err(error) => {
                    tracing::warn!("a dry run's status stream is unreachable: {error}");
                    None
                }
            })
        })
        .flat_map(|res| platform::realtime::events(res.bytes_stream().map(|chunk| chunk.map_err(|_| ()))))
        .filter_map(|event| std::future::ready(event.ok().filter(|event| event.event == "status")));
    let fragments = statuses
        .then(move |_| {
            let (config, headers, id, place) = (config.clone(), headers.clone(), id.clone(), place.clone());
            async move {
                let caller = config.platform.caller(&headers, config.proto, None);
                let (read, facts) = tokio::join!(dry_run(&config, &headers, &id, None), caller.repricing_prerequisites());
                let ((run, traces), facts) = match (read, facts) {
                    (Ok(read), Ok(facts)) => (read, facts),
                    (Err(error), _) | (_, Err(error)) => {
                        tracing::warn!("a dry run's read for its status failed: {error}");
                        return None;
                    }
                };
                let editor = Editor::read(&place.input(), &facts, t);
                let finished = run.finished();
                let current = editor.previewed_by(&run);
                let view = DryRunView { place: editor.place(Some(&run.dry_run_id)), run, traces, current };
                let html = views::repricing_dry_run_part(t, p, &view).to_html();
                Some((corten::Fragment::new(html), finished))
            }
        })
        .filter_map(std::future::ready)
        .scan(false, |done, (fragment, finished)| {
            let next = (!*done).then_some(fragment);
            *done = *done || finished;
            std::future::ready(next)
        });
    corten::live(fragments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(codes: &[&str], cost: bool) -> RepricingPrerequisites {
        RepricingPrerequisites { listing_currency_codes: codes.iter().map(|c| (*c).to_owned()).collect(), has_cost_basis: cost }
    }

    fn input(pairs: &[(&str, &str)]) -> EditorInput {
        let mut input = EditorInput::default();
        for (name, value) in pairs {
            let value = Some((*value).to_owned());
            match *name {
                "name" => input.name = value,
                "preset" => input.preset = value,
                "from" => input.from = value,
                "knob" => input.knob = value,
                "age" => input.age = value,
                "currency" => input.currency = value,
                "floor" => input.floor = value,
                "amount" => input.amount = value,
                "margin" => input.margin = value,
                "fallback" => input.fallback = value,
                "scope" => input.scope = value,
                "listings" => input.listings = value,
                "category" => input.categories.extend(value),
                other => panic!("no control {other}"),
            }
        }
        input
    }

    fn en() -> RepricingMsg {
        RepricingMsg::from_index(0)
    }

    /// chase-sets/chase-sets#7905's complete compiled example: preset 2 (Beat the lowest listing),
    /// knob 2, USD, a cost basis, fallback 4.00, from a fresh editor.
    #[test]
    fn a_preset_compiles_to_the_decisions_example() {
        let fresh = input(&[("preset", "beat-lowest"), ("from", "track-market"), ("fallback", "4.00")]);
        let editor = Editor::read(&fresh, &facts(&["USD"], true), en());
        assert_eq!(
            editor.compile(),
            json!({ "name": "Beat the lowest listing", "scope": { "kind": "all-listings" }, "excludedListingIds": [], "maxChangesPerDay": 250,
              "rules": [ { "conditions": [], "directive": {
                "currencyCode": "USD",
                "anchorChain": [ { "source": "lowest-competing-ask" }, { "source": "market-estimate" } ],
                "offset": { "mode": "percent", "percent": -2 },
                "floor": { "mode": "cost-basis-plus-margin", "marginPercent": 10, "absoluteFallbackAmount": "4.00" },
                "ceiling": null, "tolerance": { "mode": "percent", "percent": 1 }, "rounding": { "mode": "none" },
                "maxMovePercent": 20, "terminal": { "kind": "hold" } } } ] })
        );
    }

    /// The other presets as `compileRepricingPreset` writes them: slow stock's aged rule before its
    /// default, premium's 75th percentile, and track's chain; no `-0` for a zero undercut.
    #[test]
    fn each_preset_compiles_as_marketplaces_compiler_does() {
        let slow = Editor::read(
            &input(&[
                ("name", "Slow"),
                ("preset", "slow-stock"),
                ("knob", "12"),
                ("age", "60"),
                ("currency", "USD"),
                ("floor", "absolute"),
                ("amount", "1.00"),
                ("scope", "catalog-filter"),
                ("category", "cat-1"),
            ]),
            &facts(&["USD"], true),
            en(),
        );
        let directive = json!({
            "currencyCode": "USD",
            "anchorChain": [{ "source": "market-estimate" }, { "source": "lowest-competing-ask" }, { "source": "last-sold" }],
            "offset": { "mode": "percent", "percent": -12 },
            "floor": { "mode": "absolute", "amount": "1.00" },
            "ceiling": null,
            "tolerance": { "mode": "percent", "percent": 2 },
            "rounding": { "mode": "none" },
            "maxMovePercent": 25,
            "terminal": { "kind": "hold" },
        });
        let mut rest = directive.clone();
        rest["offset"]["percent"] = json!(0);
        rest["tolerance"]["percent"] = json!(5);
        rest["maxMovePercent"] = json!(10);
        assert_eq!(
            slow.compile(),
            json!({
                "name": "Slow",
                "scope": { "kind": "catalog-filter", "categoryIds": ["cat-1"] },
                "excludedListingIds": [],
                "maxChangesPerDay": 250,
                "rules": [
                    { "conditions": [{ "type": "listing-age-at-least", "days": 60 }], "directive": directive },
                    { "conditions": [], "directive": rest },
                ],
            })
        );
        let beat =
            Editor::read(&input(&[("preset", "beat-lowest"), ("knob", "0"), ("amount", "1")]), &facts(&["USD"], false), en());
        assert_eq!(beat.compile()["rules"][0]["directive"]["offset"]["percent"], json!(0));
        let premium = Editor::read(&input(&[("preset", "premium"), ("amount", "1")]), &facts(&["USD"], false), en());
        let rule = &premium.compile()["rules"][0]["directive"];
        assert_eq!(rule["anchorChain"][0], json!({ "source": "comp-percentile", "percentile": 75 }));
        assert_eq!(
            (&rule["offset"]["percent"], &rule["tolerance"]["percent"], &rule["maxMovePercent"]),
            (&json!(5), &json!(3), &json!(15))
        );
        let track = Editor::read(&input(&[("knob", "-7"), ("amount", "1")]), &facts(&["USD"], false), en());
        assert_eq!(track.compile()["rules"][0]["directive"]["offset"]["percent"], json!(-7));
    }

    #[test]
    fn the_editor_starts_from_what_the_account_has_and_a_new_preset_from_its_defaults() {
        let fresh = Editor::read(&EditorInput::default(), &facts(&["USD"], true), en());
        assert_eq!((fresh.preset, fresh.name.as_str(), fresh.currency.as_str()), (Preset::Track, "Track the market", "USD"));
        assert_eq!(fresh.floor, Floor::CostPlus { margin: 10.0, fallback: String::new() });
        assert!(!fresh.complete(), "a floor's amount is still missing");
        let two = Editor::read(&EditorInput::default(), &facts(&["USD", "CAD"], false), en());
        assert_eq!((two.currency.as_str(), &two.floor), ("", &Floor::Absolute { amount: String::new() }));

        let chosen = Editor::read(
            &input(&[("name", "Mine"), ("preset", "premium"), ("from", "track-market"), ("knob", "-20")]),
            &facts(&[], false),
            en(),
        );
        assert_eq!((chosen.name.as_str(), chosen.knob), ("Price at a premium", 5), "a new preset's name and knob");
        let kept =
            Editor::read(&input(&[("name", "Mine"), ("preset", "premium"), ("from", "premium")]), &facts(&[], false), en());
        assert_eq!(kept.name, "Mine");
        let held = Editor::read(
            &input(&[("preset", "beat-lowest"), ("from", "beat-lowest"), ("knob", "40"), ("age", "3")]),
            &facts(&[], false),
            en(),
        );
        assert_eq!((held.knob, held.age), (15, 14), "held to the range");
        let scoped = Editor::read(&input(&[("scope", "listing-set"), ("listings", " a, b,,a ")]), &facts(&[], false), en());
        assert_eq!(scoped.scope, RepricingScope::ListingSet { listing_ids: vec!["a".into(), "b".into()] });
    }

    #[test]
    fn a_run_previews_the_editor_only_while_its_body_is_the_editors() {
        let editor = Editor::read(
            &input(&[
                ("knob", "3"),
                ("currency", "USD"),
                ("floor", "cost-basis-plus-margin"),
                ("margin", "12.5"),
                ("fallback", "1"),
            ]),
            &facts(&["USD"], false),
            en(),
        );
        let mut body = editor.compile();
        body.as_object_mut().map(|body| body.remove("name"));
        let run = |body: Value| RepricingDryRun {
            dry_run_id: "repricing-dry-run:1".into(),
            body,
            status: "completed".into(),
            requested_at: "2026-10-27 22:01:22.251019+00".into(),
            completed_at: None,
            consumed_at: None,
            summary: None,
            updated_at: "2026-10-27 22:01:22.251019+00".into(),
        };
        assert!(editor.previewed_by(&run(body.clone())), "Pricing keeps the body without its name");
        let mut other = body;
        other["rules"][0]["directive"]["offset"]["percent"] = json!(4);
        assert!(!editor.previewed_by(&run(other)));
        let place = editor.place(Some("repricing-dry-run:1"));
        assert_eq!(Editor::read(&place.input(), &facts(&["USD"], false), en()), editor, "the address holds the policy it draws");
    }

    #[test]
    fn a_post_names_the_editors_controls_as_the_address_does() {
        let (place, form) = (Place::FIELDS, WriteForm::FIELDS);
        assert_eq!(
            [place.name, place.preset, place.from, place.knob, place.age, place.currency, place.floor, place.amount],
            [form.name, form.preset, form.from, form.knob, form.age, form.currency, form.floor, form.amount]
        );
        assert_eq!(
            [place.margin, place.fallback, place.scope, place.categories, place.listings, place.dry_run],
            [form.margin, form.fallback, form.scope, form.categories, form.listings, form.dry_run]
        );
    }
}
