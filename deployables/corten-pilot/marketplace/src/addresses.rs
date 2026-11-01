//! The account's shipping addresses (Identity's `account-shipping-addresses`): the list, add an
//! address, update one, make one the default and archive one. Every rule is the API's: which
//! fields are required, whether an address is deliverable, the address it suggests instead.
//!
//! Each write is an Identity account-management attempt: the form's `SubmitKey`, sent as the
//! `Idempotency-Key` the API applies once and answers again with its first result. An answer the
//! pilot did not get (no answer, a 5xx, `indeterminate`) is asked about at once (the attempt
//! lookup), as marketplace's `sendMutation` does; one the lookup cannot settle sends the page to
//! ask again (`?check=`), saying it could not confirm the write, with that write's form off.
//! marketplace keeps that record in memory; the pilot keeps it in the address.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/shipping-addresses?<place>` | the addresses, read after the write whose receipt it carries |
//! | `POST /account/shipping-addresses` | add an address |
//! | `POST /account/shipping-addresses/{id}` | update it |
//! | `POST /account/shipping-addresses/{id}/default` | make it the default |
//! | `POST /account/shipping-addresses/{id}/archive` | archive it |
use crate::recovery::attempt_text;
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    api::{AccountAction, AccountAnswer, AddressCommand, Addresses as _, ApiError, ShippingAddress, SuggestedAddress},
    app::{Shared, read_failed, sign_in, url},
    auth::{AddressOwner, Viewer},
    recovery::valid_attempt,
    text::{AddressesMsg, Pilot},
    views::{self, Layout},
};

/// What the page's address carries: the last write's receipt (`after_write`), the attempt that
/// answer settles (`saved`), and an attempt to ask the API about (`check`, its `action` and
/// `target`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub saved: Option<String>,
    pub check: Option<String>,
    pub action: Option<AccountAction>,
    pub target: Option<String>,
}

/// What the page says about the last write (marketplace's `ClientState`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Said {
    #[default]
    Editing,
    /// Saved (`succeeded`).
    Saved,
    /// Nothing was recorded (`failed-safe`).
    NotSaved,
    /// The address book changed (`conflict`).
    Conflict,
    /// Whether it was saved is not known yet (`ambiguous`): that write's form is off.
    Unconfirmed { attempt: String, action: AccountAction, target: Option<String> },
    /// The account may no longer do it (`route-denied`).
    Denied,
}

impl Said {
    /// Whether the form for `action` on `target` is off: the write it would repeat is unconfirmed.
    pub fn holds(&self, action: AccountAction, target: Option<&str>) -> bool {
        matches!(self, Said::Unconfirmed { action: a, target: t, .. } if *a == action && t.as_deref() == target)
    }
}

/// A create or update form's fields, the attempt it was drawn with (its `SubmitKey`), and the
/// choice made between the address and the one the API suggested (the button pressed).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct AddressInput {
    pub attempt: Option<SubmitKey>,
    pub label: String,
    pub name: String,
    pub company: String,
    pub country: String,
    pub line1: String,
    pub line2: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub phone: String,
    pub email: String,
    pub make_default: String,
    pub decision: String,
}

fn optional(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

impl AddressInput {
    /// The add form: empty, the country `US`, the default kept.
    pub fn blank() -> Self {
        AddressInput { country: "US".into(), make_default: "false".into(), ..Default::default() }
    }

    /// An address's update form.
    pub fn of(address: &ShippingAddress) -> Self {
        let text = |t: &Option<String>| t.clone().unwrap_or_default();
        AddressInput {
            attempt: None,
            label: text(&address.label),
            name: address.recipient_name.clone(),
            company: text(&address.company),
            country: address.country.clone(),
            line1: address.line1.clone(),
            line2: text(&address.line2),
            city: address.city.clone(),
            state: address.state.clone(),
            postal_code: address.postal_code.clone(),
            phone: text(&address.phone),
            email: text(&address.email),
            make_default: if address.is_default { "true" } else { "false" }.into(),
            decision: String::new(),
        }
    }

    /// The body marketplace's `addressBody` builds.
    pub fn command(&self) -> AddressCommand {
        AddressCommand {
            label: optional(&self.label),
            name: self.name.trim().to_owned(),
            company: optional(&self.company),
            line1: self.line1.trim().to_owned(),
            line2: optional(&self.line2),
            city: self.city.trim().to_owned(),
            state: self.state.trim().to_owned(),
            postal_code: self.postal_code.trim().to_owned(),
            country: optional(&self.country).unwrap_or_else(|| "US".into()),
            phone: optional(&self.phone),
            email: optional(&self.email),
            make_default: self.make_default.trim() == "true",
            address_verification_decision: Some(self.decision.trim())
                .filter(|d| matches!(*d, "accept-suggested" | "keep-original"))
                .map(str::to_owned),
        }
    }
}

/// A form a refused write draws again: what was sent, what is wrong with it, and the address the
/// API suggested instead.
#[derive(Clone, Debug)]
pub struct Draft {
    pub input: AddressInput,
    pub errors: Errors,
    pub suggested: Option<SuggestedAddress>,
}

impl Draft {
    pub fn new(input: AddressInput) -> Self {
        Draft { input, errors: Errors::new(), suggested: None }
    }
}

/// The form a refused write posted: the add form, or an address's update form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Which {
    Create,
    Update(String),
}

