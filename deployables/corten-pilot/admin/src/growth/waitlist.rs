//! Growth > Waitlist (admin-web's `/growth/waitlist`, Public Presence's `WaitlistAdminPage`): the
//! signups by role, the invite waves' fill, the filters, and the signups (100 at most, as admin-web
//! reads them), with a CSV export. Read from Public Presence's `/api/public-presence/admin/waitlist`
//! as the signed-in staff member, with `public-presence.view`.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /growth/waitlist?search&role&interest&sort` | the figures and the signups |
//! | `GET /growth/waitlist/export?search&role&interest&sort` | the signups as the API's CSV |
//!
//! admin-web's export link is the API's path on admin-web's host; the pilot relays the API's file
//! from its own route, as Platform Feedback's export does.
use corten::{
    Relay,
    axum::{
        body::Body,
        http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    },
    prelude::*,
};
use serde::{Deserialize, Serialize};

use super::views;
use crate::{
    api::{Method, segment},
    app::{Shared, read_failed, sign_in_at},
    auth::{GrowthView, Staff},
    text::Gro,
};

const CONTEXT: &str = "public-presence";
const BASE: &str = "/api/public-presence/admin/waitlist";

/// The roles and interests a filter may name, in admin-web's order (`all` is no filter).
pub const ROLES: [&str; 3] = ["buy", "sell", "both"];
pub const INTERESTS: [&str; 5] = ["low-sales-fees", "bulk-listing", "set-completion", "pricing-tools", "efficient-shipping"];
pub const SORTS: [&str; 2] = ["updated", "referrals"];

#[corten::routes(state = crate::app::Shared, area = crate::growth::waitlist::url::Waitlist, caller = crate::auth::Staff<crate::auth::GrowthView>)]
pub mod url {
    use corten::prelude::*;
    use serde::Deserialize;

    /// The filters: what the list and the export ask for.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct Filters {
        pub search: Option<String>,
        pub role: Option<String>,
        pub interest: Option<String>,
        pub sort: Option<String>,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/growth/waitlist", get = page)]
    pub struct Waitlist {
        #[route(query)]
        pub filters: Filters,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/growth/waitlist/export", get = export)]
    pub struct Export {
        #[route(query)]
        pub filters: Filters,
    }
}

/// The area: its routes and its stylesheet.
pub fn area(area: Area<url::Waitlist>, shared: Shared) -> Area<url::Waitlist> {
    url::area(area, shared).components(views::WAITLIST)
}

/// The filters as admin-web reads them: a role, interest or sort it does not offer is its default.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, ToJson)]
pub struct Chosen {
    pub search: String,
    pub role: &'static str,
    pub interest: &'static str,
    pub sort: &'static str,
}

fn one_of(asked: Option<&str>, values: &[&'static str], default: &'static str) -> &'static str {
    asked.and_then(|a| values.iter().copied().find(|v| *v == a)).unwrap_or(default)
}

impl Chosen {
    pub fn read(filters: &url::Filters) -> Chosen {
        Chosen {
            search: filters.search.as_deref().unwrap_or_default().to_owned(),
            role: one_of(filters.role.as_deref(), &ROLES, "all"),
            interest: one_of(filters.interest.as_deref(), &INTERESTS, "all"),
            sort: one_of(filters.sort.as_deref(), &SORTS, "updated"),
        }
    }

    /// The API's query: admin-web's `limit=100&offset=0`, then each filter not at its default.
    pub fn query(&self) -> String {
        let mut query = vec!["limit=100".to_owned(), "offset=0".to_owned()];
        let pairs = [
            ("role", self.role, "all"),
            ("interest", self.interest, "all"),
            ("search", self.search.as_str(), ""),
            ("sort", self.sort, "updated"),
        ];
        for (name, value, default) in pairs {
            if value != default {
                query.push(format!("{name}={}", segment(value)));
            }
        }
        query.join("&")
    }

