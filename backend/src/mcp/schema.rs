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

/// Descriptions with the server's other tools named as the model sees
/// them: "use web_fetch_exa" becomes "use exa__web_fetch_exa", or a model
/// that follows it calls a name that does not exist. Only identifier-like
/// names (with '_', '.' or '-') are replaced, as whole words: a plain word
/// such as "search" is also prose. Built once per listing, one pass per
/// description (a server may list a thousand tools).
pub struct Renamer {
    names: Option<regex::Regex>,
    exposed: std::collections::HashMap<String, String>,
}

impl Renamer {
    pub fn new(names: &[(String, String)]) -> Self {
        let mut renamed: Vec<&(String, String)> =
            names.iter().filter(|(name, exposed)| name != exposed && name.contains(['_', '.', '-'])).collect();
        // The longest name first where several start at one place.
        renamed.sort_by_key(|(name, _)| std::cmp::Reverse(name.len()));
        let pattern = renamed.iter().map(|(name, _)| regex::escape(name)).collect::<Vec<_>>().join("|");
        Self {
            names: (!renamed.is_empty()).then(|| regex::Regex::new(&pattern)).and_then(Result::ok),
            exposed: renamed.into_iter().cloned().collect(),
        }
    }

    pub fn apply(&self, description: &str) -> String {
        let Some(names) = &self.names else {
            return description.to_owned();
        };
        let part = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
        // A word goes on past '-' or '.' with more of it behind: "read-file"
        // is not the start of "read-file-lines", nor of "fs.read-file".
        let joined = |chars: &mut dyn Iterator<Item = char>| {
            let next = chars.next();
            part(next) || (matches!(next, Some('-' | '.')) && part(chars.next()))
        };
        let mut text = String::with_capacity(description.len());
        let mut copied = 0;
        for found in names.find_iter(description) {
            let whole = !joined(&mut description[..found.start()].chars().rev()) && !joined(&mut description[found.end()..].chars());
            if whole {
                text.push_str(&description[copied..found.start()]);
                text.push_str(&self.exposed[found.as_str()]);
                copied = found.end();
            }
        }
        text.push_str(&description[copied..]);
        if text.chars().count() > MAX_DESCRIPTION {
            let mut cut: String = text.chars().take(MAX_DESCRIPTION - 1).collect();
            cut.push('…');
            return cut;
        }
        text
    }
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
    combined_fields(&mut out, object, &definitions);
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
    tidy(&mut value, 0);
    value
}

/// The fields of the schemas a top-level `allOf`, `anyOf` or `oneOf`
/// combines, which go with it: kept as properties of the object (a schema
/// generated from types — an OpenAPI composition, an intersection — puts
/// every field there, and a tool without them cannot be called). An
/// `allOf` member's required fields stay required (all of them apply); an
/// alternative's are not (another may be chosen). A property the object
/// itself defines wins.
fn combined_fields(out: &mut Map<String, Value>, object: &Map<String, Value>, definitions: &Map<String, Value>) {
    let mut required: Vec<Value> = out.get("required").and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(properties) = out.get_mut("properties").and_then(Value::as_object_mut) else {
        return;
    };
    for key in ["allOf", "anyOf", "oneOf"] {
        for member in object.get(key).and_then(Value::as_array).into_iter().flatten() {
            // A member is often a reference to a definition.
            let member = member["$ref"].as_str().and_then(|target| definitions.get(target)).unwrap_or(member);
            for (name, schema) in member["properties"].as_object().into_iter().flatten().filter(|(_, s)| s.is_object() || **s == true) {
                properties.entry(name.clone()).or_insert_with(|| schema.clone());
            }
            if key == "allOf" {
                for name in member["required"].as_array().into_iter().flatten().filter(|n| n.is_string()) {
                    if !required.contains(name) {
                        required.push(name.clone());
                    }
                }
            }
        }
    }
    if !required.is_empty() {
        out.insert("required".into(), Value::Array(required));
    }
}

/// Nested subschemas are tidied this deep at most (a deeper one a provider
/// refuses leaves out its tool alone, see `Snapshot::refused_in`).
const TIDY_DEPTH: usize = 64;

