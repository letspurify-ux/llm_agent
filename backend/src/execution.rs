//! How a registered query runs. The model fills IN/INOUT values only; the
//! execution type and OUT settings are the administrator's.

use crate::{
    sql::{MAX_BIND_NAME_LEN, assert_read_only, bind_names, safe},
    text::name_key,
};
use anyhow::Result;
use regex::Regex;
use std::sync::LazyLock;
use serde_json::{Map, Value};

/// Columns kept per result row; also the routine output limit.
pub const MAX_RESULT_COLS: usize = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Query,
    Procedure,
    Function,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    In,
    Out,
    InOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BindType {
    String,
    Number,
    Cursor,
}

#[derive(Clone, Debug)]
pub struct Binding {
    pub name: String,
    pub dir: Dir,
    pub kind: BindType,
    pub max_size: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct Spec {
    pub kind: Kind,
    pub sql: String,
    /// Input bind names, in SQL order.
    pub inputs: Vec<String>,
    /// Routine binds (empty for QUERY).
    pub bindings: Vec<Binding>,
}

pub fn query_type(raw: &str) -> Result<Kind> {
    match raw {
        "" | "QUERY" => Ok(Kind::Query),
        "PROCEDURE" => Ok(Kind::Procedure),
        "FUNCTION" => Ok(Kind::Function),
        _ => Err(safe("실행 유형은 QUERY, PROCEDURE, FUNCTION 중 하나여야 합니다.")),
    }
}

fn binding_config(raw: &str) -> Result<Map<String, Value>> {
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(safe("바인드 설정은 JSON 객체여야 합니다.")),
    }
}

