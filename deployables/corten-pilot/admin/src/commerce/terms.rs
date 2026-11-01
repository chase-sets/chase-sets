//! Commerce > Commercial Terms (admin-web's `/commerce/terms`, Commercial Terms' `CommercialTermsHomePage`):
//! the published seller fee schedule, the active and scheduled schedules and account overrides,
//! and a sheet for each: a schedule's or an override's (compare, history, revise) and the two
//! create sheets. Read from and written to `/api/commercial-terms` (and the public fee schedule) as
//! the signed-in staff member: reading needs `commercial-terms.view`; the API itself refuses a
//! schedule write without `commercial-terms.manage` and an override write without
//! `commercial-terms.agreements.manage`, as admin-web's action leaves to it.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /commerce/terms?schedule&agreement&create&account&after_write` | the page, with a sheet open |
//! | `POST /commerce/terms?..` | a write (`intent`: create-schedule, revise-schedule, create-agreement, revise-agreement), then the page with its sheet |
//! | `GET /commerce/terms/schedules`, `/agreements` | the page, with the query (admin-web's redirects) |
//! | `GET /commerce/terms/schedules/{id}`, `/agreements/{id}` | the page with that sheet open |
//! | `GET /commerce/terms/accounts/{id}/agreements/new` | the page with Create account override open for the account |
//!
//! The home read (`GET /api/commercial-terms/home`) says which terms are active and scheduled, in
//! what order and in what phase, which schedule a revision is compared with, and what a new schedule
//! or override starts from, worked out by the API at one instant; the page draws them as given.
use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::views;
use crate::{
    api::{ApiError, Caller as ApiCaller, Method, segment},
    app::{Shared, sign_in},
    auth::{Staff, TermsAccess, Viewer},
    text::{Com, Pilot},
};

const CONTEXT: &str = "commercial-terms";
const BASE: &str = "/api/commercial-terms";
const PUBLISHED: &str = "/api/public/commercial-terms/marketplace-sales-fee-schedule";

#[corten::routes(state = crate::app::Shared, area = crate::commerce::terms::url::Terms, caller = crate::auth::Staff<crate::auth::TermsAccess>)]
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    /// What the page has open: a schedule, an override, or a create sheet (for an account), and a
    /// write's receipt.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct Open {
        pub schedule: Option<String>,
        pub agreement: Option<String>,
        pub create: Option<String>,
        pub account: Option<String>,
        #[serde(rename = "after_write")]
        pub after_write: Option<String>,
    }

    /// The page; a `POST` is a write.
    #[derive(Clone, Debug, Default)]
    #[route("/commerce/terms", get = page, post = act)]
    pub struct Terms {
        #[route(query)]
        pub open: Open,
    }

    #[route("/commerce/terms/schedules", get = to_home)]
    pub struct Schedules;

    #[route("/commerce/terms/agreements", get = to_home)]
    pub struct Agreements;

    #[route("/commerce/terms/schedules/{id}", get = to_schedule)]
    pub struct Schedule<'a> {
        pub id: &'a str,
    }

    #[route("/commerce/terms/agreements/{id}", get = to_agreement)]
    pub struct Agreement<'a> {
        pub id: &'a str,
    }

    #[route("/commerce/terms/accounts/{account_id}/agreements/new", get = to_new_agreement)]
    pub struct NewAgreement<'a> {
        pub account_id: &'a str,
    }
}

/// The area: its routes, its stylesheet, its script and the sheets' dialog.
pub fn area(area: Area<url::Terms>, shared: Shared) -> Area<url::Terms> {
    url::area(area, shared).components(views::TERMS)
}

/// A revision of a schedule or an override (`CommercialTermsHistoryItem`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct HistoryItem {
    pub event_type: String,
    pub actor_user_id: String,
    pub status: String,
    pub recorded_at: String,
}

/// The fee terms a schedule and an override share.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Fees {
    pub label: String,
    pub marketplace_sales_fee_percentage_bps: i64,
    pub marketplace_sales_fee_fixed_amount: String,
    pub shipping_allowance_percentage_bps: i64,
    pub status: String,
    pub effective_from: String,
    #[serde(default)]
    pub effective_until: Option<String>,
}