/// A schema and its subschemas as providers take them, accepting what they
/// accepted. A provider refuses the whole request over one subschema:
/// OpenAI and Gemini an array without `items` ("array schema missing
/// items"), or `properties` that is no object (PHP servers send an empty
/// one as `[]`). Subschemas are found where JSON Schema puts them, not by
/// key anywhere: a property may be named "items".
fn tidy(schema: &mut Value, depth: usize) {
    let Value::Object(fields) = schema else {
        return;
    };
    if depth > TIDY_DEPTH {
        return;
    }
    let is = |kind: &str| fields.get("type").is_some_and(|t| t == kind || t.as_array().is_some_and(|types| types.iter().any(|t| t == kind)));
    let (array, object) = (is("array"), is("object"));
    if array && !fields.get("items").is_some_and(|items| items.is_object() || items.is_array() || *items == false) {
        fields.insert("items".into(), json!({}));
    }
    if fields.get("properties").is_some_and(|p| !p.is_object()) || (object && !fields.contains_key("properties")) {
        fields.insert("properties".into(), json!({}));
    }
    if fields.get("required").is_some_and(|r| !r.as_array().is_some_and(|r| r.iter().all(Value::is_string))) {
        fields.remove("required");
    }
    for (key, sub) in fields.iter_mut() {
        match (key.as_str(), sub) {
            ("properties" | "patternProperties" | "$defs" | "definitions" | "dependentSchemas", Value::Object(named)) => {
                for sub in named.values_mut() {
                    // `true` accepts anything, as `{}` does.
                    if *sub == true {
                        *sub = json!({});
                    }
                    tidy(sub, depth + 1);
                }
            }
            ("anyOf" | "oneOf" | "allOf" | "prefixItems" | "items", Value::Array(list)) => {
                for sub in list {
                    tidy(sub, depth + 1);
                }
            }
            (
                "items" | "additionalProperties" | "additionalItems" | "unevaluatedItems" | "unevaluatedProperties" | "not" | "contains"
                | "if" | "then" | "else" | "propertyNames",
                sub,
            ) => tidy(sub, depth + 1),
            _ => {}
        }
    }
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

    /// The first subschema a provider refuses (an array without `items`,
    /// `properties` that is no object), walked as JSON Schema nests them.
    fn refused_part(schema: &Value, path: &str) -> Option<String> {
        let fields = schema.as_object()?;
        let is = |kind: &str| fields.get("type").is_some_and(|t| t == kind || t.as_array().is_some_and(|ts| ts.iter().any(|t| t == kind)));
        if is("array") && !fields.get("items").is_some_and(|i| i.is_object() || i.is_array() || *i == false) {
            return Some(format!("{path} (array without items)"));
        }
        if fields.get("properties").is_some_and(|p| !p.is_object()) || (is("object") && !fields.contains_key("properties")) {
            return Some(format!("{path} (properties)"));
        }
        for (key, sub) in fields {
            let found = match (key.as_str(), sub) {
                ("properties" | "patternProperties" | "$defs" | "definitions", Value::Object(named)) => named
                    .iter()
                    .find_map(|(name, sub)| if *sub == true { Some(format!("{path}/{key}/{name} (true)")) } else { refused_part(sub, &format!("{path}/{key}/{name}")) }),
                ("anyOf" | "oneOf" | "allOf" | "prefixItems" | "items", Value::Array(list)) => {
                    list.iter().enumerate().find_map(|(i, sub)| refused_part(sub, &format!("{path}/{key}/{i}")))
                }
                ("items" | "additionalProperties" | "not", sub) => refused_part(sub, &format!("{path}/{key}")),
                _ => None,
            };
            if found.is_some() {
                return found;
            }
        }
        None
    }

    #[test]
    fn nested_schemas_are_put_as_providers_take_them() {
        let schema = json!({"type":"object","properties":{
            "tags":{"type":"array","description":"labels"},
            "maybe":{"type":["array","null"]},
            "rows":{"type":"array","items":{"type":"object","properties":[],"required":"id"}},
            "pairs":{"type":"array","items":[{"type":"string"},{"type":"array"}]},
            "map":{"type":"object","additionalProperties":{"type":"array"}},
            "any":true,
            "items":{"type":"string"},
            "choice":{"anyOf":[{"type":"array"},{"type":"string"}]},
            "nested":{"type":"object"}
        }});
        let p = parameters(&schema);
        let props = &p["properties"];
        assert_eq!(props["tags"], json!({"type":"array","description":"labels","items":{}}));
        assert_eq!(props["maybe"]["items"], json!({}));
        assert_eq!(props["rows"]["items"], json!({"type":"object","properties":{}}), "a PHP [] and a bad required");
        assert_eq!(props["pairs"]["items"][1]["items"], json!({}), "tuple items are left as they are, each tidied");
        assert_eq!(props["map"]["additionalProperties"]["items"], json!({}));
        assert_eq!(props["any"], json!({}));
        assert_eq!(props["items"], json!({"type":"string"}), "a property named items is a property");
        assert_eq!(props["choice"]["anyOf"][0]["items"], json!({}));
        assert_eq!(props["nested"], json!({"type":"object","properties":{}}));
        assert_eq!(refused_part(&p, ""), None);
        // A schema already right is left as it is.
        let right = json!({"type":"object","properties":{"q":{"type":"string"},"ids":{"type":"array","items":{"type":"integer"}}},"required":["q"]});
        assert_eq!(parameters(&right), right);
        // An inlined definition is tidied too.
        let referenced = json!({"type":"object","properties":{"f":{"$ref":"#/$defs/F"}},"$defs":{"F":{"type":"array"}}});
        assert_eq!(parameters(&referenced)["properties"]["f"], json!({"type":"array","items":{}}));
    }

    #[test]
    fn fields_combined_at_the_top_stay() {
        // An intersection (allOf, one part a definition): every field, every
        // required one.
        let all = json!({"type":"object","allOf":[
            {"$ref":"#/$defs/Paging"},
            {"type":"object","properties":{"query":{"type":"string"},"tags":{"type":"array"}},"required":["query"]}
        ],"$defs":{"Paging":{"type":"object","properties":{"limit":{"type":"integer"},"cursor":{"$ref":"#/$defs/Cursor"}},"required":["limit"]},"Cursor":{"type":"string"}}});
        let p = parameters(&all);
        assert_eq!(p["properties"]["query"], json!({"type":"string"}));
        assert_eq!(p["properties"]["limit"], json!({"type":"integer"}));
        assert_eq!(p["properties"]["cursor"], json!({"type":"string"}), "a reference in a combined field is expanded");
        assert_eq!(p["properties"]["tags"], json!({"type":"array","items":{}}), "and tidied");
        assert_eq!(p["required"], json!(["limit", "query"]));
        assert!(p.get("allOf").is_none() && p.get("$defs").is_none());
        // Alternatives (anyOf, oneOf): their fields, none required; the
        // object's own field wins over an alternative's.
        let any = json!({"type":"object","properties":{"id":{"type":"integer","description":"own"}},"required":["id"],"anyOf":[
            {"properties":{"name":{"type":"string"}},"required":["name"]},
            {"properties":{"id":{"type":"string"},"email":{"type":"string"},"bad":5}}
        ],"oneOf":"not a list"});
        let p = parameters(&any);
        assert_eq!(p["properties"], json!({"id":{"type":"integer","description":"own"},"name":{"type":"string"},"email":{"type":"string"}}));
        assert_eq!(p["required"], json!(["id"]));
        assert_eq!(missing_required(&p, json!({"id":1}).as_object().unwrap()), Vec::<String>::new());
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
            if let Some(path) = refused_part(&p, "") {
                panic!("{path} would be refused: {p} from {schema}");
            }
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
    fn other_tools_are_named_as_the_model_sees_them() {
        let names = vec![
            ("web_fetch_exa".to_owned(), "exa__web_fetch_exa".to_owned()),
            ("search".to_owned(), "exa__search".to_owned()),
            ("weird.name".to_owned(), "exa__weird_name".to_owned()),
        ];
        let renamer = Renamer::new(&names);
        assert_eq!(
            renamer.apply("Use after web_search; then web_fetch_exa (or weird.name). Search the web."),
            "Use after web_search; then exa__web_fetch_exa (or exa__weird_name). Search the web."
        );
        // Already exposed, or part of a longer identifier: unchanged.
        assert_eq!(renamer.apply("exa__web_fetch_exa and web_fetch_exa_v2"), "exa__web_fetch_exa and web_fetch_exa_v2");
        assert_eq!(renamer.apply("가web_fetch_exa"), "가web_fetch_exa");
        assert_eq!(renamer.apply("「web_fetch_exa」"), "「exa__web_fetch_exa」");
        // A word that goes on past '-' or '.' is another name; a sentence's
        // end is not.
        let dashed = Renamer::new(&[("read-file".to_owned(), "fs__read_file".to_owned())]);
        assert_eq!(dashed.apply("read-file-lines, x.read-file and read-file."), "read-file-lines, x.read-file and fs__read_file.");
        assert_eq!(dashed.apply("read-file- or -read-file"), "fs__read_file- or -fs__read_file");
        // Of two names starting at one place, the longer.
        let nested = Renamer::new(&[("a_b".to_owned(), "s__a_b".to_owned()), ("a_b_c".to_owned(), "s__a_b_c".to_owned())]);
        assert_eq!(nested.apply("a_b_c, a_b and a_b_cd"), "s__a_b_c, s__a_b and a_b_cd");
        assert_eq!(Renamer::new(&[]).apply("text"), "text");
    }

    /// A thousand tools whose descriptions name others: one listing's
    /// renaming stays well under a second even unoptimized.
    #[test]
    fn renaming_a_thousand_descriptions_is_quick() {
        let names: Vec<(String, String)> = (0..1_000).map(|i| (format!("tool_name_{i}"), format!("srv__tool_name_{i}"))).collect();
        let description: String = (0..60).map(|i| format!("see tool_name_{} here", i * 7)).collect::<Vec<_>>().join(". ").chars().take(1_000).collect();
        let started = std::time::Instant::now();
        let renamer = Renamer::new(&names);
        for _ in 0..1_000 {
            let renamed = renamer.apply(&description);
            assert!(renamed.starts_with("see srv__tool_name_0 here"));
        }
        assert!(started.elapsed() < std::time::Duration::from_millis(800), "{:?}", started.elapsed());
    }

    #[test]
    fn required_fields_are_checked_at_the_top_only() {
        let p = json!({"type":"object","properties":{},"required":["a","b"]});
        let args = json!({"a":1}).as_object().unwrap().clone();
        assert_eq!(missing_required(&p, &args), vec!["b".to_owned()]);
    }
}
