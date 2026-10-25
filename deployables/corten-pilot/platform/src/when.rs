//! A time as Chase Sets shows one (`formatDateTime` in contracts/localization/date-time.ts):
//! `Mar 22, 2026, 12:00 PM UTC`, in UTC, the raw text when it cannot be read.
//!
//! Workaround for todd-skelton/corten#60: Corten has no way to write a date and time in the
//! request's locale, so this writes the one locale the pilot's catalogs have (`en`). Remove it
//! when Corten can.
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// An API timestamp: RFC 3339 (`2026-03-22T12:00:00.000Z`), or Postgres' `timestamptz` text
/// (`2026-03-22 12:00:00+00`), which the read models also send.
fn parse(value: &str) -> Option<OffsetDateTime> {
    if let Ok(at) = OffsetDateTime::parse(value, &Rfc3339) {
        return Some(at);
    }
    let mut text = value.trim().replacen(' ', "T", 1);
    // `+00` is `+00:00`.
    let zone = text.rfind(['+', '-']).filter(|at| *at > 10)?;
    if text.len() - zone == 3 {
        text.push_str(":00");
    }
    OffsetDateTime::parse(&text, &Rfc3339).ok()
}

/// The instant an API timestamp names, for ordering; `None` when it is not a time.
pub fn instant(value: &str) -> Option<OffsetDateTime> {
    parse(value)
}

/// `value` as `Mar 22, 2026, 12:00 PM UTC`, or `value` itself when it is not a time.
pub fn date_time(value: &str) -> String {
    let Some(at) = parse(value) else {
        return value.to_owned();
    };
    let at = at.to_offset(UtcOffset::UTC);
    let hour = match at.hour() % 12 {
        0 => 12,
        h => h,
    };
    let half = if at.hour() < 12 { "AM" } else { "PM" };
    let month = MONTHS[usize::from(u8::from(at.month())) - 1];
    format!("{month} {}, {}, {hour}:{:02} {half} UTC", at.day(), at.year(), at.minute())
}

#[cfg(test)]
mod tests {
    use super::date_time;

    #[test]
    fn a_time_is_written_as_chase_sets_writes_it() {
        assert_eq!(date_time("2026-03-22T12:00:00.000Z"), "Mar 22, 2026, 12:00 PM UTC");
        assert_eq!(date_time("2026-02-23T21:26:00.000Z"), "Feb 23, 2026, 9:26 PM UTC", "formatDateTime's own test");
        assert_eq!(date_time("2026-01-05T00:05:00Z"), "Jan 5, 2026, 12:05 AM UTC");
        assert_eq!(date_time("2026-03-22 12:00:00+00"), "Mar 22, 2026, 12:00 PM UTC", "timestamptz text");
        assert_eq!(date_time("2026-03-22T07:00:00-05:00"), "Mar 22, 2026, 12:00 PM UTC", "in UTC");
        assert_eq!(date_time("not a time"), "not a time");
    }
}