/// The execution spec of a registry row (`query_type`, `query_sql`,
/// `bind_config`).
pub fn execution_spec(query_type_raw: &str, query_sql: &str, bind_config: &str) -> Result<Spec> {
    let kind = query_type(query_type_raw)?;
    let config = binding_config(bind_config)?;
    if kind == Kind::Query {
        if !config.is_empty() {
            return Err(safe(
                "QUERY는 바인드 설정을 비워주세요. 입력 바인드는 SQL에서 자동으로 추출합니다.",
            ));
        }
        return Ok(Spec {
            kind,
            sql: assert_read_only(query_sql)?,
            inputs: bind_names(query_sql),
            bindings: vec![],
        });
    }
    // Only one call of a registered routine with binds: no free PL/SQL.
    // Built once: compiling it took about 1 ms, for every routine a search
    // result lists.
    static PROCEDURE: LazyLock<Regex> = LazyLock::new(|| routine_pattern(false));
    static FUNCTION: LazyLock<Regex> = LazyLock::new(|| routine_pattern(true));
    let pattern = if kind == Kind::Function { &FUNCTION } else { &PROCEDURE };
    let Some(captures) = pattern.captures(query_sql) else {
        return Err(safe(if kind == Kind::Function {
            "함수는 BEGIN :result := schema.function_name(:input); END; 형식으로 등록해주세요."
        } else {
            "프로시저는 BEGIN schema.procedure_name(:input, :output); END; 형식으로 등록해주세요."
        }));
    };
    let names = bind_names(query_sql);
    let keys: Vec<String> = config.keys().map(|k| name_key(k)).collect();
    let unique: std::collections::BTreeSet<&String> = keys.iter().collect();
    if unique.len() != keys.len()
        || config.keys().any(|name| {
            name.chars().count() > MAX_BIND_NAME_LEN
                || !names.iter().any(|n| name_key(n) == name_key(name))
        })
    {
        return Err(safe("바인드 설정에 중복되거나 SQL에 없는 이름이 있습니다."));
    }
    let mut bindings = Vec::new();
    for name in &names {
        let entry = config
            .iter()
            .find(|(key, _)| name_key(key) == name_key(name))
            .map(|(_, v)| v);
        let invalid = || safe(format!(":{name}의 dir(IN/OUT/INOUT), type(STRING/NUMBER/CURSOR)을 설정해주세요."));
        let Some(Value::Object(entry)) = entry else {
            return Err(invalid());
        };
        if entry.keys().any(|k| !matches!(k.as_str(), "dir" | "type" | "maxSize")) {
            return Err(invalid());
        }
        let dir = match entry.get("dir").and_then(Value::as_str) {
            Some("IN") => Dir::In,
            Some("OUT") => Dir::Out,
            Some("INOUT") => Dir::InOut,
            _ => return Err(invalid()),
        };
        let bind_type = match entry.get("type").and_then(Value::as_str) {
            Some("STRING") => BindType::String,
            Some("NUMBER") => BindType::Number,
            Some("CURSOR") => BindType::Cursor,
            _ => return Err(invalid()),
        };
        if bind_type == BindType::Cursor && dir != Dir::Out {
            return Err(safe("CURSOR는 OUT 방향만 지원합니다."));
        }
        let string_output = bind_type == BindType::String && dir != Dir::In;
        let max_size = match entry.get("maxSize") {
            None => None,
            Some(v) => {
                let size = v.as_u64().filter(|n| (1..=32767).contains(n) && v.is_u64());
                match size {
                    Some(size) if string_output => Some(size as u32),
                    _ => {
                        return Err(safe(
                            "maxSize는 STRING OUT/INOUT에만 지정할 수 있으며 1~32767바이트여야 합니다.",
                        ));
                    }
                }
            }
        };
        bindings.push(Binding {
            name: name.clone(),
            dir,
            kind: bind_type,
            max_size: if string_output { Some(max_size.unwrap_or(32767)) } else { None },
        });
    }
    let inputs: Vec<String> = bindings
        .iter()
        .filter(|b| b.dir != Dir::Out)
        .map(|b| b.name.clone())
        .collect();
    let outputs: Vec<&Binding> = bindings.iter().filter(|b| b.dir != Dir::In).collect();
    if inputs.len() > 20 || outputs.len() > MAX_RESULT_COLS || outputs.is_empty() {
        return Err(safe(format!(
            "루틴은 입력 최대 20개, 출력 1~{MAX_RESULT_COLS}개가 필요합니다."
        )));
    }
    if outputs.iter().any(|b| b.kind == BindType::Cursor) && outputs.len() != 1 {
        return Err(safe(
            "CURSOR 출력은 단독 1개만 지원합니다. 여러 스칼라 출력과 함께 사용할 수 없습니다.",
        ));
    }
    if kind == Kind::Function {
        let result = captures.get(1).map_or("", |m| m.as_str());
        if !outputs
            .iter()
            .any(|b| name_key(&b.name) == name_key(result) && b.dir == Dir::Out)
        {
            return Err(safe("함수 반환 바인드는 OUT으로 설정해주세요."));
        }
    }
    Ok(Spec {
        kind,
        sql: numeric_locals(query_sql.trim(), &bindings),
        inputs,
        bindings,
    })
}

/// NUMBER binds travel as strings (a driver double rounds large integers);
/// the routine call gets NUMBER locals so overload choice and INOUT types
/// are kept.
fn routine_pattern(function: bool) -> Regex {
    let ident = "[A-Za-z][A-Za-z0-9_$#]{0,127}";
    let target = format!(r"{ident}(?:\s*\.\s*{ident}){{0,2}}");
    let arg = format!(r"(?:{ident}\s*=>\s*)?:{ident}");
    let args = format!(r"(?:{arg}(?:\s*,\s*{arg})*)?");
    let assignment = if function {
        format!(r":({ident})\s*:=\s*")
    } else {
        String::new()
    };
    Regex::new(&format!(
        r"(?i)^\s*BEGIN\s+{assignment}{target}\s*\(\s*{args}\s*\)\s*;\s*END\s*;\s*$"
    ))
    .expect("routine pattern")
}

