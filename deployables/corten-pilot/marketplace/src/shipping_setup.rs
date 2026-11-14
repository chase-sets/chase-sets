//! Seller shipping setup (Fulfillment's `seller-shipping-setup`, `shipping-setup-route-adapter.tsx`
//! with `ShippingSetupPage`, at `/sell/shipping-setup`): where the seller ships from and how they
//! want labels, saved for their account, or, before they have one, for the guest sell list the
//! browser carries. Seller checkout links to it.
//!
//! Whose setup it is follows marketplace's `createSellerShippingSetupRequestClient`: an account's
//! when someone is signed in through a session of their own (not a guest checkout's, whose role is
//! `guest-buyer` and whose session is `guest:`), else the guest sell list's, named by its cookie
//! when it is an `anon_` id of at most 160 letters, digits, `_` and `-`. With neither, the page asks
//! the seller to open their Sell List first.
//!
//! The rules are Fulfillment's (`parseShippingSetup`): every origin field but line 2 is required, none
//! longer than 200, and the label preference is one of two. The pilot checks them before it sends, as
//! marketplace's action does, so a form the API would refuse says "invalid" without a call, and a
//! form with a field it does not know, or a field twice, is refused too. Whether the platform
//! supports the saved preference is Fulfillment's answer (`supportStatus`); the page only words it.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /sell/shipping-setup` | the page: the saved setup and the form; `503` with Retry when it cannot be read |
//! | `POST /sell/shipping-setup` | saves the setup, then `303` to the page; what was typed back with "invalid" (`422`) or "could not be saved" (`422`, or `503` when the API is unavailable) |
//!
//! Both are kept by no cache. Corten refuses a post from another site before the handler runs, as
//! marketplace's action refuses a cross-site `Origin` or `Sec-Fetch-Site`.
use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
    security::cookie,
};
use serde::Serialize;

use crate::{
    api::{ApiError, ShippingOrigin, ShippingSetupCalls as _, ShippingSetupInput, ShippingSetupRead},
    app::{Shared, sign_in, url},
    auth::{Session, Viewer},
    items::Raw,
    selling::ANONYMOUS_SELL_LIST_COOKIE,
    text::ShippingSetupMsg,
    views::{self, Layout},
};

/// A label preference Fulfillment takes (`sellerCheckoutLabelPreferences`).
pub const PREPAID: &str = "prepaid-label";
pub const LATER: &str = "seller-label-later";

/// The longest a field may be (`parseShippingOrigin`).
const LONGEST: usize = 200;

/// Whose setup the page reads and saves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "kebab-case")]
pub enum Owner {
    /// The signed-in account's.
    Account,
    /// The guest sell list's, by its id.
    Guest(String),
}

impl Owner {
    fn guest(&self) -> Option<&str> {
        match self {
            Owner::Account => None,
            Owner::Guest(id) => Some(id),
        }
    }
}

/// A guest sell list id Fulfillment takes as an owner (`shippingId(value, "anon")`).
fn guest_sell_list(id: &str) -> bool {
    id.len() <= 160
        && id
            .strip_prefix("anon_")
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

/// Whose setup it is (`createSellerShippingSetupRequestClient`), or `None` when no one's.
pub fn owner(viewer: Option<&Viewer>, headers: &HeaderMap) -> Option<Owner> {
    if let Some(viewer) = viewer
        && viewer.actor.role_key != "guest-buyer"
        && !viewer.actor.session_id.starts_with("guest:")
    {
        return Some(Owner::Account);
    }
    cookie::get(headers, ANONYMOUS_SELL_LIST_COOKIE).filter(|id| guest_sell_list(id)).map(|id| Owner::Guest(id.to_owned()))
}

/// The form's fields, named as marketplace's (`shippingSetupFields`).
#[derive(Clone, Debug, PartialEq, Eq, Fields, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Values {
    pub name: String,
    pub line1: String,
    pub line2: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    pub label_preference: String,
}

