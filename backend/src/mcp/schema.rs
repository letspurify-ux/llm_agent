//! What the model sees of an MCP tool: its name, description and parameters
//! as an OpenAI function definition.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// Longest function name providers accept.
pub const MAX_NAME: usize = 64;
/// Characters of a tool description sent to the model: OpenAI refuses the
/// whole request ("string too long") past 1,024.
pub const MAX_DESCRIPTION: usize = 1_024;
/// Local `$ref`s are expanded this deep, and at most this many in all; past
/// either a reference becomes an unconstrained value.
const REF_DEPTH: usize = 6;
const REF_EXPANSIONS: usize = 64;

/// The model-facing names of one server's tools, in order: `server__tool`,
/// characters outside `[A-Za-z0-9_-]` replaced by '_'. A name past
/// `MAX_NAME`, or one an earlier tool already has (case-insensitively), is
/// shortened and given a hash of the tool's own name.
pub fn exposed_names(server: &str, tools: &[String]) -> Vec<String> {
    let mut taken = BTreeSet::new();
    tools
        .iter()
        .map(|tool| {
            let clean: String = tool
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect();
            let mut name = format!("{server}__{clean}");
            let mut salt = 0u32;
            while name.len() > MAX_NAME || taken.contains(&name.to_ascii_lowercase()) {
                let digest = hex::encode(Sha256::digest(format!("{tool}\u{0}{salt}").as_bytes()));
                let keep = MAX_NAME - 9;
                let base = format!("{server}__{clean}");
                name = format!("{}_{}", &base[..base.len().min(keep)], &digest[..8]);
                salt += 1;
            }
            taken.insert(name.to_ascii_lowercase());
            name
        })
        .collect()
}

/// The tool's description (its title when it has none), cut to
/// `MAX_DESCRIPTION` characters.
pub fn description(tool: &Value) -> String {
    let text = tool["description"]
        .as_str()
        .filter(|d| !d.trim().is_empty())
        .or_else(|| tool["title"].as_str())
        .unwrap_or("")
        .trim();
    if text.chars().count() <= MAX_DESCRIPTION {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(MAX_DESCRIPTION - 1).collect();
    cut.push('…');
    cut
}

/// Function parameters from a tool's input schema: always an object schema.
/// Top-level combinators and schema identifiers go (providers refuse them in
/// function parameters); local `$ref`s are expanded in place so a provider
/// that does not resolve them still shows the model the fields.
pub fn parameters(schema: &Value) -> Value {
    // `"type": ["object", "null"]` is an object that may be left out.
    let objectish = |t: &Value| t == "object" || t.as_array().is_some_and(|types| types.iter().any(|t| t == "object"));
    let Some(object) = schema.as_object().filter(|o| o.get("type").is_none_or(objectish)) else {
        return json!({"type":"object","properties":{}});
    };
    let mut definitions = Map::new();
    for key in ["definitions", "$defs"] {
        if let Some(defs) = object.get(key).and_then(Value::as_object) {
            for (name, def) in defs {
                definitions.insert(format!("#/{key}/{name}"), def.clone());
            }
        }
    }
    let mut out = object.clone();
    for key in ["$schema", "$id", "$comment", "oneOf", "anyOf", "allOf", "not", "$defs", "definitions"] {
        out.remove(key);
    }
    out.insert("type".into(), json!("object"));
    if !out.get("properties").is_some_and(Value::is_object) {
        out.insert("properties".into(), json!({}));
    }
    let required_ok = out
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|r| r.iter().all(Value::is_string));
    if !required_ok {
        out.remove("required");
    }
    let mut budget = REF_EXPANSIONS;
    let mut value = Value::Object(out);
    expand(&mut value, &definitions, 0, &mut budget);
    value
}

