use std::{
    collections::{BTreeMap, HashSet},
    sync::LazyLock,
};

use regex::Regex;
use unicode_normalization::UnicodeNormalization as _;

pub const MAX_QUERY_CODE_POINTS: usize = 80;
pub const MAX_SUGGESTIONS: i64 = 8;

const TSQUERY_PHRASE: &str = " <-> ";
const TSQUERY_AND: &str = " & ";

static SAFE_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[./-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*").unwrap()
});
static HAS_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{N}").unwrap());
static SET_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{L}[\p{L}\p{M}]*$").unwrap());
static COLLECTOR_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\p{N}+\p{L}?(?:/\p{N}+)?$").unwrap());
static LATIN_MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\p{Latin})\p{M}+").unwrap());
static NON_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());
// Keep the legacy range starting at U+8C48, not U+F900. The current index was built with it.
static CJK_RUN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\u{3000}-\u{303f}\u{3040}-\u{309f}\u{30a0}-\u{30ff}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{8c48}-\u{faff}\u{ff00}-\u{ffef}\u{ac00}-\u{d7af}]+").unwrap()
});
static DECIMAL_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[+-]?[0-9]+").unwrap());

pub type Vocabulary = BTreeMap<String, String>;

#[derive(Debug, PartialEq, Eq)]
pub struct QueryPlan {
    pub english: String,
    pub simple: String,
    pub limit: i64,
}

struct Token {
    raw: String,
    digit_bearing: bool,
}

pub struct SuggestionQuery {
    tokens: Vec<Token>,
    limit: i64,
}

impl SuggestionQuery {
    pub fn parse(query: &str, limit: Option<&str>) -> Self {
        let bounded: String = query.chars().take(MAX_QUERY_CODE_POINTS).collect();
        let mut tokens = Vec::new();
        for word in bounded.split(js_whitespace).filter(|word| !word.is_empty()) {
            let digit_bearing = HAS_NUMBER.is_match(word);
            for safe in SAFE_TOKEN.find_iter(word).map(|token| token.as_str()) {
                if digit_bearing {
                    tokens.push(Token {
                        raw: safe.into(),
                        digit_bearing,
                    });
                } else {
                    tokens.extend(safe.split(['.', '/', '-']).map(|part| Token {
                        raw: part.into(),
                        digit_bearing,
                    }));
                }
            }
        }
        Self {
            tokens,
            limit: parse_limit(limit),
        }
    }

    fn is_set_code_candidate(&self, index: usize) -> bool {
        let token = &self.tokens[index];
        !token.digit_bearing
            && SET_CODE.is_match(&token.raw)
            && self
                .tokens
                .get(index + 1)
                .is_some_and(|next| COLLECTOR_NUMBER.is_match(&next.raw))
    }

    pub fn set_code_candidates(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        self.tokens
            .iter()
            .enumerate()
            .filter(|(index, _)| self.is_set_code_candidate(*index))
            .map(|(_, token)| token.raw.to_lowercase())
            .filter(|code| seen.insert(code.clone()))
            .collect()
    }

    pub fn plan(
        &self,
        served_codes: &HashSet<String>,
        vocabulary: &Vocabulary,
    ) -> Option<QueryPlan> {
        if self.tokens.is_empty() {
            return None;
        }
        let mut english = Vec::new();
        let mut simple = Vec::new();
        for (index, token) in self.tokens.iter().enumerate() {
            let raw = &token.raw;
            let protected = token.digit_bearing
                || (self.is_set_code_candidate(index)
                    && served_codes.contains(&raw.to_lowercase()));
            let prefix = index + 1 == self.tokens.len();
            let alternative = if protected {
                None
            } else {
                vocabulary.get(&normalize_word(raw).to_lowercase())
            };
            let original_english = if protected {
                add_prefix(&fold_latin_marks(raw), prefix)
            } else {
                expression(&normalize_word(raw), false, prefix)
            };
            let original_simple = expression(&normalize_simple_query(raw), protected, prefix);
            let join = |original: String, normalize: fn(&str) -> String| {
                let literal = if protected && original.contains(TSQUERY_PHRASE) {
                    format!("({original})")
                } else {
                    original
                };
                match alternative {
                    Some(alternative) if !alternative.is_empty() => {
                        let expansion = expression(&normalize(alternative), true, prefix);
                        format!("({literal} | ({expansion}))")
                    }
                    _ => literal,
                }
            };
            english.push(join(original_english, normalize_word));
            simple.push(join(original_simple, normalize_simple_query));
        }
        Some(QueryPlan {
            english: english.join(TSQUERY_AND),
            simple: simple.join(TSQUERY_AND),
            limit: self.limit,
        })
    }
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}'
        | '\u{3000}' | '\u{feff}')
}