/// A seller fee schedule for an account type (`CommercialTermsSchedule`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Schedule {
    pub schedule_id: String,
    pub account_type: String,
    #[serde(flatten)]
    pub fees: Fees,
    #[serde(default)]
    pub history: Vec<HistoryItem>,
}

/// An account override (`CommercialAgreement`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Agreement {
    pub agreement_id: String,
    pub account_id: String,
    #[serde(default)]
    pub account_name: Option<String>,
    #[serde(default)]
    pub account_display_name: Option<String>,
    #[serde(flatten)]
    pub fees: Fees,
    #[serde(default)]
    pub history: Vec<HistoryItem>,
}

impl Agreement {
    /// The account as admin-web names it: "name (display name)", either one, else its ID.
    pub fn account(&self) -> String {
        let name = self.account_name.as_deref().map(str::trim).filter(|n| !n.is_empty());
        let display = self.account_display_name.as_deref().map(str::trim).filter(|n| !n.is_empty());
        match (name, display) {
            (Some(name), Some(display)) => format!("{name} ({display})"),
            (Some(one), None) | (None, Some(one)) => one.to_owned(),
            (None, None) => self.account_id.clone(),
        }
    }
}

/// An account an override can be for.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct AccountOption {
    pub account_id: String,
    pub account_name: String,
    pub display_name: String,
    pub account_type: String,
}

/// The published seller fee schedule's terms.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct PublishedTerms {
    pub label: String,
    pub marketplace_sales_fee_percentage_bps: i64,
    pub marketplace_sales_fee_fixed_amount: String,
    pub marketplace_sales_fee_cap_amount: String,
    pub shipping_allowance_percentage_bps: i64,
}

/// The published seller fee schedule: from policy, or the fallback.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub value: PublishedTerms,
    pub source: String,
    #[serde(default)]
    pub effective_from: Option<String>,
}

#[derive(Deserialize)]
struct List<T> {
    items: Vec<T>,
}

/// When an active term's phase starts or ends (`CommercialTermsHomePhase`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Not in effect yet: from `phase_at`.
    Scheduled,
    /// In effect since `phase_at`.
    InEffect,
    /// An override in effect until `phase_at`.
    Expiring,
}

/// An active or scheduled term, in the home read's order (`CommercialTermsHomeTerm`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Term {
    Schedule { id: String, phase: Phase, phase_at: String, item: Schedule },
    Agreement { id: String, phase: Phase, phase_at: String, item: Agreement },
}

impl Term {
    pub fn fees(&self) -> &Fees {
        match self {
            Term::Schedule { item, .. } => &item.fees,
            Term::Agreement { item, .. } => &item.fees,
        }
    }

    pub fn phase(&self) -> (Phase, &str) {
        match self {
            Term::Schedule { phase, phase_at, .. } | Term::Agreement { phase, phase_at, .. } => (*phase, phase_at),
        }
    }
}

/// What a create form starts from (`CommercialTermsStartingTerms`); no label leaves the page's own.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StartingTerms {
    #[serde(default)]
    pub label: Option<String>,
    pub marketplace_sales_fee_percentage_bps: i64,
    pub marketplace_sales_fee_fixed_amount: String,
    pub shipping_allowance_percentage_bps: i64,
    pub status: String,
    pub effective_from: String,
    #[serde(default)]
    pub effective_until: Option<String>,
}

/// An override's starting terms by the account's type, and for any other type.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OverrideStart {
    pub personal: StartingTerms,
    pub business: StartingTerms,
    pub enterprise: StartingTerms,
    pub default: StartingTerms,
}

