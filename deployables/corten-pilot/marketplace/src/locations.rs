//! Inventory > Storage locations (marketplace's `/account/inventory/locations`): the list, create,
//! save and archive, each write confirmed by the list it redirects to (see `recovery`).
use crate::recovery::attempt_text;
use corten::{axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde::Serialize;

use crate::chrome::Chrome;
use crate::{
    api::{Inventory as _, Location},
    app::{Config, Shared, read_failed, sign_in, url},
    auth::{Seller, Viewer},
    form::LocationInput,
    recovery::{self, Check, Failed, Family, Status, failed},
    text::{Msg, Pilot},
    views::{self, Draft, Forms, Layout},
};

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct Screen {
    pub locations: Vec<Location>,
    /// The locations are not readable yet after a write (marketplace's `onPending`).
    pub pending: bool,
    pub status: Status,
}

/// The page for `query`, with `forms` in place of the forms' defaults.
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    query: &Check,
    forms: Forms,
    chrome: &Chrome,
) -> HtmlResult {
    let receipt = Receipt::from_param(query.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let status = async {
        if let Some(status) = &forms.status {
            return status.clone();
        }
        match &query.attempt {
            // The attempt's result is read as it is now, without waiting for a projection.
            Some(attempt) => {
                let caller = config.platform.caller(headers, config.proto, None);
                let (family, target, user) = (query.family, query.target.as_deref(), query.user.as_deref());
                recovery::check(&caller, &viewer.actor, attempt, family, target, user).await
            }
            None => Status::Ready,
        }
    };
    let (locations, status) = tokio::join!(caller.locations(), status);
    let (locations, pending) = match locations {
        Ok(list) => (list.items, false),
        // The write's projection is not readable yet: marketplace's pending answer, the page with
        // a message and no list (the receipt stays in the address for 30 seconds).
        Err(error) if receipt.is_some() && error.catching_up() => (Vec::new(), true),
        Err(error) => {
            return read_failed(
                req,
                Some(viewer),
                error,
                receipt.is_some().then(|| req.t::<Pilot>().load_unverified()),
                chrome.cart().await,
            );
        }
    };
    let screen = Screen { locations, pending, status };
    let t: Msg = req.t();
    let (title, head) = (t.route_title(), html! { <meta name="description" content={t.route_description()}> });
    // The status's "check again" link: the same check, without the receipt.
    let again = url::Locations { check: query.again() };
    let view = views::page(t, req.t(), viewer, &screen, &again, forms);
    let cart = chrome.cart().await;
    req.screen(&screen, html! { <Layout req={req} viewer={Some(viewer)} cart={cart} title={title} head={head}>{view}</Layout> })
}

pub(crate) async fn list(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::Locations>,
) -> HtmlResult {
    let query = route.check;
    render(&req, &viewer, &config, &headers, &query, Forms::default(), &chrome).await
}

/// Which write a form asks for.
enum Write {
    Create,
    Update(String),
    Archive(String),
}

impl Write {
    fn family(&self) -> Family {
        match self {
            Write::Create => Family::Create,
            Write::Update(_) => Family::Update,
            Write::Archive(_) => Family::Archive,
        }
    }

    /// The attempt's target, as the API keeps it: `draft` for a create, else the location.
    fn target(&self) -> &str {
        match self {
            Write::Create => "draft",
            Write::Update(id) | Write::Archive(id) => id,
        }
    }

    fn archived(&self) -> Option<bool> {
        match self {
            Write::Create => None,
            Write::Update(_) => Some(false),
            Write::Archive(_) => Some(true),
        }
    }
}

pub(crate) async fn create(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<LocationInput>,
) -> HtmlResult {
    write(&req, &viewer, &config, &headers, Write::Create, input, &chrome).await
}

pub(crate) async fn update(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::Location<'_>>,
    Form(input): Form<LocationInput>,
) -> HtmlResult {
    let id = route.id;
    write(&req, &viewer, &config, &headers, Write::Update(id), input, &chrome).await
}

pub(crate) async fn archive(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::Archive<'_>>,
    Form(input): Form<LocationInput>,
) -> HtmlResult {
    let id = route.id;
    write(&req, &viewer, &config, &headers, Write::Archive(id), input, &chrome).await
}

/// The list after a write the API applied: it waits for the write's projection and confirms the
/// attempt, so the browser forgets it.
fn applied(req: &Req, write: &Write, attempt: &str, receipt: Option<Receipt>) -> HtmlResult {
    req.redirect(&url::Locations { check: Check::applied(write.family(), write.target(), attempt, receipt.map(|r| r.param())) })
}

async fn write(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    write: Write,
    input: LocationInput,
    chrome: &Chrome,
) -> HtmlResult {
    let p: Pilot = req.t();
    let errors = match input.command(p, write.archived()) {
        Ok(command) => {
            let caller = config.platform.caller(headers, config.proto, None);
            let attempt = attempt_text(&input.attempt);
            let sent = match &write {
                Write::Create => caller.create_location(attempt, &command).await,
                Write::Update(id) | Write::Archive(id) => caller.update_location(attempt, id, &command).await,
            };
            match sent {
                Ok(written) => return applied(req, &write, attempt, written.receipt),
                Err(error) => match failed(&caller, write.family(), write.target(), attempt, error).await {
                    Failed::Refused(errors) => errors,
                    Failed::AppliedBefore => return applied(req, &write, attempt, None),
                    Failed::SignIn => return sign_in(req),
                    Failed::Unknown(error) => return Err(error),
                },
            }
        }
        Err(errors) => errors,
    };
    // Nothing was applied: the form again, drawn with a new attempt, and a status that settles
    // the posted one.
    let status = Status::Refused(attempt_text(&input.attempt).to_owned());
    // The form is drawn with a new SubmitKey; the posted attempt applied nothing.
    let draft = Draft { input, errors };
    let t: Msg = req.t();
    let patch = views::Refused { t, viewer, write: &write.view(), draft: &draft, status: &status };
    let forms = Forms { status: Some(status.clone()), draft: Some((write.view(), draft.clone())) };
    let page = Check::default();
    req.invalid(&draft.errors, patch, || render(req, viewer, config, headers, &page, forms, chrome)).await
}

impl Write {
    /// The form in the views.
    fn view(&self) -> views::Which {
        match self {
            Write::Create => views::Which::Create,
            Write::Update(id) => views::Which::Update(id.clone()),
            Write::Archive(id) => views::Which::Archive(id.clone()),
        }
    }
}
