//! The screen's views. Each component's stylesheet (and the recovery script) is next to it in
//! `views/`; `static/style.css` has the element defaults and the shell's frame.
use corten::{
    Component,
    axum::http::{StatusCode, Uri},
    prelude::*,
};
use platform::{
    section::{PageHeader, Section},
    theme,
};

use crate::{
    app::{Screen, url},
    auth::{Session, Viewer},
    form::LocationInput,
    recovery::{Status, new_attempt},
    text::{Msg, Pilot},
};

mod location_card;
mod market_nav;
mod page_actions;
mod recovery;

pub use location_card::{ArchiveForm, CardList, CreateForm, LocationCard, UpdateForm};
pub use market_nav::MarketNav;
pub use page_actions::PageActions;
pub use recovery::{Notice, Recovery, WriteForm, handlers};

/// Every component with a stylesheet or a script, tokens first.
pub const COMPONENTS: &[Component] =
    &[theme::TOKENS, MarketNav, Section, PageActions, Recovery, handlers::COMPONENT, LocationCard];

/// A form's values and what is wrong with them.
#[derive(Clone, Debug)]
pub struct Draft {
    pub input: LocationInput,
    pub errors: Errors,
}

impl Draft {
    pub fn new(input: LocationInput) -> Self {
        Draft { input, errors: Errors::new() }
    }
}

/// Which form a refused write posted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Which {
    Create,
    Update(String),
    Archive(String),
}

/// What a refused write puts in place of the page's defaults: its form and its status.
#[derive(Default)]
pub struct Forms {
    pub status: Option<Status>,
    pub draft: Option<(Which, Draft)>,
}

/// A link to a marketplace page outside the pilot.
pub fn marketplace(path: &str) -> Option<Uri> {
    format!("{}{path}", crate::app::marketplace_origin()).parse().ok()
}

/// The document: marketplace's top bar, the user's color mode.
pub fn shell(doc: Document, session: Option<Session>) -> impl Render {
    let p: Pilot = doc.t();
    let viewer = match &session {
        Some(Session::Seller(viewer)) => Some(viewer.clone()),
        _ => None,
    };
    let theme = viewer.as_ref().and_then(|v| v.color_mode.theme());
    html! {
        <!DOCTYPE html>
        <html lang={doc.lang()} data-theme={theme}>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link
                    rel="preload"
                    as="font"
                    type="font/woff2"
                    crossorigin
                    href={doc.asset("fonts/ibm-plex-sans-latin-400-normal.woff2")}
                >
                <link rel="stylesheet" href={doc.asset("style.css")}>
                {doc.head}
                <script type="module" src={doc.asset("app.js")}></script>
            </head>
            <body>
                if let Some(viewer) = &viewer {
                    <MarketNav p={p} viewer={viewer} path={doc.path()} />
                }
                <main>{doc.main}</main>
            </body>
        </html>
    }
}

/// The error page, in the shell.
pub fn error_page(status: StatusCode) -> (Meta, impl Render) {
    let p = Pilot::default();
    let (title, text) = match status {
        StatusCode::FORBIDDEN => (p.error_forbidden_title(), p.error_forbidden()),
        StatusCode::NOT_FOUND => (p.error_not_found_title(), p.error_not_found()),
        StatusCode::CONFLICT => (p.error_failed_title(), p.load_unverified()),
        _ => (p.error_failed_title(), p.error_failed()),
    };
    (
        Meta::new(title),
        html! {
            <h1>{title}</h1>
            <p>{text}</p>
        },
    )
}

/// The page: what the last write did, the create form and every location.
pub fn page<'a>(
    t: Msg,
    p: Pilot,
    viewer: &'a Viewer,
    screen: &'a Screen,
    again: url::Locations,
    forms: Forms,
) -> impl Render + 'a {
    let enabled = screen.status.writes();
    let (which, posted) = match forms.draft {
        Some((which, draft)) => (Some(which), Some(draft)),
        None => (None, None),
    };
    let draft_for = |form: Which, fresh: &dyn Fn() -> LocationInput| match (&which, &posted) {
        (Some(w), Some(d)) if *w == form => d.clone(),
        _ => Draft::new(fresh()),
    };
    let create = draft_for(Which::Create, &|| LocationInput::blank(new_attempt()));
    let cards: Vec<_> = screen
        .locations
        .iter()
        .map(|location| {
            let id = &location.storage_location_id;
            let update = draft_for(Which::Update(id.clone()), &|| LocationInput::of(location, new_attempt()));
            let archive = draft_for(Which::Archive(id.clone()), &|| LocationInput::of(location, new_attempt()));
            (location, update, archive)
        })
        .collect();
    html! {
        <PageHeader
            eyebrow={t.page_seller()}
            title={t.page_storage_locations()}
            description={t.page_map_seller_defined_storage_areas_to()}
        />
        <PageActions t={t} />
        <Recovery t={t} viewer={viewer} status={&screen.status} again={&again} />
        if screen.pending {
            <Notice text={p.load_pending()} />
        }
        <Section title={t.page_create_location()}>
            <CreateForm t={t} viewer={viewer} draft={&create} enabled={enabled} />
        </Section>
        <Section title={t.page_current_locations()}>
            <CardList>
                for (location, update, archive) in &cards {
                    <LocationCard
                        t={t}
                        viewer={viewer}
                        location={*location}
                        update={update}
                        archive={archive}
                        enabled={enabled}
                    />
                }
            </CardList>
        </Section>
    }
}

/// A refused write's patch: its form again, and a status that settles the posted attempt.
#[component]
pub fn Refused<'a>(t: Msg, viewer: &'a Viewer, write: &'a Which, draft: &'a Draft, status: &'a Status) -> impl Render {
    let again = url::Locations::default();
    html! {
        <Recovery t={t} viewer={viewer} status={status} again={&again} />
        match write {
            Which::Create => { <CreateForm t={t} viewer={viewer} draft={draft} enabled /> }
            Which::Update(id) => { <UpdateForm t={t} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
            Which::Archive(id) => { <ArchiveForm t={t} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
        }
    }
}