impl OverrideStart {
    /// For an account of `account_type` (admin-web's `overrideStartingTerms`).
    pub fn for_type(&self, account_type: Option<&str>) -> &StartingTerms {
        match account_type {
            Some("personal") => &self.personal,
            Some("business") => &self.business,
            Some("enterprise") => &self.enterprise,
            _ => &self.default,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Starting {
    pub schedule: StartingTerms,
    #[serde(rename = "override")]
    pub overrides: OverrideStart,
}

/// The home read (`CommercialTermsHome`), as far as the page shows it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Home {
    pub active_terms: Vec<Term>,
    pub starting_terms: Starting,
    /// The schedule in effect that the open schedule's sheet is compared with.
    #[serde(default)]
    pub schedule_comparison: Option<Schedule>,
}

/// The fee fields as a form shows them: what an item has, what was sent, or the defaults.
#[derive(Clone, Debug, Default, Deserialize, Serialize, Fields, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct TermsForm {
    pub intent: String,
    pub id: String,
    pub account_type: String,
    pub account_id: String,
    pub label: String,
    pub marketplace_sales_fee_percentage_bps: String,
    pub marketplace_sales_fee_fixed_amount: String,
    pub shipping_allowance_percentage_bps: String,
    pub status: String,
    pub effective_from: String,
    pub effective_until: String,
    /// Set by Create account override's Review: re-read the starting terms for `account_id`.
    pub review: String,
}

impl TermsForm {
    /// A form filled from `fees`.
    pub fn from_fees(fees: &Fees) -> TermsForm {
        TermsForm {
            label: fees.label.clone(),
            marketplace_sales_fee_percentage_bps: fees.marketplace_sales_fee_percentage_bps.to_string(),
            marketplace_sales_fee_fixed_amount: fees.marketplace_sales_fee_fixed_amount.clone(),
            shipping_allowance_percentage_bps: fees.shipping_allowance_percentage_bps.to_string(),
            status: fees.status.clone(),
            effective_from: fees.effective_from.clone(),
            effective_until: fees.effective_until.clone().unwrap_or_default(),
            ..TermsForm::default()
        }
    }

    /// A create form filled from the home read's starting terms, with `label` when they name none.
    pub fn starting(terms: &StartingTerms, label: &str) -> TermsForm {
        TermsForm {
            label: terms.label.clone().unwrap_or_else(|| label.to_owned()),
            marketplace_sales_fee_percentage_bps: terms.marketplace_sales_fee_percentage_bps.to_string(),
            marketplace_sales_fee_fixed_amount: terms.marketplace_sales_fee_fixed_amount.clone(),
            shipping_allowance_percentage_bps: terms.shipping_allowance_percentage_bps.to_string(),
            status: terms.status.clone(),
            effective_from: terms.effective_from.clone(),
            effective_until: terms.effective_until.clone().unwrap_or_default(),
            ..TermsForm::default()
        }
    }
}

/// A number field as admin-web's `Number(..)` reads it: empty is 0, not a number is null.
fn number(value: &str) -> Value {
    let value = value.trim();
    if value.is_empty() {
        return json!(0);
    }
    value.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
}

/// The fee terms admin-web's action sends (`termsBody`).
pub fn body(form: &TermsForm) -> Value {
    json!({
        "label": form.label,
        "marketplaceSalesFeePercentageBps": number(&form.marketplace_sales_fee_percentage_bps),
        "marketplaceSalesFeeFixedAmount": form.marketplace_sales_fee_fixed_amount,
        "shippingAllowancePercentageBps": number(&form.shipping_allowance_percentage_bps),
        "status": form.status,
        "effectiveFrom": form.effective_from,
        "effectiveUntil": form.effective_until,
    })
}

/// What the page has open.
pub enum Sheet {
    None,
    Schedule(Box<Schedule>),
    Agreement(Box<Agreement>),
    CreateSchedule,
    CreateAgreement { account: Option<String> },
}

/// The page as drawn.
pub struct TermsScreen {
    pub published: Option<Published>,
    pub home: Option<Home>,
    pub accounts: Vec<AccountOption>,
    pub sheet: Sheet,
    /// The form as sent when a write was refused.
    pub sent: Option<TermsForm>,
    /// Why the page could not be read.
    pub load_error: Option<String>,
    /// Why the last write was not saved.
    pub error: Option<String>,
    /// That the page was read without the write's receipt, which it had not caught up to.
    pub catching_up: bool,
}

/// The parts of the page the data client gets.
#[derive(Serialize, ToJson)]
struct TermsData<'a> {
    published: Option<&'a Published>,
    active_terms: &'a [Term],
    error: Option<&'a str>,
    load_error: Option<&'a str>,
}

struct Read {
    home: Home,
    accounts: Vec<AccountOption>,
    schedule: Option<Schedule>,
    agreement: Option<Agreement>,
    published: Published,
}

