//! A time series drawn on the server as SVG, after the design system's `TimeSeriesChart`: the
//! line through each dated value, a band from each period's low to its high, and a mark (with a
//! `<title>`) on the points that have one, in a 640 by 220 box that scales with its width and
//! scrolls in its box below 480 px. No script, so nothing fades in. The words (the label, the
//! screen-reader summary and each mark's title) are the caller's, in its own catalog.
use corten::prelude::*;

const WIDTH: f64 = 640.0;
const HEIGHT: f64 = 220.0;
const PAD: f64 = 12.0;

/// One period: its first day (`YYYY-MM-DD`), its value on the line, its low and high for the
/// band, and a mark's title.
pub struct Point<'a> {
    pub day: &'a str,
    pub value: Option<f64>,
    pub band: Option<(f64, f64)>,
    pub mark: Option<String>,
}

/// A series as the chart draws it: nothing to plot, one dated value (a trend needs two, the
/// design system's `minimumSamples`), or the plot.
pub enum Chart {
    Empty,
    Insufficient,
    Plot(Plot),
}

/// The plot's geometry in the 640 by 220 box, and what a summary says of it.
pub struct Plot {
    line: String,
    band: Option<String>,
    marks: Vec<(String, String, String)>,
    /// How many values the line joins, and the lowest and highest of them.
    pub count: usize,
    pub min: f64,
    pub max: f64,
}

impl Chart {
    /// The chart of `points`, in any order; a point whose day does not parse is left out.
    pub fn of(points: Vec<Point<'_>>) -> Chart {
        let mut dated: Vec<(f64, Point<'_>)> = points.into_iter().filter_map(|p| Some((day_number(p.day)?, p))).collect();
        dated.sort_by(|a, b| a.0.total_cmp(&b.0));
        let line: Vec<(f64, f64)> = dated.iter().filter_map(|(x, p)| Some((*x, p.value?))).collect();
        match line.len() {
            0 => return Chart::Empty,
            1 => return Chart::Insufficient,
            _ => {}
        }
        let band: Vec<(f64, f64, f64)> = dated.iter().filter_map(|(x, p)| p.band.map(|(lo, hi)| (*x, lo, hi))).collect();
        let days = dated.iter().filter(|(_, p)| p.value.is_some() || p.band.is_some()).map(|(x, _)| *x);
        let (x0, x1) = days.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)));
        let values = line.iter().map(|p| p.1).chain(band.iter().flat_map(|b| [b.1, b.2]));
        let (lo, hi) = pad_domain(values.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v))));
        let x = |v: f64| PAD + scale(v, x0, x1, 0.0, WIDTH - 2.0 * PAD);
        let y = |v: f64| PAD + scale(v, lo, hi, HEIGHT - 2.0 * PAD, 0.0);
        let at = |px: f64, py: f64| format!("{:.2},{:.2}", x(px), y(py));
        let path = line.iter().enumerate().map(|(i, p)| format!("{}{}", if i == 0 { "M" } else { "L" }, at(p.0, p.1)));
        let band = (!band.is_empty()).then(|| {
            let top = band.iter().enumerate().map(|(i, b)| format!("{}{}", if i == 0 { "M" } else { "L" }, at(b.0, b.2)));
            let bottom = band.iter().rev().map(|b| format!("L{}", at(b.0, b.1)));
            format!("{} Z", top.chain(bottom).collect::<Vec<_>>().join(" "))
        });
        let marks = dated
            .iter()
            .filter_map(|(px, p)| Some((format!("{:.2}", x(*px)), format!("{:.2}", y(p.value?)), p.mark.clone()?)))
            .collect();
        let (min, max) = line.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p.1), hi.max(p.1)));
        Chart::Plot(Plot { line: path.collect::<Vec<_>>().join(" "), band, marks, count: line.len(), min, max })
    }
}

