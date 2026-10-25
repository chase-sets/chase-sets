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
    app::url,
    auth::{Session, Viewer},
    cart::CartScreen,
    form::LocationInput,
    locations::Screen,
    recovery::{Check, Status},
    restock::RestockScreen,
    text::{CartMsg, Msg, Pilot, Restock},
};

mod cart_item;
mod decision_card;
mod location_card;
mod market_nav;
mod page_actions;
mod recovery;

pub use cart_item::{
    CartHeading, CartIssue, CartItem, CartList, CartNotice, CartStack, CartTotals, CheckoutBar, CheckoutForm, CheckoutLink,
    EmptyCart, Reputation,
};
pub use decision_card::{Decided, DecisionCard, DecisionDraft, DecisionList, NoDecisions, RestockForm, WriteOffForm};
pub use location_card::{ArchiveForm, CardList, CreateForm, LocationCard, UpdateForm};
pub use market_nav::MarketNav;
pub use page_actions::PageActions;
pub use recovery::{Notice, Recovery, WriteForm, handlers};

/// Every component with a stylesheet or a script that pages in both areas render, tokens first.
pub const COMPONENTS: &[Component] = &[theme::TOKENS, MarketNav, Section];

/// The inventory screens' components (`/account/inventory`).
pub const INVENTORY: &[Component] = &[PageActions, Recovery, handlers::COMPONENT, LocationCard, DecisionCard];

/// The cart's components (`/account/cart`).
pub const CART: &[Component] = &[CartItem];

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
        Some(Session::Account(viewer)) => Some(viewer.clone()),
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

/// A page that could not be drawn: its title and what to do.
pub fn failed<'a>(title: &'a str, text: &'a str) -> impl Render + 'a {
    html! {
        <h1>{title}</h1>
        <p>{text}</p>
    }
}

/// The page: what the last write did, the create form and every location.
pub fn page<'a>(
    t: Msg,
    p: Pilot,
    viewer: &'a Viewer,
    screen: &'a Screen,
    again: &'a url::Locations,
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
    let create = draft_for(Which::Create, &LocationInput::blank);
    let cards: Vec<_> = screen
        .locations
        .iter()
        .map(|location| {
            let id = &location.storage_location_id;
            let update = draft_for(Which::Update(id.clone()), &|| LocationInput::of(location));
            let archive = draft_for(Which::Archive(id.clone()), &|| LocationInput::of(location));
            (location, update, archive)
        })
        .collect();
    html! {
        <PageHeader
            eyebrow={t.page_seller()}
            title={t.page_storage_locations()}
            description={t.page_map_seller_defined_storage_areas_to()}
        />
        <PageActions label={t.page_back_to_inventory()} />
        <Recovery
            t={t}
            viewer={viewer}
            status={&screen.status}
            check={&again.check}
            again={&again.href()}
            list={&url::Locations::default().href()}
        />
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
    let (list, check) = (url::Locations::default().href(), Check::default());
    html! {
        <Recovery t={t} viewer={viewer} status={status} check={&check} again={&list} list={&list} />
        match write {
            Which::Create => { <CreateForm t={t} viewer={viewer} draft={draft} enabled /> }
            Which::Update(id) => { <UpdateForm t={t} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
            Which::Archive(id) => { <ArchiveForm t={t} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
        }
    }
}

/// A refused restock decision: its form, drawn again with a new attempt, and the status that
/// settles the posted one.
#[derive(Clone)]
pub struct Posted {
    pub status: Status,
    pub which: Decided,
    pub draft: DecisionDraft,
}

/// The restock decisions page: what the last write did, and every pending decision.
pub fn restock_page<'a>(
    t: Restock,
    m: Msg,
    p: Pilot,
    viewer: &'a Viewer,
    screen: &'a RestockScreen,
    again: &'a url::Restock,
    posted: Option<Posted>,
) -> impl Render + 'a {
    let enabled = screen.status.writes();
    let draft_for = |form: Decided, version: u64| match &posted {
        Some(posted) if posted.which == form => posted.draft.clone(),
        _ => DecisionDraft::new(version),
    };
    let cards: Vec<_> = screen
        .decisions
        .iter()
        .map(|decision| {
            let id = &decision.decision_id;
            let restock = draft_for(Decided::Restock(id.clone()), decision.version);
            let write_off = draft_for(Decided::WriteOff(id.clone()), decision.version);
            (decision, restock, write_off)
        })
        .collect();
    html! {
        <PageHeader eyebrow={t.queue_seller()} title={t.queue_title()} description={t.queue_description()} />
        <PageActions label={t.queue_back_to_inventory()} />
        <Recovery
            t={m}
            viewer={viewer}
            status={&screen.status}
            check={&again.check}
            again={&again.href()}
            list={&url::Restock::default().href()}
        />
        if screen.pending {
            <Notice text={p.load_restock_pending()} />
        }
        <Section title={t.queue_pending()}>
            if cards.is_empty() && !screen.pending {
                <NoDecisions t={t} />
            } else {
                <DecisionList>
                    for (decision, restock, write_off) in &cards {
                        <DecisionCard
                            t={t}
                            m={m}
                            viewer={viewer}
                            decision={*decision}
                            restock={restock}
                            write_off={write_off}
                            enabled={enabled}
                        />
                    }
                </DecisionList>
            }
        </Section>
    }
}