fn numeric_locals(sql: &str, bindings: &[Binding]) -> String {
    let numbers: Vec<&Binding> = bindings.iter().filter(|b| b.kind == BindType::Number).collect();
    if numbers.is_empty() {
        return sql.to_owned();
    }
    let mut prefix = "agent_number_".to_owned();
    while sql.to_lowercase().contains(&prefix) {
        prefix.push('x');
    }
    let locals: Vec<(&Binding, String)> = numbers
        .iter()
        .enumerate()
        .map(|(i, b)| (*b, format!("{prefix}{i}")))
        .collect();
    static BEGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^BEGIN\s+").unwrap());
    static END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)END\s*;$").unwrap());
    static BIND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":([A-Za-z][A-Za-z0-9_$#]*)").unwrap());
    let (begin, end, bind) = (&*BEGIN, &*END, &*BIND);
    let body = begin.replace(sql, "");
    let body = end.replace(&body, "");
    let body = bind.replace_all(&body, |c: &regex::Captures| {
        locals
            .iter()
            .find(|(b, _)| name_key(&b.name) == name_key(&c[1]))
            .map_or_else(|| c[0].to_owned(), |(_, local)| local.clone())
    });
    let declare: Vec<String> = locals.iter().map(|(_, l)| format!("{l} NUMBER;")).collect();
    let inputs: Vec<String> = locals
        .iter()
        .filter(|(b, _)| b.dir != Dir::Out)
        .map(|(b, l)| format!("{l} := :{};", b.name))
        .collect();
    let outputs: Vec<String> = locals
        .iter()
        .filter(|(b, _)| b.dir != Dir::In)
        .map(|(b, l)| format!(":{} := {l};", b.name))
        .collect();
    format!(
        "DECLARE {} BEGIN {} {} {} END;",
        declare.join(" "),
        inputs.join(" "),
        body,
        outputs.join(" ")
    )
}

/// Input binds of a row for display; a broken registration shows none
/// instead of failing the whole listing (execution validates again).
pub fn input_bind_names(query_type_raw: &str, query_sql: &str, bind_config: &str) -> Vec<String> {
    match query_type(query_type_raw) {
        Ok(Kind::Query) => bind_names(query_sql),
        _ => execution_spec(query_type_raw, query_sql, bind_config)
            .map(|s| s.inputs)
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_extract_inputs_and_refuse_binding_config() {
        let spec = execution_spec("QUERY", "SELECT * FROM t WHERE a = :job_id", "").unwrap();
        assert_eq!(spec.kind, Kind::Query);
        assert_eq!(spec.inputs, vec!["job_id"]);
        assert!(execution_spec("QUERY", "SELECT 1 FROM dual", "{\"a\":{}}").is_err());
        assert!(execution_spec("OTHER", "SELECT 1 FROM dual", "").is_err());
    }

    #[test]
    fn routines_need_one_registered_call_and_complete_binds() {
        let config = r#"{"emp_id":{"dir":"IN","type":"NUMBER"},"name":{"dir":"OUT","type":"STRING","maxSize":100}}"#;
        let spec = execution_spec("PROCEDURE", "BEGIN hr.get_name(:emp_id, :name); END;", config).unwrap();
        assert_eq!(spec.inputs, vec!["emp_id"]);
        assert!(spec.sql.starts_with("DECLARE agent_number_0 NUMBER; BEGIN agent_number_0 := :emp_id;"), "{}", spec.sql);
        assert!(spec.sql.contains("hr.get_name(agent_number_0, :name)"), "{}", spec.sql);
        assert_eq!(spec.bindings[1].max_size, Some(100));
        assert!(execution_spec("PROCEDURE", "BEGIN delete from t; END;", config).is_err());
        assert!(execution_spec("PROCEDURE", "BEGIN p(:a); END;", r#"{"a":{"dir":"IN","type":"STRING"}}"#).is_err(), "needs an output");
        let function = execution_spec(
            "FUNCTION",
            "BEGIN :r := pkg.f(:a); END;",
            r#"{"r":{"dir":"OUT","type":"CURSOR"},"a":{"dir":"IN","type":"STRING"}}"#,
        )
        .unwrap();
        assert_eq!(function.inputs, vec!["a"]);
        assert!(execution_spec(
            "FUNCTION",
            "BEGIN :r := pkg.f(:a); END;",
            r#"{"r":{"dir":"IN","type":"STRING"},"a":{"dir":"OUT","type":"STRING"}}"#,
        )
        .is_err());
    }
}