/// A `YYYY-MM-DD` day as a number of days, the chart's time axis.
pub fn day_number(day: &str) -> Option<f64> {
    let mut parts = day.get(..10)?.splitn(3, '-').map(|p| p.parse::<i32>().ok());
    let (year, month, day) = (parts.next()??, parts.next()??, parts.next()??);
    let month = time::Month::try_from(u8::try_from(month).ok()?).ok()?;
    let date = time::Date::from_calendar_date(year, month, u8::try_from(day).ok()?).ok()?;
    Some(f64::from(date.to_julian_day()))
}

fn scale(value: f64, d0: f64, d1: f64, r0: f64, r1: f64) -> f64 {
    if d1 == d0 { (r0 + r1) / 2.0 } else { r0 + (value - d0) / (d1 - d0) * (r1 - r0) }
}

/// The value axis a little wider than the values (`padDomain` by 8%).
fn pad_domain((min, max): (f64, f64)) -> (f64, f64) {
    let span = max - min;
    let pad = if span == 0.0 { (max.abs() * 0.08).max(1.0) } else { span * 0.08 };
    (min - pad, max + pad)
}

/// The plot, named by `label` and described by `summary` (`summary_id`, one per chart on the
/// page). It scrolls inside its box below 480 px wide rather than squeezing.
#[component(css)]
pub fn TimeSeries<'a>(plot: &'a Plot, label: &'a str, summary: &'a str, summary_id: &'a str) -> impl Render {
    html! {
        <figure class={ChartBox}>
            <div class={ChartScroll}>
                <svg viewBox="0 0 640 220" role="img" aria-label={label} aria-describedby={summary_id} focusable="false">
                    if let Some(band) = &plot.band {
                        <path class={ChartBand} d={band}></path>
                    }
                    <path class={ChartLine} d={&plot.line}></path>
                    for (cx, cy, title) in &plot.marks {
                        <circle class={ChartMark} cx={cx} cy={cy} r="4"><title>{title}</title></circle>
                    }
                </svg>
            </div>
            <figcaption class={VisuallyHidden} id={summary_id}>{summary}</figcaption>
        </figure>
    }
}

#[cfg(test)]
mod tests {
    use super::{Chart, Point, day_number};

    fn point(day: &str, value: Option<f64>, band: Option<(f64, f64)>) -> Point<'_> {
        Point { day, value, band, mark: None }
    }

    #[test]
    fn two_dated_values_are_a_plot_and_fewer_are_not() {
        assert!(matches!(Chart::of(vec![]), Chart::Empty));
        assert!(matches!(Chart::of(vec![point("2026-03-01", None, Some((1.0, 2.0)))]), Chart::Empty));
        assert!(matches!(Chart::of(vec![point("2026-03-01", Some(1.0), None)]), Chart::Insufficient));
        assert!(matches!(
            Chart::of(vec![point("nope", Some(1.0), None), point("2026-03-01", Some(2.0), None)]),
            Chart::Insufficient
        ));
        let Chart::Plot(plot) =
            Chart::of(vec![point("2026-03-02", Some(4.0), Some((3.0, 5.0))), point("2026-03-01", Some(2.0), None)])
        else {
            panic!("a plot");
        };
        assert_eq!((plot.count, plot.min, plot.max), (2, 2.0, 4.0));
        // Sorted by day: the line starts at the left edge, at the lower value.
        assert!(plot.line.starts_with("M12.00,"), "{}", plot.line);
        assert!(plot.band.as_deref().is_some_and(|b| b.ends_with(" Z")));
    }

    #[test]
    fn a_day_is_its_julian_day_and_a_timestamp_is_its_day() {
        assert_eq!(day_number("2026-03-02").unwrap() - day_number("2026-03-01").unwrap(), 1.0);
        assert_eq!(day_number("2026-03-02T11:35:00.000Z"), day_number("2026-03-02"));
        assert_eq!(day_number("2026-13-01"), None);
    }
}
