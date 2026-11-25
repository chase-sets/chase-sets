use corten::prelude::*;

/// The design system's numeric role, applied to the value rather than surrounding copy.
#[component(css)]
pub fn NumericValue(value: &str) -> impl Render {
    html! { <span class={Amount}>{value}</span> }
}

/// A price display keeps track of whether formatting succeeded, so fallback text never
/// inherits the numeric role and text-only destinations can keep the same copy.
pub enum MoneyDisplay {
    Formatted(String),
    Fallback(String),
}

impl MoneyDisplay {
    pub fn text(&self) -> &str {
        match self {
            Self::Formatted(text) | Self::Fallback(text) => text,
        }
    }

    pub fn into_text(self) -> String {
        match self {
            Self::Formatted(text) | Self::Fallback(text) => text,
        }
    }
}

impl Render for MoneyDisplay {
    fn render(&self, out: &mut String) {
        match self {
            Self::Formatted(value) => html! { <NumericValue value={value} /> }.render(out),
            Self::Fallback(text) => text.render(out),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_only_the_amount_and_keeps_copy_escaped() {
        let amount = MoneyDisplay::Formatted("$12.50".to_owned());
        let fallback = MoneyDisplay::Fallback("Pending <review>".to_owned());

        assert_eq!(amount.to_html(), r#"<span class="numeric-value__amount">$12.50</span>"#);
        assert_eq!(fallback.to_html(), "Pending &lt;review&gt;");
        assert_eq!(fallback.text(), "Pending <review>");
    }
}
