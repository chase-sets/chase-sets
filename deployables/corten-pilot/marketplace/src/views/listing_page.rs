//! A listing's public page, after discovery's `routes/public-listing.tsx`: the status, the item,
//! its product's options and price; the purchase panel (`ListingPurchasePanel`) with Buy this
//! listing and Compare market; the seller (`AccountTrustCard`); and Report Listing. One column,
//! two from 64rem. A seller away or at capacity shows a warning, and the page offers no Buy.
use corten::prelude::*;

use super::{purchase_limit, set_page::long_date};
use crate::{
    api::PublicListing,
    app::url,
    items::{Address, available},
    public_listing::{ListingFields, MOST_DETAILS, REASONS, can_purchase},
    text::{ListingMsg, Pilot},
};

/// What happened to a form the page was sent from.
#[derive(Clone, Debug)]
pub enum ListingNotice {
    /// The report was received (`?reported=1`).
    Received,
    /// The reporter had reported the listing already.
    Repeat,
    /// Too many reports in a short time.
    Limited,
    /// The report was refused, with what was sent.
    ReportRefused { message: String, reason: String, details: String },
    /// Buy this listing was refused.
    BuyRefused(String),
}

/// The listing's price (`formatMoney`), or "Market price unavailable" without a currency.
pub fn listing_price(t: ListingMsg, listing: &PublicListing) -> String {
    let l = &listing.listing;
    match (l.price_currency_code.as_deref(), platform::money::decimal(&l.price_amount)) {
        (Some(code), Some(amount)) => match corten::i18n::Currency::parse(code.trim()) {
            Some(currency) => t.money(amount, currency).to_string(),
            None => format!("{} {}", l.price_amount, code.trim().to_ascii_uppercase()),
        },
        (Some(code), None) => format!("{} {}", l.price_amount, code.trim().to_ascii_uppercase()),
        (None, _) => t.price_unavailable().to_owned(),
    }
}

/// Why a listing shows but cannot be bought (`sellerUnbuyableMessage`): its seller is away (with
/// the day they return, when known) or at capacity. Away comes first.
pub fn unbuyable(t: ListingMsg, listing: &PublicListing) -> Option<(String, String)> {
    if listing.seller_listing_availability_status.as_deref() == Some("unavailable") {
        let until = listing.seller_available_again_at.as_deref().and_then(long_date);
        let description = match until {
            Some(date) => t.page_seller_away_until(&date).to_string(),
            None => t.page_seller_listings_unavailable().to_owned(),
        };
        return Some((t.page_seller_away().to_owned(), description));
    }
    listing.listing.seller_at_capacity.then(|| (t.page_at_capacity().to_owned(), t.page_at_capacity_description().to_owned()))
}

/// Where the listing ships from (`buyerFulfillmentLabel`), by its location's code.
pub fn fulfillment(t: ListingMsg, code: Option<&str>) -> String {
    let code = code.map(str::trim).filter(|c| !c.is_empty()).map(str::to_ascii_uppercase);
    match code.as_deref() {
        None => t.page_fulfillment_confirmed_at_checkout().to_owned(),
        Some(c) if c.starts_with("STL") => t.page_ships_from_location("St. Louis, MO").to_string(),
        Some(c) if c.starts_with("CHI") => t.page_ships_from_location("Chicago, IL").to_string(),
        Some(_) => t.page_seller_fulfillment_center().to_owned(),
    }
}

/// A count with its thousands grouped, as `toLocaleString` writes it in English.
pub fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, d) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(d);
    }
    out
}

/// Basis points as a percent with at most two decimals (`formatBpsPercent`): 500 is 5%.
pub fn bps_percent(bps: u64) -> String {
    let (whole, part) = (bps / 100, bps % 100);
    match part {
        0 => format!("{}%", grouped(whole)),
        p if p.is_multiple_of(10) => format!("{}.{}%", grouped(whole), p / 10),
        p => format!("{}.{p:02}%", grouped(whole)),
    }
}

