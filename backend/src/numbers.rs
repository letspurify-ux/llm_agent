//! Exact decimals from Oracle. NUMBER values without a safe declared
//! precision arrive as text; they become JSON numbers only when the double
//! carries exactly the same value (judged on a canonical form, so '.5',
//! '1.0' and '0.10' count as exact while 18-digit keys stay text).

use serde_json::{Value, json};

/// Canonical (sign, significant digits, exponent) of a decimal text, or
/// None when it is not one.
fn decimal_parts(s: &str) -> Option<String> {
    let (sign, rest) = match s.as_bytes().first() {
        Some(b'+') => ("", &s[1..]),
        Some(b'-') => ("-", &s[1..]),
        _ => ("", s),
    };
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], Some(&rest[at + 1..])),
        None => (rest, None),
    };
    let exponent: i64 = match exponent {
        Some(e) => {
            let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            e.parse().ok()?
        }
        None => 0,
    };
    let (int, frac) = match mantissa.split_once('.') {
        Some((i, f)) => (i, f),
        None => (mantissa, ""),
    };
    if !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits = format!("{int}{frac}");
    if digits.is_empty() {
        return None;
    }
    let mut exp = exponent.saturating_sub(frac.len() as i64);
    let digits = digits.trim_start_matches('0');
    let trimmed = digits.trim_end_matches('0');
    exp = exp.saturating_add((digits.len() - trimmed.len()) as i64);
    Some(if trimmed.is_empty() {
        "0".into()
    } else {
        format!("{sign}{trimmed}e{exp}")
    })
}

/// The value as a JSON number when that is exact, else the text unchanged.
pub fn number_from_text(v: &str) -> Value {
    let s = v.trim();
    let Some(want) = decimal_parts(s) else {
        return json!(v);
    };
    let Ok(n) = s.parse::<f64>() else {
        return json!(v);
    };
    if !n.is_finite() || decimal_parts(&format!("{n:e}")).as_deref() != Some(want.as_str()) {
        return json!(v);
    }
    number_json(n)
}

/// A double as JSON, integral values without a fraction (as JavaScript
/// prints them).
pub fn number_json(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// Whether a decimal text fits Oracle NUMBER: zero, or a magnitude from
/// 1e-130 up to below 1e126, judged on the written digits.
pub fn in_oracle_number_range(text: &str) -> bool {
    let Some(parts) = decimal_parts(text.trim()) else {
        return false;
    };
    if parts == "0" {
        return true;
    }
    let (digits, exp) = parts.trim_start_matches('-').split_once('e').unwrap();
    let exp: i64 = exp.parse().unwrap_or(0);
    let magnitude = (digits.len() as i64 - 1).saturating_add(exp);
    (-130..126).contains(&magnitude)
}

/// A bind value for a NUMBER input: a decimal text that is finite and in
/// Oracle's range. Large integers must come as text to stay exact.
pub fn valid_number_input(value: &Value) -> bool {
    let text = match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => {
            if let Some(f) = n.as_f64()
                && f.fract() == 0.0
                && f.abs() >= 9_007_199_254_740_992.0
                && !n.is_i64()
                && !n.is_u64()
            {
                return false;
            }
            n.to_string()
        }
        _ => return false,
    };
    let shape = regex::Regex::new(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$").unwrap();
    shape.is_match(&text)
        && text.parse::<f64>().is_ok_and(f64::is_finite)
        && in_oracle_number_range(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_values_become_numbers() {
        assert_eq!(number_from_text(".5"), json!(0.5));
        assert_eq!(number_from_text("-.5"), json!(-0.5));
        assert_eq!(number_from_text("1.0"), json!(1));
        assert_eq!(number_from_text("0.10"), json!(0.1));
        assert_eq!(number_from_text("3"), json!(3));
        assert_eq!(number_from_text("123456789012345678"), json!("123456789012345678"));
        assert_eq!(number_from_text("abc"), json!("abc"));
        assert_eq!(number_from_text("1e400"), json!("1e400"));
    }

    #[test]
    fn oracle_range_is_judged_on_written_digits() {
        assert!(in_oracle_number_range("0"));
        assert!(in_oracle_number_range("1e125"));
        assert!(!in_oracle_number_range("1e126"));
        assert!(in_oracle_number_range("1e-130"));
        assert!(!in_oracle_number_range("1e-131"));
        assert!(!valid_number_input(&json!("1e200")));
        assert!(valid_number_input(&json!("12")));
        assert!(valid_number_input(&json!(3.5)));
        assert!(!valid_number_input(&json!("x")));
        // Exponents at the ends of i64 are refused, not overflowed.
        for text in ["1.5e-9223372036854775808", "15e9223372036854775807", "1.50e9223372036854775807"] {
            assert!(!in_oracle_number_range(text), "{text}");
            assert!(!valid_number_input(&json!(text)), "{text}");
            assert_eq!(number_from_text(text), json!(text));
        }
    }
}
