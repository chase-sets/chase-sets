//! Commerce's operator pages: Commerce > Return Intake ([`intake`]), Recovered Returns
//! ([`recovered`]), Commercial Terms ([`terms`]) and Money Health and Payout Operations
//! ([`payouts`]) and the Wallet Workbench ([`wallet`]); Postage Policies is the app's own area (`crate::app`).
use corten::i18n::Currency;

use crate::text::Com;

pub mod intake;
pub mod payouts;
pub mod recovered;
pub mod terms;
pub mod views;
pub mod wallet;

/// An amount in US dollars (admin-web's `formatMoney(value, "USD")`), or the API's text.
pub fn usd(t: Com, amount: &str) -> String {
    money(t, amount, "USD")
}

/// An amount in `currency` (admin-web's `formatMoney(value, currency)`; `usd` is USD), or the
/// API's text.
pub fn money(t: Com, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), Currency::parse(currency)) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => amount.to_owned(),
    }
}

/// Basis points as a percentage (`formatBpsPercent`): at most two decimals, no trailing zeros.
pub fn percent(bps: i64) -> String {
    let sign = if bps < 0 { "-" } else { "" };
    let bps = bps.unsigned_abs();
    let (whole, fraction) = (bps / 100, bps % 100);
    if fraction == 0 {
        format!("{sign}{whole}%")
    } else {
        format!("{sign}{whole}.{}%", format!("{fraction:02}").trim_end_matches('0'))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn basis_points_read_as_formatbpspercent() {
        assert_eq!(super::percent(850), "8.5%");
        assert_eq!(super::percent(500), "5%");
        assert_eq!(super::percent(1234), "12.34%");
        assert_eq!(super::percent(5), "0.05%");
    }
}