/// A refused restock decision's patch: its form again, and a status that settles the attempt.
#[component]
pub fn RefusedDecision<'a>(
    t: Restock,
    m: Msg,
    viewer: &'a Viewer,
    which: &'a Decided,
    draft: &'a DecisionDraft,
    status: &'a Status,
) -> impl Render {
    let (list, check) = (url::Restock::default().href(), Check::default());
    html! {
        <Recovery t={m} viewer={viewer} status={status} check={&check} again={&list} list={&list} />
        match which {
            Decided::Restock(id) => { <RestockForm t={t} m={m} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
            Decided::WriteOff(id) => { <WriteOffForm t={t} m={m} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
        }
    }
}

/// The cart page (marketplace's `CheckoutCartPage`): its one notice, the lines, the totals and
/// the checkout bar, or the empty cart.
pub fn cart_page<'a>(t: CartMsg, _viewer: &'a Viewer, screen: &'a CartScreen, issue: Option<&'a str>) -> impl Render + 'a {
    let readiness = screen.readiness.as_ref();
    let money = |m: Option<&crate::api::Money>| match m {
        Some(m) => platform::money::amount(&m.amount, &m.currency),
        None => t.page_priced_at_checkout().to_owned(),
    };
    let total = money(readiness.and_then(|r| r.estimated_subtotal.as_ref()));
    let known = readiness.is_some_and(|r| r.estimated_subtotal.is_some());
    let savings = money(readiness.and_then(|r| r.savings.as_ref()));
    let needs_review = readiness.is_some() && !screen.lines.is_empty() && !screen.ready();
    let blocked = readiness.map_or(0, |r| r.blocked_line_count);
    let offered = screen.offered();
    let offered_seller = offered.and_then(|o| o.seller_display_name.as_deref().map(|name| crate::cart::Seller::of(name, o)));
    let offer_title = match &offered_seller {
        Some(seller) => t.page_optimization_switch_to_seller_title(&savings, seller.name).to_string(),
        None => t.page_optimization_available_title(&savings).to_string(),
    };
    let context = if screen.ready() || readiness.is_none() {
        t.page_taxes_and_shipping_calculated()
    } else {
        t.page_resolve_before_payment()
    };
    // Check out a ready cart as it is; a cart that is not ready continues to checkout to resolve it.
    let check_out = readiness.map(|r| &r.declined).filter(|s| s.status == "ready");
    let lower_price = readiness.and_then(|r| r.accepted.as_ref()).filter(|_| screen.offer());
    let (search, resolve) = (cart_item::link("/search"), cart_item::link("/checkout/buy/readiness"));
    html! {
        <PageHeader eyebrow={t.page_buy_cart()} title={t.page_your_cart()} description={t.page_simple_cart_description()} />
        <CartHeading title={t.page_items()} description={t.page_review_items_before_checkout()} />
        if let Some(issue) = issue {
            <CartIssue title={t.page_checkout_issue()} text={issue} />
        }
        if screen.lines.is_empty() {
            <EmptyCart t={t} />
        } else {
            <CartStack>
                if needs_review {
                    <CartNotice title={t.page_fulfillment_needs_review()} warning>
                        if blocked == 1 {
                            <p>{t.page_fulfillment_needs_review_description_one()}</p>
                        } else {
                            <p>{t.page_fulfillment_needs_review_description_many(blocked)}</p>
                        }
                    </CartNotice>
                } else if screen.offer() {
                    <CartNotice title={&offer_title} warning={false}>
                        <p>{t.page_optimization_available_description()}</p>
                        if let Some(seller) = &offered_seller {
                            <Reputation t={t} seller={seller} />
                        }
                    </CartNotice>
                }
                <CartList>
                    for line in &screen.lines {
                        <CartItem t={t} line={line} />
                    }
                </CartList>
                <CartTotals t={t} items={screen.item_count()} total={&total} known={known} />
                <CheckoutBar
                    t={t}
                    total={&total}
                    context={context}
                    primary={html! {
                        if let Some(snapshot) = check_out {
                            <CheckoutForm snapshot={snapshot} label={t.page_check_out()} primary />
                        } else {
                            <CheckoutLink href={&resolve} label={t.page_resolve_fulfillment()} primary />
                        }
                    }}
                    secondary={html! {
                        if let Some(snapshot) = lower_price {
                            <CheckoutForm snapshot={snapshot} label={t.page_use_lower_fulfillment()} primary={false} />
                        }
                        <CheckoutLink href={&search} label={t.page_keep_shopping()} primary={false} />
                    }}
                />
            </CartStack>
        }
    }
}
