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
//! preview Pricing answers for it. The presets, their knobs' ranges and the currency and floor a
//! policy starts from are Pricing's (`authoring-prerequisites`). Preview posts the form; Pricing
//! compiles the preset's controls into the dry run's body (`presets/compile`), and the pilot starts
//! the dry run and goes to the editor's address with the run. While the run is not finished the page relays its status stream
//! (`<corten-live>` on `live`), which draws the result when it completes; without a script the
//! result part has a link to read the page again. Activate posts the form with the run: the pilot
//! activates only a completed, unused run whose body is the form's policy (marketplace's
//! `canActivate`), so a setting changed after the preview asks for a new preview. With a script
//! the form applies a choice as it changes (search's pattern); a text field waits for Apply or
//! Enter.
//!
//! Open up this preset (once the preset has what a preview needs) posts the form, and the page
//! answers with the editor a policy's page revises with (`repricing_policy`'s, without a policy):
//! the structured controls for a one-rule preset, else the advanced ones. From then the editor is
//! one posted form carrying the body it drew, as a revise's is; its Preview starts the dry run of the
//! body, and Activate creates the policy from a completed, unused run whose body is the editor's
//! now, then goes to the list with its receipt.
//!
//! A policy's own page and its activity are `repricing_policy`, which a policy's name opens; its
//! Edit revises the policy with the structured and advanced editors too (`repricing_body`).
//!
//! Each write is a configuration request (chase-sets/chase-sets#11459's receipts): Pricing installs
//! it, or records it as pending, or answers that a later request replaced it. An installed write
//! goes on as before; one that is not is drawn where it was posted with marketplace's message
//! (`repricingConfigurationMessage`), and an editor stays open. The list also says what each request
//! Pricing has not installed is (`configuration-requests`; if that read fails, the list says it
//! could not load and the halt's switch is off, as marketplace's `haltFailed`). Every posted form
//! sends its `SubmitKey` as the request's `Idempotency-Key`, and an editor drawn again after a
//! request that is not installed holds the key it sent, so sending it again is the same request. The
//! create editor's controls are a GET form, which cannot carry a key without putting it in the
//! address, so its Activate sends none and Pricing makes one up: a second Activate is a new request
//! that replaces the first.
use std::time::Duration;