impl Default for Values {
    /// An empty form (`emptyShippingSetupValues`): the country `US`, a prepaid label.
    fn default() -> Self {
        Values {
            name: String::new(),
            line1: String::new(),
            line2: String::new(),
            city: String::new(),
            state: String::new(),
            postal_code: String::new(),
            country: "US".into(),
            label_preference: PREPAID.into(),
        }
    }
}

impl Values {
    /// The saved setup's (`shippingSetupValues`), or an empty form.
    pub fn of(read: Option<&ShippingSetupRead>) -> Self {
        match read.and_then(|r| r.setup.as_ref()) {
            Some(setup) => {
                let o = &setup.origin;
                Values {
                    name: o.name.clone(),
                    line1: o.line1.clone(),
                    line2: o.line2.clone().unwrap_or_default(),
                    city: o.city.clone(),
                    state: o.state.clone(),
                    postal_code: o.postal_code.clone(),
                    country: o.country.clone(),
                    label_preference: setup.label_preference.clone(),
                }
            }
            None => Values::default(),
        }
    }

    fn slots(&mut self) -> [(&'static str, &mut String); 8] {
        let f = Values::FIELDS;
        [
            (f.name.as_str(), &mut self.name),
            (f.line1.as_str(), &mut self.line1),
            (f.line2.as_str(), &mut self.line2),
            (f.city.as_str(), &mut self.city),
            (f.state.as_str(), &mut self.state),
            (f.postal_code.as_str(), &mut self.postal_code),
            (f.country.as_str(), &mut self.country),
            (f.label_preference.as_str(), &mut self.label_preference),
        ]
    }

    /// What the form sent, each field as typed (an absent one empty), and whether it sent exactly
    /// its fields, each once.
    pub fn read(raw: &Raw) -> (Self, bool) {
        let mut values = Values { country: String::new(), label_preference: String::new(), ..Values::default() };
        let mut exact = true;
        let mut known = 0;
        for (name, slot) in values.slots() {
            match raw.get(name).map(|v| v.all()) {
                Some([one]) => {
                    slot.clone_from(one);
                    known += 1;
                }
                Some(many) => {
                    if let Some(first) = many.first() {
                        slot.clone_from(first);
                    }
                    exact = false;
                    known += 1;
                }
                None => exact = false,
            }
        }
        (values, exact && known == raw.len())
    }

    /// The setup Fulfillment would take (`parseShippingSetup`), trimmed, with the country in
    /// capitals and an empty line 2 as none (`normalizeAddressSnapshot`).
    pub fn input(&self) -> Option<ShippingSetupInput> {
        let required = [&self.name, &self.line1, &self.city, &self.state, &self.postal_code, &self.country];
        if required.iter().any(|text| text.trim().is_empty() || text.chars().count() > LONGEST)
            || self.line2.chars().count() > LONGEST
            || ![PREPAID, LATER].contains(&self.label_preference.as_str())
        {
            return None;
        }
        let line2 = self.line2.trim();
        Some(ShippingSetupInput {
            origin: ShippingOrigin {
                name: self.name.trim().to_owned(),
                line1: self.line1.trim().to_owned(),
                line2: (!line2.is_empty()).then(|| line2.to_owned()),
                city: self.city.trim().to_owned(),
                state: self.state.trim().to_owned(),
                postal_code: self.postal_code.trim().to_owned(),
                country: self.country.trim().to_uppercase(),
            },
            label_preference: self.label_preference.clone(),
        })
    }
}

/// The page: whose setup, what Fulfillment read, the form's values and what went wrong.
#[derive(Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    /// `None` when there is no one's setup to read (`missingIdentity`).
    pub owner: Option<Owner>,
    pub read: Option<ShippingSetupRead>,
    pub values: Values,
    pub error: Option<String>,
    /// The setup could not be read, and nothing typed is kept: Retry, and no form.
    pub unavailable: bool,
}

