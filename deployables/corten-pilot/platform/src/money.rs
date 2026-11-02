//! An amount as the Checkout and Inventory APIs send it (`@chase-sets/primitives/money`): decimal
//! text with at most two fraction digits, read as cents without a float. Corten writes it in the
//! request's locale (`t.money`, since todd-skelton/corten#63); this is only Chase Sets' rule for
//! what an amount is.
use corten::i18n::Decimal;

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

/// An amount as `t.money` takes it, when it is one (`cents`).
pub fn decimal(amount: &str) -> Option<Decimal> {
    cents(amount).map(|c| Decimal::new(i128::from(c), 2))
}

#[cfg(test)]
mod tests {
    use super::{cents, decimal};

    #[test]
    fn an_amount_is_cents_as_the_money_primitive_reads_it() {
        assert_eq!(cents("21.50"), Some(2150));
        assert_eq!(cents(" 7 "), Some(700));
        assert_eq!(cents("-0.5"), Some(-50));
        assert_eq!(cents("9999999999.99"), Some(999_999_999_999));
        for bad in ["", "1.234", "1.", ".5", "1e3", "+1", "10000000000.00", "--1", "1,000"] {
            assert_eq!(cents(bad), None, "{bad}");
        }
        assert_eq!(decimal("12.3").map(|d| d.to_string()).as_deref(), Some("12.30"));
    }
}