use corten::{
    LiveResponse, SubmitKey,
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use futures_util::StreamExt;
use platform::{post_write::Surface, receipt::Receipt};
use serde_json::{Value, json};

use crate::{
    api::{
        ApiError, ConfigurationReceipt, Configured, PRICING_CONTEXT, PresetControls, PricingRefusal, RepricingCalls as _,
        RepricingCategory, RepricingDryRun, RepricingHalt, RepricingPolicyRow, RepricingPrerequisites, RepricingScope,
        RepricingScopePreview, RepricingTrace, repricing_dry_run_events,
    },
    app::{PRICING_MANAGE, Shared, sign_in, url},
    auth::{PricingManager, Viewer},
    repricing_body::{Op, Source, body_key, distinct, number, recognize},
    repricing_policy::{Revise, ReviseEditor, ReviseScreen},
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

    /// The presets Pricing offers that the pilot has words for, in Pricing's order.
    pub fn offered(facts: &RepricingPrerequisites) -> impl Iterator<Item = Preset> + '_ {
        facts.presets.iter().filter_map(|controls| Preset::read(&controls.preset))
    }

    /// The preset's controls as Pricing offers them; one it does not offer has none to draw.
    pub fn controls(self, facts: &RepricingPrerequisites) -> PresetControls {
        facts.preset(self.key()).cloned().unwrap_or_default()
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
    /// The listing age the preset reads, when it reads one (slow stock).
    pub age: Option<i64>,
    pub currency: String,
    pub floor: Floor,
    pub scope: RepricingScope,
}

impl Editor {
    /// The editor's controls read with what Pricing offers and the account starts from (`presets`,
    /// `editorDefaults`): a preset chosen anew starts from its own name, knob and age, as
    /// marketplace's Strategy select does; a value out of range is held to it.
    pub fn read(input: &EditorInput, facts: &RepricingPrerequisites, t: RepricingMsg) -> Editor {
        let text = |value: &Option<String>| value.as_deref().map(str::trim).unwrap_or_default().to_owned();
        let whole = |value: &Option<String>| {
            value.as_deref().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite()).map(|v| v.round() as i64)
        };
        let first = Preset::offered(facts).next().unwrap_or(Preset::Track);
        let preset = input.preset.as_deref().and_then(Preset::read).filter(|p| facts.preset(p.key()).is_some()).unwrap_or(first);
        let changed = input.from.as_deref().and_then(Preset::read).is_some_and(|from| from != preset);
        let controls = preset.controls(facts);
        let held = |range: crate::api::PresetRange, value: &Option<String>| {
            if changed { range.default_value } else { whole(value).map_or(range.default_value, |v| range.hold(v)) }
        };
        let name = if changed || input.name.is_none() { preset.title(t).to_owned() } else { text(&input.name) };
        let knob = held(controls.knob, &input.knob);
        let age = controls.age_days.map(|range| held(range, &input.age));
        let defaults = &facts.editor_defaults;
        let currency = match input.currency.as_deref().map(str::trim) {
            Some(code) => code.to_owned(),
            None => defaults.currency_code.clone().unwrap_or_default(),
        };
        let cost = match input.floor.as_deref() {
            Some("cost-basis-plus-margin") => true,
            Some("absolute") => false,
            _ => defaults.floor.mode == "cost-basis-plus-margin",
        };
        let floor = if cost {
            let margin = input.margin.as_deref().and_then(|m| m.trim().parse::<f64>().ok()).filter(|m| m.is_finite());
            // A floor switched to cost starts from 10%, as marketplace's floor fields do.
            let margin = margin.or(defaults.floor.margin_percent).unwrap_or(10.0);
            Floor::CostPlus { margin, fallback: text(&input.fallback) }
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

    /// The floor as the body says it (`RepricingFloor`).
    fn floor_json(&self) -> Value {
        match &self.floor {
            Floor::Absolute { amount } => json!({ "mode": "absolute", "amount": amount }),
            Floor::CostPlus { margin, fallback } => {
                json!({ "mode": "cost-basis-plus-margin", "marginPercent": number(*margin), "absoluteFallbackAmount": fallback })
            }
        }
    }

    /// The controls Pricing compiles into the dry run's body (`presets/compile`): the body, with
    /// the name and the authoring intent that opens it in these controls again, is Pricing's.
    pub fn request(&self) -> Value {
        let mut request = json!({
            "preset": self.preset.key(),
            "knob": self.knob,
            "name": self.name,
            "currencyCode": self.currency,
            "floor": self.floor_json(),
            "scope": self.scope,
        });
        if let Some(age) = self.age {
            request["ageDays"] = json!(age);
        }
        request
    }

    /// The preset's controls for a body whose intent is this preset (`recognizeAuthoringIntent`),
    /// as a revise opens them: the policy's name, scope, currency and floor. `age` is the intent's
    /// when the preset reads one.
    pub fn of_preset(body: &Value, preset: Preset, knob: f64, age: Option<i64>) -> Editor {
        let directive = &body["rules"][0]["directive"];
        let floor = &directive["floor"];
        let floor = match floor["mode"].as_str() {
            Some("cost-basis-plus-margin") => Floor::CostPlus {
                margin: floor["marginPercent"].as_f64().unwrap_or(10.0),
                fallback: floor["absoluteFallbackAmount"].as_str().unwrap_or_default().to_owned(),
            },
            _ => Floor::Absolute { amount: floor["amount"].as_str().unwrap_or_default().to_owned() },
        };
        Editor {
            name: body["name"].as_str().unwrap_or_default().to_owned(),
            preset,
            knob: knob.round() as i64,
            age,
            currency: directive["currencyCode"].as_str().unwrap_or_default().to_owned(),
            floor,
            scope: serde_json::from_value(body["scope"].clone()).unwrap_or(RepricingScope::AllListings),
        }
    }

    /// Whether `run` previewed this policy: its body is the one Pricing compiled from these
    /// controls, so its intent is this preset, knob and age, and its currency, floor and scope are
    /// these. (A name is not part of a run.)
    pub fn previewed_by(&self, run: &RepricingDryRun) -> bool {
        let body = &run.body;
        let Some(Source::Preset { preset, knob, age }) = recognize(body) else {
            return false;
        };
        let directive = &body["rules"][0]["directive"];
        let excluded = body.get("excludedListingIds").and_then(Value::as_array).is_none_or(Vec::is_empty);
        preset == self.preset
            && knob == self.knob as f64
            && self.age.is_none_or(|own| own == age)
            && directive["currencyCode"].as_str() == Some(self.currency.as_str())
            && directive["floor"] == self.floor_json()
            && serde_json::to_value(&self.scope).is_ok_and(|scope| scope == body["scope"])
            && excluded
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
            age: self.age.map(|age| age.to_string()),
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

/// The page's address: the editor (open, its controls and the dry run that previews them), the
/// receipt of the write the list waits for, and where the dry run's samples start.
#[derive(Clone, Debug, Default, Fields, Route)]
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
    /// The policy a revise's dry run previews (its live relay's address): its part posts the
    /// policy's editor rather than linking to this page.
    pub revise: Option<String>,
    /// The dry run previews the create editor opened up (its live relay's address): its part posts
    /// that editor, and activates.
    pub opened: Option<String>,
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

/// A write: Pause, Resume, the halt, Preview, Open up this preset and Activate. The address
/// editor's posts carry its controls, named as the address names them; the opened editor's carry
/// its tier and body as a policy's editor does. One form for both pages
/// (`repricing_policy::PolicyForm`).
pub type WriteForm = crate::repricing_policy::PolicyForm;

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

/// The editor a dry run previews.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunEditor {
    /// The create editor's address holds the run: links read its next samples and read it again,
    /// and Activate posts the address's form.
    Address,
    /// The create editor opened up: posting its form reads them, and Activate posts it too.
    Opened,
    /// A policy's revise: posting its form reads them, and it saves without a preview (no
    /// Activate).
    Policy,
}

/// A dry run as the editor shows it.
pub struct DryRunView {
    pub run: RepricingDryRun,
    pub traces: Traces,
    /// The run previewed the editor's policy as it is now.
    pub current: bool,
    /// The editor's address with this run: Next 100 results, and the read again without a script.
    pub place: Place,
    pub editor: RunEditor,
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
    /// Activate's request, when Pricing did not install it.
    pub requested: Option<Unsettled>,
}

/// The editor, or that it could not read what it starts from (`authoring-prerequisites`,
/// `categories`).
pub enum EditorPart {
    Ready(Box<EditorScreen>),
    /// Opened up: the structured or advanced controls over the body it carries.
    Opened(Box<ReviseScreen>),
    Unavailable,
}

/// What the page shows.
pub struct RepricingScreen {
    pub policies: Policies,
    pub halt: RepricingHalt,
    /// The halt, or the requests not installed, could not be read: the halt's switch is off and the
    /// list says it could not load.
    pub halt_failed: bool,
    pub dry_runs: Vec<RepricingDryRun>,
    pub editor: Option<EditorPart>,
    /// What a list write was refused for: the message and Pricing's details.
    pub refusal: Option<(String, Vec<String>)>,
    /// A list write's request Pricing did not install.
    pub requested: Option<ConfigurationReceipt>,
    /// The account's other requests Pricing has not installed.
    pub requests: Vec<ConfigurationReceipt>,
    /// The reader may change policies and the halt (`pricing.manage`).
    pub manage: bool,
}

/// A write Pricing recorded and did not install (pending, or replaced by a later request), and the
/// attempt the form sent it as, which the editor's form holds again.
#[derive(Clone, Debug)]
pub struct Unsettled {
    pub receipt: ConfigurationReceipt,
    pub attempt: Option<SubmitKey>,
}

/// What marketplace says of a configuration request (`repricingConfigurationMessage`).
pub fn configuration_message(t: RepricingMsg, receipt: &ConfigurationReceipt) -> String {
    let revision = receipt.requested_revision().to_string();
    match receipt {
        ConfigurationReceipt::Applied { .. } => t.shared_configuration_applied(&revision).to_string(),
        ConfigurationReceipt::AcceptedPending { .. } => t.shared_configuration_accepted_pending(&revision).to_string(),
        ConfigurationReceipt::SupersededByRevision { replacing_revision, .. } => t
            .shared_configuration_superseded_by_revision(crate::text::repricing_msg::SharedConfigurationSupersededByRevision {
                revision: &revision,
                replacement: &replacing_revision.to_string(),
            })
            .to_string(),
    }
}

/// What a post's refusal, or its request Pricing did not install, puts on the page.
enum Refused {
    None,
    List(String, Vec<String>),
    Editor(Vec<String>),
    /// A list write's request.
    Requested(ConfigurationReceipt),
    /// The create editor's Activate's request: the editor stays open.
    EditorRequested(Unsettled),
}

/// The session ended: the seller signs in again.
pub(crate) fn ended(error: &ApiError) -> bool {
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
pub(crate) async fn dry_run(
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
    requested: Option<Unsettled>,
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
            Some(DryRunView { run, traces, current, place: at, editor: RunEditor::Address })
        }
        Some(Err(error)) if ended(&error) => return Err(error),
        Some(Err(error)) => {
            tracing::warn!("the editor's dry run could not be read: {error}");
            None
        }
        None => None,
    };
    Ok(EditorPart::Ready(Box::new(EditorScreen { editor, facts, categories, preview, run, errors, requested })))
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
    opened: Option<Revise>,
    status: StatusCode,
) -> HtmlResult {
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let waiting = config.platform.caller(headers, config.proto, receipt.as_ref());
    let caller = config.platform.caller(headers, config.proto, None);
    let (policies, halt, dry_runs, requests) = tokio::join!(
        waiting.repricing_policies(),
        caller.repricing_halt(),
        caller.repricing_dry_runs(20),
        caller.repricing_configuration_requests(),
    );
    DESK.read(&policies, receipt.is_some());
    if [policies.as_ref().err(), halt.as_ref().err(), dry_runs.as_ref().err(), requests.as_ref().err()]
        .into_iter()
        .flatten()
        .any(ended)
    {
        return sign_in(req);
    }
    let policies = match policies {
        Ok(policies) => Policies::Read(policies),
        Err(error) if receipt.is_some() && error.catching_up() => Policies::CatchingUp,
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => {
            return Err(crate::app::api_refused(error));
        }
        Err(error) => {
            tracing::warn!("the repricing policies could not be read: {error}");
            Policies::Failed
        }
    };
    if let Err(error) = &halt {
        tracing::warn!("the repricing halt could not be read: {error}");
    }
    if let Err(error) = &requests {
        tracing::warn!("the repricing configuration requests could not be read: {error}");
    }
    let halt_failed = halt.is_err() || requests.is_err();
    let halt = halt.unwrap_or_default();
    let dry_runs = dry_runs.unwrap_or_default();
    let (refusal, errors, requested, editor_requested) = match refused {
        Refused::None => (None, Vec::new(), None, None),
        Refused::List(message, details) => (Some((message, details)), Vec::new(), None, None),
        Refused::Editor(errors) => (None, errors, None, None),
        Refused::Requested(receipt) => (None, Vec::new(), Some(receipt), None),
        Refused::EditorRequested(unsettled) => (None, Vec::new(), None, Some(unsettled)),
    };
    // This post's request is said once, by the post (marketplace's filter on its `requestKey`).
    let posted = requested.as_ref().or(editor_requested.as_ref().map(|unsettled| &unsettled.receipt));
    let requests = requests
        .unwrap_or_default()
        .into_iter()
        .filter(|request| !request.applied() && posted.is_none_or(|posted| posted.request_key() != request.request_key()))
        .collect();
    let editor = if let Some(revise) = opened {
        match opened_part(config, headers, revise).await {
            Ok(part) => Some(part),
            Err(_) => return sign_in(req),
        }
    } else if place.editing() {
        let input = input.unwrap_or_else(|| place.input());
        match editor(req, config, headers, place, &input, errors, editor_requested).await {
            Ok(part) => Some(part),
            Err(_) => return sign_in(req),
        }
    } else {
        None
    };
    let catching_up = matches!(policies, Policies::CatchingUp);
    let manage = viewer.actor.can(PRICING_MANAGE);
    let screen = RepricingScreen { policies, halt, halt_failed, dry_runs, editor, refusal, requested, requests, manage };
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
    render(&req, &viewer, &config, &headers, &place, None, Refused::None, None, StatusCode::OK).await
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
    render(req, viewer, config, headers, &Place::default(), None, refused, None, StatusCode::UNPROCESSABLE_ENTITY).await
}

/// The list again with a write's request Pricing did not install.
async fn list_requested(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    receipt: ConfigurationReceipt,
) -> HtmlResult {
    render(req, viewer, config, headers, &Place::default(), None, Refused::Requested(receipt), None, StatusCode::OK).await
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
    render(req, viewer, config, headers, &place, Some(input), Refused::Editor(errors), None, StatusCode::UNPROCESSABLE_ENTITY)
        .await
}

/// The opened editor's part over `revise`.
async fn opened_part(config: &Shared, headers: &HeaderMap, revise: Revise) -> Result<EditorPart, ApiError> {
    Ok(match crate::repricing_policy::revise_part(config, headers, None, &Value::Null, None, Some(revise)).await? {
        ReviseEditor::Ready(screen) => EditorPart::Opened(screen),
        ReviseEditor::Unavailable => EditorPart::Unavailable,
    })
}

/// The opened editor drawn again over `revise`: its part for the runtime's post (a patch), else
/// the page.
async fn answer_opened(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    revise: Revise,
    status: StatusCode,
) -> HtmlResult {
    let Some(script) = req.action() else {
        return render(req, viewer, config, headers, &Place::create(), None, Refused::None, Some(revise), status).await;
    };
    let part = match opened_part(config, headers, revise).await {
        Ok(part) => part,
        Err(_) => return sign_in(req),
    };
    let (t, p): (RepricingMsg, Pilot) = (req.t(), req.t());
    script.patch_with_status(status, html! { <views::RepricingEditorSection t={t} p={p} part={&part} /> })
}

/// A post of the create editor opened up: its controls over the body it drew, then what it asked.
/// Preview starts the dry run of the policy as it is now; Activate creates the policy from a
/// completed, unused run of that policy (`canActivate`) and goes to the list with its receipt;
/// anything else draws the editor again. A refusal keeps what was posted (422).
async fn opened(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, form: &WriteForm) -> HtmlResult {
    let (t, p): (RepricingMsg, Pilot) = (req.t(), req.t());
    let caller = config.platform.caller(headers, config.proto, None);
    let facts = match caller.repricing_prerequisites().await {
        Ok(facts) => facts,
        Err(error) if ended(&error) => return sign_in(req),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    let Some(mut revise) = Revise::posted(form, &facts, t) else {
        // A post without a body the editor can read starts the editor again.
        return editor_refused(req, viewer, config, headers, Place::create(), vec![t.editor_validation_failed().to_owned()])
            .await;
    };
    let again = |mut revise: Revise, status: StatusCode, errors: Vec<String>| {
        revise.errors = errors;
        answer_opened(req, viewer, config, headers, revise, status)
    };
    if let Err(refusal) = revise.compile(&caller).await {
        return match messages(req, refusal, t.editor_validation_failed()) {
            Ok(errors) => again(revise, StatusCode::UNPROCESSABLE_ENTITY, errors).await,
            Err(answer) => *answer,
        };
    }
    let invalid = || vec![t.editor_validation_failed().to_owned()];
    if matches!(form.intent.as_str(), "open-up" | "open-advanced") && !revise.complete() {
        return again(revise, StatusCode::UNPROCESSABLE_ENTITY, invalid()).await;
    }
    revise.change(&form.intent, form.op.as_deref().and_then(Op::read), &facts);
    match form.intent.as_str() {
        "preview" | "create-policy" if !revise.complete() => again(revise, StatusCode::UNPROCESSABLE_ENTITY, invalid()).await,
        "preview" => match caller.start_repricing_dry_run(&revise.candidate()).await {
            Ok(run) => {
                revise.dry_run = Some(run.dry_run_id);
                revise.after = None;
                again(revise, StatusCode::OK, Vec::new()).await
            }
            Err(refusal) => match messages(req, refusal, t.editor_validation_failed()) {
                Ok(errors) => again(revise, StatusCode::UNPROCESSABLE_ENTITY, errors).await,
                Err(answer) => *answer,
            },
        },
        "create-policy" => {
            let Some(run_id) = revise.dry_run.clone() else {
                return again(revise, StatusCode::UNPROCESSABLE_ENTITY, vec![p.repricing_preview_first().to_owned()]).await;
            };
            let run = match caller.repricing_dry_run(&run_id).await {
                Ok(run) => run,
                Err(error) if ended(&error) => return sign_in(req),
                Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            };
            let candidate = revise.candidate();
            let refusal = if body_key(&candidate) != body_key(&run.body) {
                Some(p.repricing_changed())
            } else if run.status != "completed" || run.consumed_at.is_some() {
                Some(p.repricing_preview_first())
            } else {
                None
            };
            if let Some(refusal) = refusal {
                return again(revise, StatusCode::UNPROCESSABLE_ENTITY, vec![refusal.to_owned()]).await;
            }
            let name = candidate["name"].as_str().unwrap_or_default().trim().to_owned();
            match caller.create_repricing_policy(form.attempt.as_ref().map(SubmitKey::as_str), &run_id, &name).await {
                Ok(Configured { receipt, after }) if receipt.applied() => {
                    DESK.navigated(after.as_ref(), None);
                    req.redirect(&url::Repricing { place: Place::list(after.as_ref()) })
                }
                Ok(Configured { receipt, .. }) => {
                    revise.requested = Some(Unsettled { receipt, attempt: form.attempt.clone() });
                    again(revise, StatusCode::OK, Vec::new()).await
                }
                Err(refusal) => match messages(req, refusal, t.route_action_failed()) {
                    Ok(errors) => again(revise, StatusCode::UNPROCESSABLE_ENTITY, errors).await,
                    Err(answer) => *answer,
                },
            }
        }
        _ => again(revise, StatusCode::OK, Vec::new()).await,
    }
}

/// The desk's post-write reports (Pricing's `REPRICING_DESK_POST_WRITE_TELEMETRY`): a policy's
/// writes report the redirect; the halt's do not, as it is read without a receipt.
const DESK: Surface = Surface {
    context: "pricing",
    surface: "account-desk-repricing",
    route_id: "account-desk-repricing",
    route_template: "/account/desk/repricing",
};

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
    if form.tier.is_some() {
        return opened(&req, &viewer, &config, &headers, &form).await;
    }
    let attempt = form.attempt.as_ref().map(SubmitKey::as_str);
    match form.intent.as_str() {
        intent @ ("pause-policy" | "resume-policy") => {
            let change = if intent == "pause-policy" { "pause" } else { "resume" };
            match caller.repricing_lifecycle(attempt, form.policy_id.trim(), change).await {
                Ok(Configured { receipt, after }) if receipt.applied() => {
                    DESK.navigated(after.as_ref(), None);
                    req.redirect(&url::Repricing { place: Place::list(after.as_ref()) })
                }
                Ok(Configured { receipt, .. }) => list_requested(&req, &viewer, &config, &headers, receipt).await,
                Err(refusal) => match messages(&req, refusal, t.route_action_failed()) {
                    Ok(details) => list_refused(&req, &viewer, &config, &headers, title, details).await,
                    Err(answer) => *answer,
                },
            }
        }
        intent @ ("engage-halt" | "release-halt") => match caller.set_repricing_halt(attempt, intent == "engage-halt").await {
            // The halt is its own aggregate, read without a receipt (as marketplace's redirect).
            Ok(Configured { receipt, .. }) if receipt.applied() => req.redirect(&url::Repricing { place: Place::default() }),
            Ok(Configured { receipt, .. }) => list_requested(&req, &viewer, &config, &headers, receipt).await,
            Err(refusal) => match messages(&req, refusal, t.route_action_failed()) {
                Ok(details) => list_refused(&req, &viewer, &config, &headers, title, details).await,
                Err(answer) => *answer,
            },
        },
        intent @ ("preview" | "create-policy" | "open-up") => {
            let facts = match caller.repricing_prerequisites().await {
                Ok(facts) => facts,
                Err(error) if ended(&error) => return sign_in(&req),
                Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            };
            let editor = Editor::read(&form.input(), &facts, t);
            let run_id = form.dry_run.as_deref().map(str::trim).filter(|id| !id.is_empty());
            if intent != "create-policy" {
                // Only a preset with what a preview needs previews or opens up (`promptComplete`).
                if !editor.complete() {
                    let errors = vec![t.editor_validation_failed().to_owned()];
                    return editor_refused(&req, &viewer, &config, &headers, editor.place(None), errors).await;
                }
                let body = match caller.compile_repricing_preset(&editor.request()).await {
                    Ok(body) => body,
                    Err(refusal) => {
                        return match messages(&req, refusal, t.editor_validation_failed()) {
                            Ok(errors) => editor_refused(&req, &viewer, &config, &headers, editor.place(None), errors).await,
                            Err(answer) => *answer,
                        };
                    }
                };
                if intent == "open-up" {
                    let revise = Revise::opened(editor, body, &facts);
                    return answer_opened(&req, &viewer, &config, &headers, revise, StatusCode::OK).await;
                }
                return match caller.start_repricing_dry_run(&body).await {
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
            // The address editor's form is a GET form and holds no attempt (the module's doc).
            match caller.create_repricing_policy(attempt, run_id, &editor.name).await {
                Ok(Configured { receipt, after }) if receipt.applied() => {
                    DESK.navigated(after.as_ref(), None);
                    req.redirect(&url::Repricing { place: Place::list(after.as_ref()) })
                }
                Ok(Configured { receipt, .. }) => {
                    let place = editor.place(Some(run_id));
                    let input = place.input();
                    let requested = Refused::EditorRequested(Unsettled { receipt, attempt: None });
                    render(&req, &viewer, &config, &headers, &place, Some(input), requested, None, StatusCode::OK).await
                }
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
                let finished = run.finished();
                // A run of a posted editor (a revise's, or the create editor opened up) previews the
                // body that editor posted; the editor says whether it still does when it is drawn
                // again, and Activate checks it.
                let posted = match (&place.revise, &place.opened) {
                    (Some(_), _) => Some(RunEditor::Policy),
                    (None, Some(_)) => Some(RunEditor::Opened),
                    (None, None) => None,
                };
                let view = if let Some(editor) = posted {
                    DryRunView { place: place.clone(), run, traces, current: true, editor }
                } else {
                    let editor = Editor::read(&place.input(), &facts, t);
                    let current = editor.previewed_by(&run);
                    DryRunView { place: editor.place(Some(&run.dry_run_id)), run, traces, current, editor: RunEditor::Address }
                };
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

    /// The presets Pricing offers (`presets`).
    fn catalog() -> Vec<PresetControls> {
        let range = |min, max, default_value| crate::api::PresetRange { min, max, default_value };
        let preset = |key: &str, knob, age_days| PresetControls { preset: key.to_owned(), knob, age_days };
        vec![
            preset("track-market", range(-25, 25, 0), None),
            preset("beat-lowest", range(0, 15, 2), None),
            preset("premium", range(0, 30, 5), None),
            preset("slow-stock", range(0, 30, 10), Some(range(14, 180, 45))),
        ]
    }

    /// What Pricing answers for an account listing in `codes`, with a cost basis or not.
    fn facts(codes: &[&str], cost: bool) -> RepricingPrerequisites {
        RepricingPrerequisites {
            listing_currency_codes: codes.iter().map(|c| (*c).to_owned()).collect(),
            has_cost_basis: cost,
            presets: catalog(),
            editor_defaults: crate::api::EditorDefaults {
                currency_code: (codes.len() == 1).then(|| codes[0].to_owned()),
                floor: crate::api::DefaultFloor {
                    mode: if cost { "cost-basis-plus-margin" } else { "absolute" }.to_owned(),
                    margin_percent: cost.then_some(10.0),
                },
            },
            ..RepricingPrerequisites::default()
        }
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

    /// A fresh Beat the lowest listing with a cost basis asks Pricing to compile its controls; the
    /// listing age goes only with the preset that reads it.
    #[test]
    fn a_preset_asks_pricing_to_compile_its_controls() {
        let fresh = input(&[("preset", "beat-lowest"), ("from", "track-market"), ("fallback", "4.00")]);
        let editor = Editor::read(&fresh, &facts(&["USD"], true), en());
        assert_eq!(
            editor.request(),
            json!({ "preset": "beat-lowest", "knob": 2, "name": "Beat the lowest listing", "currencyCode": "USD",
              "floor": { "mode": "cost-basis-plus-margin", "marginPercent": 10, "absoluteFallbackAmount": "4.00" },
              "scope": { "kind": "all-listings" } })
        );
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
        assert_eq!(
            slow.request(),
            json!({ "preset": "slow-stock", "knob": 12, "ageDays": 60, "name": "Slow", "currencyCode": "USD",
              "floor": { "mode": "absolute", "amount": "1.00" },
              "scope": { "kind": "catalog-filter", "categoryIds": ["cat-1"] } })
        );
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
        assert_eq!((held.knob, held.age), (15, None), "held to the range; Beat reads no age");
        let aged = Editor::read(
            &input(&[("preset", "slow-stock"), ("from", "slow-stock"), ("knob", "-3"), ("age", "3")]),
            &facts(&[], false),
            en(),
        );
        assert_eq!((aged.knob, aged.age), (0, Some(14)));
        let mut fewer = facts(&[], false);
        fewer.presets.retain(|controls| controls.preset != "slow-stock");
        let unoffered = Editor::read(&input(&[("preset", "slow-stock"), ("age", "60")]), &fewer, en());
        assert_eq!((unoffered.preset, unoffered.age), (Preset::Track, None), "a preset Pricing does not offer is not drawn");
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
        // The run's body as Pricing compiled the editor's controls, without the name.
        let directive = json!({ "currencyCode": "USD", "anchorChain": [{ "source": "market-estimate" }],
          "offset": { "mode": "percent", "percent": 3 },
          "floor": { "mode": "cost-basis-plus-margin", "marginPercent": 12.5, "absoluteFallbackAmount": "1" } });
        let compiled = |source: Value| {
            let mut body = json!({ "scope": { "kind": "all-listings" }, "excludedListingIds": [], "maxChangesPerDay": 250,
              "rules": [{ "conditions": [], "directive": directive }] });
            crate::repricing_body::bind(&mut body, source);
            body
        };
        let source = json!({ "kind": "preset", "preset": "track-market", "knob": 3, "ageDays": 45 });
        let body = compiled(source.clone());
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
        let mut changed = body.clone();
        changed["rules"][0]["directive"]["offset"]["percent"] = json!(4);
        assert!(!editor.previewed_by(&run(changed)), "rules changed since its intent was bound");
        let mut knob = source.clone();
        knob["knob"] = json!(4);
        assert!(!editor.previewed_by(&run(compiled(knob))));
        let mut floor = body.clone();
        floor["rules"][0]["directive"]["floor"]["marginPercent"] = json!(10);
        crate::repricing_body::bind(&mut floor, source);
        assert!(!editor.previewed_by(&run(floor)), "another floor");
        let mut unbound = body;
        unbound["authoringIntent"] = Value::Null;
        assert!(!editor.previewed_by(&run(unbound)));
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