/// A product's options from its summary (`productOptionsFromSummary`): each part's value.
pub fn options(summary: Option<&str>) -> Vec<String> {
    summary
        .unwrap_or("")
        .split(['|', '/', ',', '\u{2022}'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|part| match part.split_once(':') {
            Some((_, value)) if !value.trim().is_empty() => value.trim().to_owned(),
            _ => part.to_owned(),
        })
        .collect()
}

/// The page.
#[component(css)]
pub fn ListingPage<'a>(t: ListingMsg, p: Pilot, listing: &'a PublicListing, notice: Option<&'a ListingNotice>) -> impl Render {
    let l = &listing.listing;
    let can = can_purchase(listing);
    let active = l.status == "active" && can;
    let title = listing.item_title.as_deref().unwrap_or(t.page_marketplace_listing());
    let subtitle = listing.item_subtitle.as_deref().unwrap_or(t.page_marketplace_listing());
    let seller = l.seller_display_name.as_deref().unwrap_or(t.page_seller());
    let price = listing_price(t, listing);
    let chips = options(l.product_summary.as_deref());
    let unbuyable = unbuyable(t, listing);
    let availability = t.page_available_quantity(grouped(available(l))).to_string();
    let availability_copy =
        if can { availability.clone() } else { unbuyable.as_ref().map_or(availability.clone(), |(_, d)| d.clone()) };
    let limit = purchase_limit(l);
    let fulfillment = fulfillment(t, listing.ship_from_code.as_deref());
    let verified = if active { t.page_verified_seller() } else { t.page_seller_details_visible() };
    let tone = if active { "success" } else { "neutral" };
    let item_slug = listing.catalog_item_slug.as_deref().filter(|s| !s.is_empty()).unwrap_or(&l.catalog_catalog_item_id);
    let market = url::Item { slug: item_slug, state: Address::default(), after: Default::default() }.href();
    let account = l.seller_slug.as_deref().filter(|s| !s.is_empty()).map(crate::accounts::feedback);
    let buy = url::PublicListingBuy { slug: &listing.listing_slug }.href();
    let report = url::PublicListingReport { slug: &listing.listing_slug }.href();
    let policy = match (&limit, can) {
        (Some(limit), true) => format!("{availability} | {limit}"),
        _ => availability_copy.clone(),
    };
    let credit = if listing.shipping_allowance_percentage_bps > 0 {
        bps_percent(listing.shipping_allowance_percentage_bps)
    } else {
        t.page_none().to_owned()
    };
    html! {
        <div class={Page}>
            <header class={Head}>
                <span class={Badge} data-tone={tone}>{if can { l.status.as_str() } else { t.page_unavailable() }}</span>
                <h1 class={Title}>{title}</h1>
                <p class={Subtitle}>{subtitle}</p>
                <Options t={t} chips={&chips} />
                <p class={Muted}>{&price}" from "{seller}</p>
                if let Some((heading, description)) = &unbuyable {
                    <div class={Banner} data-tone="warning">
                        <p class={BannerTitle}>{heading}</p>
                        <p>{description}</p>
                    </div>
                }
                if let Some(ListingNotice::BuyRefused(message)) = notice {
                    <div class={Banner} data-tone="danger" role="alert"><p>{message}</p></div>
                }
            </header>
            <div class={Columns}>
                <div class={Column}>
                    <section class={Card} aria-labelledby="listing-buy-heading">
                        <h2 id="listing-buy-heading" class={CardTitle}>{t.page_ready_to_buy_this_listing()}</h2>
                        <p class={Muted}>{t.page_secure_checkout_reassurance()}</p>
                        <div>
                            <p class={PriceLabel}>{p.listing_price()}</p>
                            <p class={Price}>{&price}</p>
                        </div>
                        <dl class={Facts} data-boxed="">
                            <div>
                                <dt>{p.listing_seller()}</dt>
                                <dd class={Seller}>
                                    <Rating
                                        name={seller}
                                        href={account.as_deref()}
                                        rating={l.seller_average_rating.as_deref()}
                                        reviews={l.seller_review_count}
                                    />
                                    <span class={Badge} data-tone={tone}>{verified}</span>
                                </dd>
                            </div>
                            <div>
                                <dt>{t.page_availability()}</dt>
                                <dd>{&availability_copy}</dd>
                            </div>
                            <div>
                                <dt>{t.page_fulfillment()}</dt>
                                <dd>{&fulfillment}</dd>
                            </div>
                            <div>
                                <dt>{p.listing_returns()}</dt>
                                <dd>{t.page_returns_reviewed_before_payment()}</dd>
                            </div>
                            <div>
                                <dt>{p.listing_protection()}</dt>
                                <dd>{t.page_buyer_protected()}</dd>
                            </div>
                        </dl>
                        <div class={Actions}>
                            if can {
                                <form method="post" action={&buy}>
                                    {SubmitKey::field(ListingFields::FIELDS.attempt)}
                                    <button type="submit" class={Primary}>{t.page_buy_this_listing()}</button>
                                </form>
                            }
                            <a class={Secondary} href={&market}>{t.page_compare_market()}</a>
                        </div>
                    </section>
                    if let Some(limit) = &limit {
                        <span class={Badge}>{limit}</span>
                    }
                </div>
                <div class={Column}>
                    <section class={Card} aria-labelledby="listing-seller-heading">
                        <div class={SellerHead}>
                            <div class={SellerName}>
                                <h2 id="listing-seller-heading" class={CardTitle}>{seller}</h2>
                                if active {
                                    <span class={Badge} data-tone="success">{t.page_verified_seller()}</span>
                                }
                                <Rating
                                    name=""
                                    href={None}
                                    rating={l.seller_average_rating.as_deref()}
                                    reviews={l.seller_review_count}
                                />
                            </div>
                            if let Some(account) = &account {
                                <a class={Secondary} href={account}>{t.page_view_seller()}</a>
                            }
                        </div>
                        <ul class={Tiles}>
                            <li>
                                <span class={Muted}>{p.listing_completed()}</span>
                                <span class={Strong}>{t.page_active_listing()}</span>
                            </li>
                            <li><span class={Muted}>{t.page_ships_from()}</span><span class={Strong}>{&fulfillment}</span></li>
                        </ul>
                        <dl class={Facts}>
                            <div>
                                <dt>{t.page_availability()}</dt>
                                <dd>{&policy}</dd>
                            </div>
                            <div>
                                <dt>{t.page_shipping_credit()}</dt>
                                <dd>{&credit}</dd>
                            </div>
                            <div>
                                <dt>{t.page_product()}</dt>
                                <dd><Options t={t} chips={&chips} /></dd>
                            </div>
                        </dl>
                    </section>
                    <ReportForm t={t} p={p} action={&report} notice={notice} />
                </div>
            </div>
        </div>
    }
}