async fn read(caller: &ApiCaller<'_>, open: &url::Open) -> Result<Read, ApiError> {
    let home = match open.schedule.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => format!("{BASE}/home?schedule={}", segment(id)),
        None => format!("{BASE}/home"),
    };
    let accounts = format!("{BASE}/agreements/account-options");
    let one_schedule = open.schedule.as_deref().filter(|s| !s.is_empty()).map(|id| format!("{BASE}/schedules/{}", segment(id)));
    let one_agreement =
        open.agreement.as_deref().filter(|a| !a.is_empty()).map(|id| format!("{BASE}/agreements/{}", segment(id)));
    let (home, accounts, schedule, agreement, published) = tokio::try_join!(
        caller.read::<Home>(&home, CONTEXT),
        caller.read::<List<AccountOption>>(&accounts, CONTEXT),
        async {
            match &one_schedule {
                Some(path) => caller.read::<Schedule>(path, CONTEXT).await.map(Some),
                None => Ok(None),
            }
        },
        async {
            match &one_agreement {
                Some(path) => caller.read::<Agreement>(path, CONTEXT).await.map(Some),
                None => Ok(None),
            }
        },
        caller.read::<Published>(PUBLISHED, CONTEXT),
    )?;
    Ok(Read { home, accounts: accounts.items, schedule, agreement, published })
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<TermsAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Terms>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.open.after_write.as_deref());
    draw(&req, &staff.viewer, &config, &headers, &route.open, receipt, None, None, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    open: &url::Open,
    receipt: Option<Receipt>,
    sent: Option<TermsForm>,
    error: Option<String>,
    mut status: StatusCode,
) -> HtmlResult {
    let (t, p): (Com, Pilot) = (req.t(), req.t());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let mut catching_up = false;
    let mut found = read(&caller, open).await;
    if receipt.is_some() && found.as_ref().is_err_and(|e| e.catching_up() || e.status() == Some(StatusCode::NOT_FOUND)) {
        // The write's projection has not caught up: read without the receipt, and leave the
        // written item's sheet closed until it is readable.
        catching_up = true;
        let plain = config.platform.caller(headers, config.proto, None);
        found = read(&plain, open).await;
        if found.as_ref().is_err_and(|e| e.status() == Some(StatusCode::NOT_FOUND)) {
            let lists = url::Open { schedule: None, agreement: None, ..open.clone() };
            found = read(&plain, &lists).await;
        }
    }
    let mut screen = TermsScreen {
        published: None,
        home: None,
        accounts: Vec::new(),
        sheet: Sheet::None,
        sent,
        load_error: None,
        error,
        catching_up,
    };
    match found {
        Ok(found) => {
            screen.sheet = match (found.schedule, found.agreement, open.create.as_deref()) {
                (Some(schedule), _, _) => Sheet::Schedule(Box::new(schedule)),
                (None, Some(agreement), _) => Sheet::Agreement(Box::new(agreement)),
                (None, None, Some("schedule")) => Sheet::CreateSchedule,
                (None, None, Some("agreement")) => Sheet::CreateAgreement { account: open.account.clone() },
                _ => Sheet::None,
            };
            screen.published = Some(found.published);
            screen.home = Some(found.home);
            screen.accounts = found.accounts;
        }
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Err(error) => {
            // admin-web's banner: the API's words, else its own.
            tracing::warn!("Commercial Terms could not be read: {error}");
            screen.load_error = Some(error.refusal().unwrap_or(t.ct_load_unavailable()).to_owned());
            if status == StatusCode::OK {
                status =
                    if error.status() == Some(StatusCode::NOT_FOUND) { StatusCode::NOT_FOUND } else { StatusCode::BAD_GATEWAY };
            }
        }
    }
    let data = TermsData {
        published: screen.published.as_ref(),
        active_terms: screen.home.as_ref().map_or(&[], |home| &home.active_terms),
        error: screen.error.as_deref(),
        load_error: screen.load_error.as_deref(),
    };
    let view = html! { <views::TermsPage t={t} p={p} screen={&screen} /> };
    req.screen_with_status(
        status,
        &data,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.ct_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

#[derive(Deserialize)]
struct Written {
    id: String,
}

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<TermsAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Terms>,
    Form(form): Form<TermsForm>,
) -> HtmlResult {
    let t: Com = req.t();
    let open = route.open;
    let caller = config.platform.caller(&headers, config.proto, None);
    let id = form.id.trim().to_owned();
    if form.intent == "create-agreement" && !form.review.is_empty() {
        let account = Some(form.account_id.trim().to_owned()).filter(|a| !a.is_empty());
        let open = url::Open { create: Some("agreement".to_owned()), account, ..url::Open::default() };
        return req.redirect(&url::Terms { open });
    }
    let (request, sheet) = match form.intent.as_str() {
        "create-schedule" => {
            let mut sent = body(&form);
            sent["accountType"] = json!(form.account_type);
            (caller.request(Method::POST, &format!("{BASE}/schedules"), CONTEXT).json(&sent), "schedule")
        }
        "revise-schedule" => {
            (caller.request(Method::PUT, &format!("{BASE}/schedules/{}", segment(&id)), CONTEXT).json(&body(&form)), "schedule")
        }
        "create-agreement" => {
            let mut sent = body(&form);
            sent["accountId"] = json!(form.account_id.trim());
            (caller.request(Method::POST, &format!("{BASE}/agreements"), CONTEXT).json(&sent), "agreement")
        }
        "revise-agreement" => {
            (caller.request(Method::PUT, &format!("{BASE}/agreements/{}", segment(&id)), CONTEXT).json(&body(&form)), "agreement")
        }
        _ => {
            let error = Some(t.ct_unknown_action().to_owned());
            return draw(
                &req,
                &staff.viewer,
                &config,
                &headers,
                &open,
                None,
                Some(form),
                error,
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
        }
    };
    match caller.write::<Written>(request).await {
        Ok((written, receipt)) => {
            let after_write = receipt.map(|r| r.param());
            let open = if sheet == "schedule" {
                url::Open { schedule: Some(written.id), after_write, ..url::Open::default() }
            } else {
                url::Open { agreement: Some(written.id), after_write, ..url::Open::default() }
            };
            req.redirect(&url::Terms { open })
        }
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
        Err(error) => {
            let (message, status) = match error.status() {
                Some(StatusCode::FORBIDDEN) => {
                    (error.refusal().unwrap_or(t.ct_change_rejected()).to_owned(), StatusCode::FORBIDDEN)
                }
                Some(status) if status.is_client_error() => {
                    (error.refusal().unwrap_or(t.ct_change_rejected()).to_owned(), StatusCode::UNPROCESSABLE_ENTITY)
                }
                _ => {
                    tracing::warn!("a Commercial Terms write failed: {error}");
                    (t.ct_unavailable().to_owned(), StatusCode::BAD_GATEWAY)
                }
            };
            draw(&req, &staff.viewer, &config, &headers, &open, None, Some(form), Some(message), status).await
        }
    }
}

/// `to` with the query the old address had.
fn with_query(req: &Req, to: String, uri: &Uri) -> HtmlResult {
    let to = match uri.query() {
        Some(query) if !query.is_empty() => format!("{to}?{query}"),
        _ => to,
    };
    let to: Uri = to.parse().map_err(corten::Error::new)?;
    req.redirect(&to)
}

async fn to_home(req: Req, Caller(_): Caller<Staff<TermsAccess>>, uri: Uri) -> HtmlResult {
    with_query(&req, url::Terms::default().href(), &uri)
}

async fn to_schedule(req: Req, Caller(_): Caller<Staff<TermsAccess>>, Params(route): Params<url::Schedule<'_>>) -> HtmlResult {
    req.redirect(&url::Terms { open: url::Open { schedule: Some(route.id.to_owned()), ..url::Open::default() } })
}

async fn to_agreement(req: Req, Caller(_): Caller<Staff<TermsAccess>>, Params(route): Params<url::Agreement<'_>>) -> HtmlResult {
    req.redirect(&url::Terms { open: url::Open { agreement: Some(route.id.to_owned()), ..url::Open::default() } })
}

async fn to_new_agreement(
    req: Req,
    Caller(_): Caller<Staff<TermsAccess>>,
    Params(route): Params<url::NewAgreement<'_>>,
) -> HtmlResult {
    let open =
        url::Open { create: Some("agreement".to_owned()), account: Some(route.account_id.to_owned()), ..url::Open::default() };
    req.redirect(&url::Terms { open })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_number_field_reads_as_admin_webs_number() {
        assert_eq!(number(""), json!(0));
        assert_eq!(number(" 850 "), json!(850.0));
        assert_eq!(number("lots"), Value::Null);
    }
}
