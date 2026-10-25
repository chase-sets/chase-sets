//! Money as Chase Sets shows it (`formatMoney` in contracts/localization/money.ts, over the
//! `@chase-sets/primitives/money` decimal amounts): `$1,234.50`, the currency's symbol where
//! `en-US` has one and its code otherwise, the cents as the API sent them (never through a
//! float), and `<amount> <CODE>` for an amount that is not money.
//!
//! Workaround for todd-skelton/corten#63: Corten has no way to write an amount of money in the
//! request's locale, so this writes the one locale the pilot's catalogs have (`en`, as
//! marketplace-web's server writes it). Remove it when Corten can.

/// The most cents an amount may have (`MONEY_AMOUNT_MAX_CENTS`).
pub const MAX_CENTS: i64 = 999_999_999_999;

/// A signed decimal amount (`-12`, `12.3`, `12.34`) in cents, as `trySignedMoneyToCents` reads
/// one: at most two fraction digits and at most `MAX_CENTS`; `None` otherwise.
pub fn cents(amount: &str) -> Option<i64> {
    let text = amount.trim();
    let (negative, unsigned) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || (unsigned.contains('.') && !digits(fraction)) || fraction.len() > 2 {
        return None;
    }
    let whole: i64 = whole.parse().ok().filter(|w| *w <= MAX_CENTS / 100)?;
    let fraction: i64 = format!("{fraction:0<2}").parse().ok()?;
    let cents = whole * 100 + fraction;
    if cents > MAX_CENTS {
        return None;
    }
    Some(if negative { -cents } else { cents })
}

/// `en-US`'s sign for `code` before the digits: its symbol, or the code and a no-break space.
fn prefix(code: &str) -> String {
    let symbol = match code {
        "USD" => "$",
        "EUR" => "\u{20ac}",
        "GBP" => "\u{a3}",
        "JPY" => "\u{a5}",
        "CAD" => "CA$",
        "AUD" => "A$",
        "NZD" => "NZ$",
        "HKD" => "HK$",
        "MXN" => "MX$",
        "TWD" => "NT$",
        "BRL" => "R$",
        "CNY" => "CN\u{a5}",
        "INR" => "\u{20b9}",
        "KRW" => "\u{20a9}",
        "ILS" => "\u{20aa}",
        "PHP" => "\u{20b1}",
        _ => return format!("{code}\u{a0}"),
    };
    symbol.to_owned()
}

/// `cents` of `currency` as `-$1,234.50`.
pub fn from_cents(cents: i64, currency: &str) -> String {
    let code = currency.trim().to_ascii_uppercase();
    let sign = if cents < 0 { "-" } else { "" };
    let cents = cents.unsigned_abs();
    let whole = (cents / 100).to_string();
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (i, digit) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{sign}{}{grouped}.{:02}", prefix(&code), cents % 100)
}

/// A decimal `amount` of `currency` as Chase Sets shows it, or `<amount> <CODE>` when it is not
/// money.
pub fn amount(amount: &str, currency: &str) -> String {
    match cents(amount) {
        Some(cents) => from_cents(cents, currency),
        None => format!("{amount} {}", currency.trim().to_ascii_uppercase()).trim().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{amount, cents};

    /// formatMoney's own cases (contracts/localization/money.test.ts).
    #[test]
    fn money_is_written_as_chase_sets_writes_it() {
        assert_eq!(amount("145.00", "USD"), "$145.00");
        assert_eq!(amount("12.34", "usd"), "$12.34");
        assert_eq!(amount("12.3", "USD"), "$12.30");
        assert_eq!(amount("12", "USD"), "$12.00");
        assert_eq!(amount("1234567.89", "USD"), "$1,234,567.89");
        assert_eq!(amount("-42.50", "USD"), "-$42.50");
        assert_eq!(amount("0.00", "USD"), "$0.00");
        assert_eq!(amount("9999999999.99", "USD"), "$9,999,999,999.99");
        assert_eq!(amount("pending", "USD"), "pending USD");
        // Intl's en-US forms for other currencies.
        assert_eq!(amount("1234.5", "EUR"), "\u{20ac}1,234.50");
        assert_eq!(amount("1234.5", "CAD"), "CA$1,234.50");
        assert_eq!(amount("1234.5", "CHF"), "CHF\u{a0}1,234.50");
    }

    #[test]
    fn an_amount_is_cents_as_the_money_primitive_reads_it() {
        assert_eq!(cents("21.50"), Some(2150));
        assert_eq!(cents(" 7 "), Some(700));
        assert_eq!(cents("-0.5"), Some(-50));
        assert_eq!(cents("9999999999.99"), Some(999_999_999_999));
        for bad in ["", "1.234", "1.", ".5", "1e3", "+1", "10000000000.00", "--1", "1,000"] {
            assert_eq!(cents(bad), None, "{bad}");
        }
    }
}