/// The page: the addresses (none while the list catches up with a write), what the last write
/// did, and a refused form drawn again.
#[derive(Serialize, ToJson)]
pub struct AddressScreen {
    pub addresses: Vec<ShippingAddress>,
    pub pending: bool,
    pub said: Said,
    #[serde(skip)]
    pub posted: Option<(Which, Draft)>,
}

pub(crate) async fn page(
    req: Req,
    Caller(AddressOwner(viewer)): Caller<AddressOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::addresses::ShippingAddresses>,
) -> HtmlResult {
    let place = route.place;
    let said = match (&place.check, place.action) {
        (Some(attempt), Some(action)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            check(&caller, action, place.target.as_deref(), attempt).await
        }
        (Some(_), None) => Said::NotSaved,
        (None, _) if place.saved.is_some() => Said::Saved,
        (None, _) => Said::Editing,
    };
    render(&req, &viewer, &config, &headers, place.after_write.as_deref(), said, None, StatusCode::OK).await
}

/// What the API says came of `attempt`, for the page.
async fn check(caller: &crate::api::Caller<'_>, action: AccountAction, target: Option<&str>, attempt: &str) -> Said {
    let unconfirmed = || Said::Unconfirmed { attempt: attempt.to_owned(), action, target: target.map(str::to_owned) };
    if !valid_attempt(attempt) {
        return Said::NotSaved;
    }
    match caller.account_attempt(action, target, attempt).await {
        Ok(AccountAnswer::Committed(_)) => Said::Saved,
        Ok(AccountAnswer::NotRecorded { .. }) => Said::NotSaved,
        Ok(AccountAnswer::Conflict) => Said::Conflict,
        Ok(AccountAnswer::Indeterminate) => unconfirmed(),
        Err(error) => {
            tracing::warn!("the address attempt check failed: {error}");
            unconfirmed()
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    after_write: Option<&str>,
    said: Said,
    posted: Option<(Which, Draft)>,
    status: StatusCode,
) -> HtmlResult {
    let receipt = Receipt::from_param(after_write);
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let (addresses, pending) = match caller.shipping_addresses(&viewer.actor.account_id).await {
        Ok(addresses) => (addresses, false),
        // The write's projection is not readable yet: marketplace's `onPending`.
        Err(error) if receipt.is_some() && error.catching_up() => (Vec::new(), true),
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let screen = AddressScreen { addresses, pending, said, posted };
    let t: AddressesMsg = req.t();
    let head = html! {
        if pending {
            <ReadAgain after={std::time::Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::AddressPage t={t} p={req.t()} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_shipping_addresses_marketplace()} head={head}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn create(
    req: Req,
    Caller(AddressOwner(viewer)): Caller<AddressOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<AddressInput>,
) -> HtmlResult {
    write(&req, &viewer, &config, &headers, AccountAction::Create, None, input).await
}

pub(crate) async fn update(
    req: Req,
    Caller(AddressOwner(viewer)): Caller<AddressOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::addresses::AddressUpdate<'_>>,
    Form(input): Form<AddressInput>,
) -> HtmlResult {
    let id = route.id;
    write(&req, &viewer, &config, &headers, AccountAction::Update, Some(&id), input).await
}

pub(crate) async fn make_default(
    req: Req,
    Caller(AddressOwner(viewer)): Caller<AddressOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::addresses::AddressDefault<'_>>,
    Form(input): Form<AddressInput>,
) -> HtmlResult {
    let id = route.id;
    write(&req, &viewer, &config, &headers, AccountAction::Default, Some(&id), input).await
}

pub(crate) async fn archive(
    req: Req,
    Caller(AddressOwner(viewer)): Caller<AddressOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::addresses::AddressArchive<'_>>,
    Form(input): Form<AddressInput>,
) -> HtmlResult {
    let id = route.id;
    write(&req, &viewer, &config, &headers, AccountAction::Archive, Some(&id), input).await
}

/// The field a required-field refusal names, as the form calls it.
fn field_of(api: &str) -> Option<FieldName<String>> {
    let f = AddressInput::FIELDS;
    Some(match api {
        "name" => f.name,
        "line1" => f.line1,
        "city" => f.city,
        "state" => f.state,
        "postalCode" => f.postal_code,
        "country" => f.country,
        _ => return None,
    })
}

/// The words for a required field the API names.
fn required(t: AddressesMsg, api: &str) -> &'static str {
    match api {
        "name" => t.errors_name_required(),
        "line1" => t.errors_line1_required(),
        "city" => t.errors_city_required(),
        "state" => t.errors_state_required(),
        "postalCode" => t.errors_postal_code_required(),
        _ => t.errors_country_required(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn write(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    action: AccountAction,
    target: Option<&str>,
    input: AddressInput,
) -> HtmlResult {
    let (t, p): (AddressesMsg, Pilot) = (req.t(), req.t());
    let which = match (action, target) {
        (AccountAction::Create, _) => Some(Which::Create),
        (AccountAction::Update, Some(id)) => Some(Which::Update(id.to_owned())),
        _ => None,
    };
    let attempt = attempt_text(&input.attempt).to_owned();
    let refuse = |errors: Errors, suggested: Option<SuggestedAddress>| {
        let posted = which.clone().map(|which| (which, Draft { input: input.clone(), errors, suggested }));
        let said = if posted.is_some() { Said::Editing } else { Said::NotSaved };
        render(req, viewer, config, headers, None, said, posted, StatusCode::UNPROCESSABLE_ENTITY)
    };
    if !valid_attempt(&attempt) {
        let mut errors = Errors::new();
        errors.add_form(p.check_attempt());
        return refuse(errors, None).await;
    }
    let command = which.as_ref().map(|_| input.command());
    let caller = config.platform.caller(headers, config.proto, None);
    let account = viewer.actor.account_id.as_str();
    let answer = match caller.write_address(account, action, target, &attempt, command.as_ref()).await {
        Ok(answer) => answer,
        Err(ApiError::Transport(error)) => {
            tracing::warn!("an address write had no answer: {error}");
            AccountAnswer::Indeterminate
        }
        Err(error) => return failed(req, viewer, config, headers, error).await,
    };
    // No answer that says what happened: ask what came of the attempt, as marketplace does.
    let answer = match answer {
        AccountAnswer::Indeterminate => match caller.account_attempt(action, target, &attempt).await {
            Ok(AccountAnswer::Indeterminate) | Err(_) => {
                let place =
                    Place { check: Some(attempt), action: Some(action), target: target.map(str::to_owned), ..Place::default() };
                return req.redirect(&url::ShippingAddresses { place });
            }
            Ok(answer) => answer,
        },
        answer => answer,
    };
    match answer {
        AccountAnswer::Committed(after_write) => {
            let place = Place { after_write, saved: Some(attempt), ..Place::default() };
            req.redirect(&url::ShippingAddresses { place })
        }
        AccountAnswer::NotRecorded { code, field, suggested } => {
            let mut errors = Errors::new();
            match (code.as_str(), field.as_deref()) {
                ("validation-failed", Some(api)) if field_of(api).is_some() => {
                    errors.add(field_of(api).expect("checked"), required(t, api));
                }
                ("validation-failed", _) => errors.add_form(t.action_validation()),
                ("shipping-address-undeliverable", _) => errors.add_form(t.errors_undeliverable()),
                ("address-standardization-suggested", _) if suggested.is_some() => {}
                _ => errors.add_form(t.manage_state_failed_safe()),
            }
            refuse(errors, suggested.map(|s| *s)).await
        }
        AccountAnswer::Conflict => render(req, viewer, config, headers, None, Said::Conflict, None, StatusCode::CONFLICT).await,
        AccountAnswer::Indeterminate => unreachable!("asked about above"),
    }
}

/// A write the API refused for who is asking: sign in again, or the page saying they may not.
async fn failed(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, error: ApiError) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(req),
        Some(StatusCode::FORBIDDEN) => {
            render(req, viewer, config, headers, None, Said::Denied, None, StatusCode::FORBIDDEN).await
        }
        _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_is_marketplaces() {
        let input = AddressInput {
            label: "  ".into(),
            name: " Ada ".into(),
            line1: "1 Test Way".into(),
            city: "Austin".into(),
            state: "TX".into(),
            postal_code: "78701".into(),
            make_default: "true".into(),
            decision: "keep-original".into(),
            ..AddressInput::default()
        };
        let command = input.command();
        assert_eq!(command.label, None);
        assert_eq!(command.name, "Ada");
        assert_eq!(command.country, "US", "an empty country is US");
        assert!(command.make_default);
        assert_eq!(command.address_verification_decision.as_deref(), Some("keep-original"));
        let other = AddressInput { decision: "anything".into(), ..input };
        assert_eq!(other.command().address_verification_decision, None);
    }

    #[test]
    fn only_the_unconfirmed_writes_form_is_held() {
        let said = Said::Unconfirmed { attempt: "a".into(), action: AccountAction::Archive, target: Some("adr_1".into()) };
        assert!(said.holds(AccountAction::Archive, Some("adr_1")));
        assert!(!said.holds(AccountAction::Archive, Some("adr_2")));
        assert!(!said.holds(AccountAction::Default, Some("adr_1")));
        assert!(!Said::Saved.holds(AccountAction::Create, None));
    }
}