fn render(req: &Req, viewer: Option<&Viewer>, screen: &Screen, status: StatusCode) -> HtmlResult {
    let t: ShippingSetupMsg = req.t();
    let page = html! {
        <Layout req={req} viewer={viewer} title={t.title()} head={()}>
            <views::ShippingSetupPage t={t} screen={screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.screen(screen, page) } else { req.page_with_status(status, page) }
}

/// The page could not be read: the error and Retry (marketplace's loader's `503`).
fn unavailable(req: &Req, viewer: Option<&Viewer>, owner: Option<Owner>) -> HtmlResult {
    let t: ShippingSetupMsg = req.t();
    let screen =
        Screen { owner, read: None, values: Values::default(), error: Some(t.load_error().to_owned()), unavailable: true };
    render(req, viewer, &screen, StatusCode::SERVICE_UNAVAILABLE)
}

/// The page: the saved setup, or the form to make one.
pub(crate) async fn page(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let viewer = session.as_deref().and_then(Session::viewer);
    if matches!(session.as_deref(), Some(Session::Unavailable)) {
        return unavailable(&req, viewer, None);
    }
    let Some(owner) = owner(viewer, &headers) else {
        let screen = Screen { owner: None, read: None, values: Values::default(), error: None, unavailable: false };
        return render(&req, viewer, &screen, StatusCode::OK);
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.shipping_setup(owner.guest()).await {
        Ok(read) => {
            let screen =
                Screen { owner: Some(owner), values: Values::of(Some(&read)), read: Some(read), error: None, unavailable: false };
            render(&req, viewer, &screen, StatusCode::OK)
        }
        Err(error) => {
            tracing::warn!("the shipping setup could not be read: {error}");
            unavailable(&req, viewer, Some(owner))
        }
    }
}

/// Save shipping setup: the setup, then the page, which reads it; or what was typed, with why it
/// was not saved.
pub(crate) async fn write(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let t: ShippingSetupMsg = req.t();
    let viewer = session.as_deref().and_then(Session::viewer);
    if matches!(session.as_deref(), Some(Session::Unavailable)) {
        return unavailable(&req, viewer, None);
    }
    let (values, exact) = Values::read(&raw);
    let Some(owner) = owner(viewer, &headers) else {
        let screen = Screen {
            owner: None,
            read: None,
            values: Values::default(),
            error: Some(t.missing_identity().to_owned()),
            unavailable: false,
        };
        return render(&req, viewer, &screen, StatusCode::UNPROCESSABLE_ENTITY);
    };
    let refused = |error: &str, status: StatusCode, values: Values| {
        let screen = Screen { owner: Some(owner.clone()), read: None, values, error: Some(error.to_owned()), unavailable: false };
        render(&req, viewer, &screen, status)
    };
    let Some(input) = values.input().filter(|_| exact) else {
        return refused(t.invalid(), StatusCode::UNPROCESSABLE_ENTITY, values);
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.save_shipping_setup(&input, owner.guest()).await {
        Ok(_) => req.redirect(&url::ShippingSetup),
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) if owner == Owner::Account => sign_in(&req),
            Some(StatusCode::BAD_REQUEST) => refused(t.invalid(), StatusCode::UNPROCESSABLE_ENTITY, values),
            status => {
                log(&error);
                let status = if status.is_some_and(|s| s.is_client_error()) {
                    StatusCode::UNPROCESSABLE_ENTITY
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                };
                refused(t.save_error(), status, values)
            }
        },
    }
}

fn log(error: &ApiError) {
    tracing::warn!("the shipping setup was not saved: {error}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::{Values as Sent, put};

    fn raw(pairs: &[(&str, &str)]) -> Raw {
        let mut raw = Raw::new();
        for (k, v) in pairs {
            put(&mut raw, (*k).to_owned(), (*v).to_owned());
        }
        raw
    }

    const FULL: [(&str, &str); 8] = [
        ("name", " Ash Ketchum "),
        ("line1", "1 Pallet Rd"),
        ("line2", "  "),
        ("city", "Pallet"),
        ("state", "KS"),
        ("postalCode", "66002"),
        ("country", "us"),
        ("labelPreference", "seller-label-later"),
    ];

    #[test]
    fn a_full_form_is_sent_trimmed_with_its_country_in_capitals_and_no_empty_line_2() {
        let (values, exact) = Values::read(&raw(&FULL));
        assert!(exact);
        let input = values.input().expect("the form is complete");
        assert_eq!(input.origin.name, "Ash Ketchum");
        assert_eq!(input.origin.line2, None);
        assert_eq!(input.origin.country, "US");
        assert_eq!(input.label_preference, LATER);
    }

    #[test]
    fn a_form_with_a_field_it_does_not_know_twice_or_missing_is_not_exact() {
        let mut extra = raw(&FULL);
        put(&mut extra, "owner".into(), "acc_other".into());
        assert!(!Values::read(&extra).1, "an extra field");
        let mut twice = raw(&FULL);
        put(&mut twice, "city".into(), "Viridian".into());
        let (values, exact) = Values::read(&twice);
        assert!(!exact, "a field twice");
        assert_eq!(values.city, "Pallet", "the first is kept to show back");
        let missing = raw(&FULL[..7]);
        assert!(!Values::read(&missing).1, "a field missing");
        assert!(matches!(raw(&FULL).get("city"), Some(Sent::One(_))));
    }

    #[test]
    fn fulfillments_rules_refuse_a_blank_a_long_or_an_unknown_preference() {
        let (values, _) = Values::read(&raw(&FULL));
        assert!(Values { state: "  ".into(), ..values.clone() }.input().is_none());
        assert!(Values { line2: "x".repeat(201), ..values.clone() }.input().is_none());
        assert!(Values { city: "x".repeat(200), ..values.clone() }.input().is_some());
        assert!(Values { label_preference: "carrier-pickup".into(), ..values }.input().is_none());
    }

    fn viewer(role: &str, session: &str) -> Viewer {
        let actor = platform::api::Actor {
            user_id: "usr_1".into(),
            account_id: "acc_1".into(),
            role_key: role.into(),
            permissions: vec![],
            session_id: session.into(),
            agent: false,
        };
        Viewer { actor, color_mode: Default::default() }
    }

    #[test]
    fn a_guest_checkouts_session_or_role_is_not_an_account() {
        let none = HeaderMap::new();
        assert_eq!(owner(Some(&viewer("owner", "ses_1")), &none), Some(Owner::Account));
        assert_eq!(owner(Some(&viewer("owner", "guest:gco_1")), &none), None);
        assert_eq!(owner(Some(&viewer("guest-buyer", "ses_1")), &none), None);
        let mut sell_list = HeaderMap::new();
        sell_list.insert(corten::http::header::COOKIE, "chase_sets_anonymous_sell_list=anon_1".parse().unwrap());
        assert_eq!(owner(Some(&viewer("guest-buyer", "guest:gco_1")), &sell_list), Some(Owner::Guest("anon_1".into())));
        assert_eq!(owner(None, &sell_list), Some(Owner::Guest("anon_1".into())));
    }

    #[test]
    fn a_guest_sell_list_is_an_anon_id_of_at_most_160_safe_characters() {
        assert!(guest_sell_list("anon_abc-1_2"));
        assert!(!guest_sell_list("anon_"));
        assert!(!guest_sell_list("anon_a b"));
        assert!(!guest_sell_list("acc_1"));
        assert!(guest_sell_list(&format!("anon_{}", "a".repeat(155))));
        assert!(!guest_sell_list(&format!("anon_{}", "a".repeat(156))));
    }
}