    /// The same filters in the pilot's addresses.
    pub fn filters(&self) -> url::Filters {
        let kept = |value: &str, default: &str| (value != default).then(|| value.to_owned());
        url::Filters {
            search: kept(&self.search, ""),
            role: kept(self.role, "all"),
            interest: kept(self.interest, "all"),
            sort: kept(self.sort, "updated"),
        }
    }
}

/// A signup (`WaitlistSignupListItem`), as far as the page shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Signup {
    pub signup_id: String,
    pub email: String,
    pub role: String,
    #[serde(default)]
    pub interests: Vec<String>,
    pub page_path: String,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub utm_source: Option<String>,
    #[serde(default)]
    pub referred_by_signup_id: Option<String>,
    #[serde(default)]
    pub referral_count: u64,
    pub updated_at: String,
}

impl Signup {
    /// Where the signup came from: its UTM source, else its referrer, else its page.
    pub fn source(&self) -> &str {
        self.utm_source.as_deref().or(self.referrer.as_deref()).unwrap_or(&self.page_path)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Signups {
    pub items: Vec<Signup>,
    pub total: u64,
    pub count: u64,
}

/// An invite wave and how full it is.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Wave {
    pub wave_number: u8,
    pub admitted_count: u64,
    pub capacity: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Metrics {
    pub total_count: u64,
    pub buy_count: u64,
    pub sell_count: u64,
    pub both_count: u64,
    #[serde(default)]
    pub wave_fill: Vec<Wave>,
}

/// The page as drawn.
#[derive(Serialize, ToJson)]
pub struct WaitlistScreen {
    pub signups: Signups,
    pub metrics: Metrics,
    pub chosen: Chosen,
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<GrowthView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Waitlist>,
) -> HtmlResult {
    let chosen = Chosen::read(&route.filters);
    let caller = config.platform.caller(&headers, config.proto, None);
    let list = format!("{BASE}?{}", chosen.query());
    let metrics = format!("{BASE}/metrics");
    let (signups, metrics) =
        match tokio::try_join!(caller.read::<Signups>(&list, CONTEXT), caller.read::<Metrics>(&metrics, CONTEXT)) {
            Ok(found) => found,
            Err(error) => return read_failed(&req, error, false),
        };
    let screen = WaitlistScreen { signups, metrics, chosen };
    let t: Gro = req.t();
    let view = html! { <views::WaitlistPage t={t} screen={&screen} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.route_waitlist()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// The signups as the API's CSV, with its type and file name.
async fn export(
    req: Req,
    Caller(_): Caller<Staff<GrowthView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Export>,
) -> corten::Result<Relay> {
    let path = format!("{BASE}/export?{}", Chosen::read(&route.filters).query());
    let caller = config.platform.caller(&headers, config.proto, None);
    let res = caller
        .request(Method::GET, &path, CONTEXT)
        .send()
        .await
        .map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    match res.status().as_u16() {
        200..=299 => {}
        401 => {
            let to = sign_in_at(req.path()).ok_or_else(|| corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR))?;
            let mut kept = HeaderMap::new();
            kept.insert(header::LOCATION, HeaderValue::from_str(&to.to_string()).map_err(corten::Error::new)?);
            return Ok(Relay::new(StatusCode::SEE_OTHER, kept, Body::empty()));
        }
        403 => return Err(corten::Error::status(StatusCode::FORBIDDEN)),
        status => {
            tracing::warn!("the waitlist export answered {status}");
            return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
        }
    }
    let mut kept = HeaderMap::new();
    for name in ["content-type", "content-disposition"] {
        if let Some(value) = res.headers().get(name).and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
            kept.insert(HeaderName::from_static(name), value);
        }
    }
    // The file holds people's email addresses: no cache may keep it.
    kept.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let bytes = res.bytes().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    Ok(Relay::new(StatusCode::OK, kept, Body::from(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_filters_are_admin_webs_and_only_those_not_at_their_default_are_sent() {
        let asked = url::Filters {
            search: Some("a b@x".into()),
            role: Some("sell".into()),
            interest: Some("nonsense".into()),
            sort: Some("updated".into()),
        };
        let chosen = Chosen::read(&asked);
        assert_eq!((chosen.role, chosen.interest, chosen.sort), ("sell", "all", "updated"));
        assert_eq!(chosen.query(), "limit=100&offset=0&role=sell&search=a%20b%40x");
        assert_eq!(Chosen::read(&url::Filters::default()).query(), "limit=100&offset=0");
        let kept = chosen.filters();
        assert_eq!((kept.role.as_deref(), kept.interest, kept.sort), (Some("sell"), None, None));
    }
}