fn expand(value: &mut Value, definitions: &Map<String, Value>, depth: usize, budget: &mut usize) {
    match value {
        Value::Object(fields) => {
            if let Some(target) = fields.get("$ref").and_then(Value::as_str).map(str::to_owned) {
                fields.remove("$ref");
                let found = definitions.get(&target).filter(|_| depth < REF_DEPTH && *budget > 0);
                if let Some(definition) = found {
                    *budget -= 1;
                    let mut inlined = definition.clone();
                    expand(&mut inlined, definitions, depth + 1, budget);
                    // Keys beside the reference (a description) stay; the
                    // definition fills in the rest.
                    if let Value::Object(defined) = inlined {
                        for (key, field) in defined {
                            fields.entry(key).or_insert(field);
                        }
                    }
                }
                return;
            }
            for field in fields.values_mut() {
                expand(field, definitions, depth, budget);
            }
        }
        Value::Array(items) => {
            for item in items {
                expand(item, definitions, depth, budget);
            }
        }
        _ => {}
    }
}

/// Top-level required fields the arguments leave out.
pub fn missing_required(parameters: &Value, args: &Map<String, Value>) -> Vec<String> {
    parameters["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|key| !args.contains_key(*key))
        .map(str::to_owned)
        .collect()
}

pub fn definition(name: &str, description: &str, parameters: &Value) -> Value {
    json!({"type":"function","function":{"name":name,"description":description,"parameters":parameters}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::Rng;

    #[test]
    fn names_are_cleaned_and_unique_within_the_limit() {
        let tools = vec![
            "search".to_owned(),
            "weird.name".to_owned(),
            "weird_name".to_owned(),
            "Search".to_owned(),
            "x".repeat(80),
        ];
        let names = exposed_names("jira", &tools);
        assert_eq!(names[0], "jira__search");
        assert_eq!(names[1], "jira__weird_name");
        // The plain name is taken by the cleaned one before it.
        assert!(names[2].starts_with("jira__weird_name_") && names[2].len() == "jira__weird_name".len() + 9);
        assert!(names[3].starts_with("jira__Search_"));
        assert!(names[4].len() <= MAX_NAME && names[4].starts_with("jira__xxx"));
        let unique: BTreeSet<_> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
        assert_eq!(unique.len(), names.len());
        assert!(names.iter().all(|n| n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')));
        // The same list names the same way every time.
        assert_eq!(exposed_names("jira", &tools), names);
    }

    #[test]
    fn schemas_become_plain_object_parameters() {
        let schema = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","anyOf":[{"required":["item"]}],
            "properties":{"item":{"$ref":"#/$defs/Item","description":"the item"},"other":{"$ref":"#/definitions/Missing"}},
            "required":["item"],
            "$defs":{"Item":{"type":"object","description":"ignored beside the ref's own","properties":{"id":{"type":"integer"},"next":{"$ref":"#/$defs/Item"}}}}
        });
        let p = parameters(&schema);
        assert!(p.get("$schema").is_none() && p.get("anyOf").is_none() && p.get("$defs").is_none());
        assert_eq!(p["required"], json!(["item"]));
        let item = &p["properties"]["item"];
        assert_eq!(item["description"], "the item");
        assert_eq!(item["properties"]["id"]["type"], "integer");
        // A recursive definition stops expanding at the depth limit.
        let mut depth = 0;
        let mut node = item;
        while node["properties"]["next"].is_object() && node["properties"]["next"].get("properties").is_some() {
            node = &node["properties"]["next"];
            depth += 1;
        }
        assert!(depth < REF_DEPTH);
        assert!(!p.to_string().contains("$ref"));
        assert_eq!(p["properties"]["other"], json!({}));
        assert_eq!(parameters(&json!({"type":"string"})), json!({"type":"object","properties":{}}));
        assert_eq!(parameters(&Value::Null), json!({"type":"object","properties":{}}));
        assert_eq!(parameters(&json!({"required":"x"})), json!({"type":"object","properties":{}}));
        assert_eq!(parameters(&json!({"type":["object","null"],"properties":{"a":{"type":"string"}}}))["properties"]["a"]["type"], "string");
    }

    #[test]
    fn a_self_referencing_tree_stays_small() {
        let schema = json!({"type":"object","properties":{"root":{"$ref":"#/$defs/T"}},
            "$defs":{"T":{"type":"object","properties":{"l":{"$ref":"#/$defs/T"},"r":{"$ref":"#/$defs/T"},"m":{"$ref":"#/$defs/T"}}}}});
        let p = parameters(&schema);
        assert!(p.to_string().len() < 20_000, "{}", p.to_string().len());
    }

    #[test]
    fn descriptions_fall_back_to_the_title_and_are_cut() {
        assert_eq!(description(&json!({"title":"Add","description":" "})), "Add");
        let long = description(&json!({"description":"가".repeat(MAX_DESCRIPTION + 10)}));
        assert_eq!(long.chars().count(), MAX_DESCRIPTION);
        assert!(long.ends_with('…'));
    }

    /// Random JSON: objects with schema-like keys, local refs, arrays.
    fn random_value(rng: &mut impl rand::Rng, depth: usize) -> Value {
        const KEYS: &[&str] = &["type", "properties", "required", "$ref", "$defs", "definitions", "anyOf", "items", "description", "a", "b", "next"];
        const REFS: &[&str] = &["#/$defs/A", "#/$defs/B", "#/definitions/C", "#", "#/$defs/missing", "http://x/y"];
        match rng.gen_range(0..if depth > 4 { 4 } else { 7 }) {
            0 => Value::Null,
            1 => json!(rng.gen_range(-5..5)),
            2 => json!(["object", "string", "array", "null"][rng.gen_range(0..4)]),
            3 => json!(REFS[rng.gen_range(0..REFS.len())]),
            4 => Value::Array((0..rng.gen_range(0..4)).map(|_| random_value(rng, depth + 1)).collect()),
            _ => {
                let mut object = Map::new();
                for _ in 0..rng.gen_range(0..5) {
                    let key = KEYS[rng.gen_range(0..KEYS.len())];
                    let value = if key == "$ref" { json!(REFS[rng.gen_range(0..REFS.len())]) } else { random_value(rng, depth + 1) };
                    object.insert(key.into(), value);
                }
                Value::Object(object)
            }
        }
    }

    #[test]
    fn random_schemas_become_bounded_object_parameters() {
        use rand::SeedableRng;
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        for _ in 0..5_000 {
            let mut schema = random_value(&mut rng, 0);
            if rng.gen_bool(0.7) {
                schema = json!({"type":"object","properties":random_value(&mut rng, 1),"$defs":{"A":random_value(&mut rng, 1),"B":{"type":"object","properties":{"self":{"$ref":"#/$defs/B"},"a":{"$ref":"#/$defs/A"}}}},"definitions":{"C":random_value(&mut rng, 1)}});
            }
            let p = parameters(&schema);
            assert_eq!(p["type"], "object", "{schema}");
            assert!(p["properties"].is_object(), "{schema}");
            assert!(p.get("required").is_none_or(|r| r.as_array().is_some_and(|r| r.iter().all(Value::is_string))));
            for key in ["anyOf", "oneOf", "allOf", "not", "$defs", "definitions", "$schema"] {
                assert!(p.get(key).is_none(), "{key} left at the top: {schema}");
            }
            assert!(p.to_string().len() < 400_000, "bounded: {}", p.to_string().len());
        }
    }

    #[test]
    fn random_tool_names_stay_unique_and_valid() {
        use rand::SeedableRng;
        let mut rng = rand::rngs::StdRng::seed_from_u64(11);
        const PARTS: &[&str] = &["a", "A", "_", "-", ".", "가", "😀", "x", "search", "/", " ", "0"];
        for _ in 0..2_000 {
            let tools: Vec<String> = (0..rng.gen_range(1..30))
                .map(|_| (0..rng.gen_range(1..40)).map(|_| PARTS[rng.gen_range(0..PARTS.len())]).collect())
                .collect();
            let names = exposed_names("srv-1", &tools);
            assert_eq!(names.len(), tools.len());
            let unique: BTreeSet<_> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
            assert_eq!(unique.len(), names.len(), "{tools:?} → {names:?}");
            for name in &names {
                assert!(name.len() <= MAX_NAME && name.starts_with("srv-1__"), "{name}");
                assert!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'), "{name}");
            }
            assert_eq!(exposed_names("srv-1", &tools), names, "stable");
        }
    }

    #[test]
    fn required_fields_are_checked_at_the_top_only() {
        let p = json!({"type":"object","properties":{},"required":["a","b"]});
        let args = json!({"a":1}).as_object().unwrap().clone();
        assert_eq!(missing_required(&p, &args), vec!["b".to_owned()]);
    }
}