/// The product's options as chips (`ProductOptions`), or Standard without any.
#[component(css = ListingPage)]
fn Options<'a>(t: ListingMsg, chips: &'a [String]) -> impl Render {
    html! {
        if chips.is_empty() {
            <span class={Chip}>{t.page_standard()}</span>
        } else {
            <span class={Chips}>
                for chip in chips {
                    <span class={Chip}>{chip}</span>
                }
            </span>
        }
    }
}

/// A seller's name (a link to their feedback, when there is one) and rating
/// (`AccountReputationSummary`); the rating alone when `name` is empty.
#[component(css = ListingPage)]
fn Rating<'a>(name: &'a str, href: Option<&'a str>, rating: Option<&'a str>, reviews: u64) -> impl Render {
    let rating = rating.and_then(|r| r.trim().parse::<f64>().ok()).filter(|r| r.is_finite());
    html! {
        <span class={Who}>
            if !name.is_empty() {
                match href {
                    Some(href) => { <a class={Strong} href={href}>{name}</a> }
                    None => { <span class={Strong}>{name}</span> }
                }
            }
            if let Some(r) = rating {
                <span class={Muted}>
                    <span aria-hidden="true">"\u{2605}"</span> " " {format!("{r:.1}")} " " {format!("({reviews})")}
                </span>
            }
        </span>
    }
}

/// Report Listing: the reason and details, or, once sent, that it was received.
#[component(css = ListingPage)]
fn ReportForm<'a>(t: ListingMsg, p: Pilot, action: &'a str, notice: Option<&'a ListingNotice>) -> impl Render {
    let labels = [
        t.page_report_reason_counterfeit(),
        t.page_report_reason_stolen_photos(),
        t.page_report_reason_prohibited(),
        t.page_report_reason_pricing_scam(),
        t.page_report_reason_other(),
    ];
    let (reason, details) = match notice {
        Some(ListingNotice::ReportRefused { reason, details, .. }) => (reason.as_str(), details.as_str()),
        _ => ("", ""),
    };
    let max = MOST_DETAILS.to_string();
    html! {
        <section class={Report} aria-labelledby="listing-report-heading">
            <h2 id="listing-report-heading" class={SectionTitle}>{t.page_report_title()}</h2>
            match notice {
                Some(ListingNotice::Received) => {
                    <div class={Banner} data-tone="success" role="status"><p>{p.listing_report_received()}</p></div>
                }
                Some(ListingNotice::Repeat) => {
                    <div class={Banner} data-tone="info" role="status"><p>{p.listing_report_repeat()}</p></div>
                }
                _ => {
                    if let Some(ListingNotice::Limited) = notice {
                        <div class={Banner} data-tone="warning" role="alert"><p>{p.listing_report_limited()}</p></div>
                    }
                    if let Some(ListingNotice::ReportRefused { message, .. }) = notice {
                        <div class={Banner} data-tone="danger" role="alert"><p>{message}</p></div>
                    }
                    <form class={Form} method="post" action={action}>
                        <label class={Field}>
                            <span>{t.page_report_reason()}<span class={Required} aria-hidden="true">" *"</span></span>
                            <select name={ListingFields::FIELDS.reason} required>
                                for (value, label) in REASONS.iter().zip(labels) {
                                    <option value={*value} selected={reason == *value}>{label}</option>
                                }
                            </select>
                        </label>
                        <label class={Field}>
                            <span>{t.page_report_details()}</span>
                            <textarea name={ListingFields::FIELDS.details} rows="3" maxlength={&max}>{details}</textarea>
                        </label>
                        <p><button type="submit" class={Secondary}>{t.page_report_submit()}</button></p>
                    </form>
                }
            }
        </section>
    }
}

#[cfg(test)]
mod tests {
    use super::{bps_percent, grouped, options};

    #[test]
    fn numbers_and_options_are_written_as_marketplace_writes_them() {
        assert_eq!((grouped(1), grouped(1234), grouped(1_000_000)), ("1".into(), "1,234".into(), "1,000,000".into()));
        assert_eq!(
            (bps_percent(500), bps_percent(250), bps_percent(1), bps_percent(10_000)),
            ("5%".into(), "2.5%".into(), "0.01%".into(), "100%".into())
        );
        assert_eq!(options(Some("Form: graded | Grading Company: psa | Grade: nm-mt-8")), ["graded", "psa", "nm-mt-8"]);
        assert!(options(None).is_empty());
    }
}