fn parse_limit(value: Option<&str>) -> i64 {
    let number = value
        .and_then(|value| DECIMAL_PREFIX.find(value.trim_start_matches(js_whitespace)))
        .and_then(|matched| matched.as_str().parse::<f64>().ok());
    match number {
        Some(number) if number.is_finite() && number <= 1.0 => 1,
        Some(number) if number.is_finite() && number < MAX_SUGGESTIONS as f64 => number as i64,
        _ => MAX_SUGGESTIONS,
    }
}

fn fold_latin_marks(value: &str) -> String {
    let decomposed: String = value.nfd().collect();
    LATIN_MARKS.replace_all(&decomposed, "$1").nfc().collect()
}

fn normalize_word(value: &str) -> String {
    NON_WORD
        .replace_all(&fold_latin_marks(value), " ")
        .trim()
        .to_string()
}

fn normalize_simple_query(value: &str) -> String {
    let normalized = normalize_word(value);
    CJK_RUN
        .replace_all(&normalized, |capture: &regex::Captures<'_>| {
            let run: Vec<_> = capture[0].chars().collect();
            if run.len() < 2 {
                return capture[0].to_owned();
            }
            run.windows(2)
                .map(|pair| pair.iter().collect::<String>())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .into_owned()
}

fn add_prefix(word: &str, prefix: bool) -> String {
    if prefix {
        format!("{word}:*")
    } else {
        word.into()
    }
}

fn expression(text: &str, phrase: bool, prefix: bool) -> String {
    let mut words = text.split(' ').filter(|word| !word.is_empty()).peekable();
    let mut parts = Vec::new();
    while let Some(word) = words.next() {
        parts.push(add_prefix(word, prefix && words.peek().is_none()));
    }
    parts.join(if phrase { TSQUERY_PHRASE } else { TSQUERY_AND })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_a_final_synonym_and_protects_a_served_set_code() {
        let vocabulary = Vocabulary::from([("zard".into(), "charizard".into())]);
        let direct = SuggestionQuery::parse("zard", None);
        assert_eq!(
            direct.plan(&HashSet::new(), &vocabulary).unwrap().simple,
            "(zard:* | (charizard:*))"
        );
        let numbered = SuggestionQuery::parse("zard 4/102", Some("  +2.9"));
        assert_eq!(numbered.set_code_candidates(), ["zard"]);
        assert_eq!(
            numbered.plan(&HashSet::from(["zard".into()]), &vocabulary),
            Some(QueryPlan {
                english: "zard & 4/102:*".into(),
                simple: "zard & (4 <-> 102:*)".into(),
                limit: 2,
            })
        );
    }

    #[test]
    fn folds_latin_and_builds_cjk_bigrams_without_splitting_code_points() {
        let query = SuggestionQuery::parse("Évo リザード", None);
        let plan = query.plan(&HashSet::new(), &Vocabulary::new()).unwrap();
        assert_eq!(plan.english, "Evo & リザード:*");
        assert_eq!(plan.simple, "Evo & リザ & ザー & ード:*");
        assert_eq!(
            normalize_simple_query("\u{a000}\u{a001}\u{a002}"),
            "\u{a000}\u{a001} \u{a001}\u{a002}"
        );
        let long =
            SuggestionQuery::parse(&format!("{}word", "界".repeat(MAX_QUERY_CODE_POINTS)), None);
        assert!(long.tokens[0].raw.chars().all(|ch| ch == '界'));
    }

    #[test]
    fn drops_punctuation_only_input_and_bounds_javascript_decimal_limits() {
        assert!(
            SuggestionQuery::parse("' | ! :*", None)
                .plan(&HashSet::new(), &Vocabulary::new())
                .is_none()
        );
        assert_eq!(parse_limit(Some("-10")), 1);
        assert_eq!(parse_limit(Some("1000")), 8);
        assert_eq!(parse_limit(Some("z3")), 8);
        assert_eq!(parse_limit(Some("\u{feff}3")), 3);
        assert_eq!(parse_limit(Some(&format!("-{}", "9".repeat(400)))), 8);
    }
}
