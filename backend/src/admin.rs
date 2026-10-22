//! The admin API under /api/admin. The four management tables keep the
//! former contract (paged lists, HMAC revisions with ETag/If-Match, a
//! named lock around writes, reference checks); projects, settings, folder
//! browsing and connection checks are new.

use crate::{
    app::App,
    config::{Config, McpServer, Project, Secret},
    db::{self, Param, exec_on, marks, n, p, plain_on, query_on},
    text::{js_trim, name_index_of, name_key, password_env_reference, target_db_names, utf16_len},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}
impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message: message.into(),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error":self.message}))).into_response()
    }
}
/// Database failures as the former admin API reported them.
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        if let Some(api) = error.downcast_ref::<Problem>() {
            return ApiError::new(api.0, api.1.clone());
        }
        match db::server_code(&error) {
            Some(db::ER_DUP_ENTRY) => ApiError::new(409, "같은 이름의 항목이 이미 있습니다."),
            Some(db::ER_DBACCESS_DENIED | db::ER_TABLEACCESS_DENIED) => {
                ApiError::new(503, "관리 DB 계정에 설정 변경 권한이 없습니다. 서버의 DB 권한 설정을 확인해주세요.")
            }
            code => {
                eprintln!("[admin] request failed: {} {error:#}", code.map_or("unknown".into(), |c| c.to_string()));
                ApiError::new(500, "관리 데이터를 처리하지 못했습니다. DB 연결 상태를 확인한 뒤 다시 시도해주세요.")
            }
        }
    }
}
type ApiResult<T> = Result<T, ApiError>;

/// A user-facing refusal carried through anyhow inside transactions.
#[derive(Debug)]
struct Problem(u16, String);
impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.1)
    }
}
impl std::error::Error for Problem {}
fn problem(status: u16, message: impl Into<String>) -> anyhow::Error {
    Problem(status, message.into()).into()
}

pub fn router(app: Arc<App>) -> Router<Arc<App>> {
    Router::new()
        .route("/database-options", get(database_options))
        .route("/directories", get(directories))
        .route("/settings", get(settings_get).put(settings_put))
        .route("/settings/check", post(settings_check))
        .route("/mcp", get(mcp_list).post(mcp_create))
        .route("/mcp/{name}", get(mcp_read).put(mcp_update).delete(mcp_remove))
        .route("/mcp/{name}/restart", post(mcp_restart))
        .route("/mcp-check", post(mcp_check))
        .route("/{resource}", get(list).post(create))
        .route("/{resource}/{id}", get(read).put(update).delete(remove))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024 * 1024 - 1))
        .layer(middleware::from_fn_with_state(app, guard))
}

/// Admin requests come from the admin screen (a custom header a plain form
/// or link cannot send) and carry the admin key when one is set.
async fn guard(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let mut response = if headers.get("x-admin-request").and_then(|v| v.to_str().ok()) != Some("1") {
        ApiError::new(403, "관리자 화면에서 다시 시도해주세요.").into_response()
    } else if let Some(token) = app.config().admin_token.clone()
        && !token_matches(headers.get("x-admin-token"), &token.0)
    {
        ApiError::new(401, "관리자 인증 키를 입력해주세요.").into_response()
    } else {
        next.run(request).await
    };
    if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
        response = ApiError::new(413, "입력 내용이 너무 큽니다.").into_response();
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn token_matches(sent: Option<&HeaderValue>, token: &str) -> bool {
    use subtle::ConstantTimeEq;
    let sent = sent.map(|v| v.as_bytes()).unwrap_or_default();
    let a = Sha256::digest(sent);
    let b = Sha256::digest(token.as_bytes());
    a.ct_eq(&b).into()
}

fn body_json(bytes: &Bytes) -> ApiResult<Value> {
    let text = std::str::from_utf8(bytes).map_err(|_| ApiError::new(400, "입력 내용을 읽지 못했습니다."))?;
    serde_json::from_str(&crate::text::strip_lone_surrogate_escapes(text))
        .map_err(|_| ApiError::new(400, "입력 내용을 읽지 못했습니다."))
}

fn if_match(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::IF_MATCH)?.to_str().ok()?;
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    (inner.len() == 64 && inner.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| inner.to_owned())
}

fn require_revision(revision: &Option<String>) -> ApiResult<String> {
    revision
        .clone()
        .ok_or_else(|| ApiError::new(428, "항목을 다시 열어 최신 내용을 확인한 뒤 저장하거나 삭제해주세요."))
}

fn hmac_revision(app: &App, kind: &str, fingerprint: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&app.revision_key).expect("hmac key");
    mac.update(format!("{kind}:{fingerprint}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn record(row: Value, status: StatusCode) -> Response {
    let revision = row["revision"].as_str().unwrap_or_default().to_owned();
    let mut response = (status, Json(row)).into_response();
    if let Ok(etag) = HeaderValue::from_str(&format!("\"{revision}\"")) {
        response.headers_mut().insert(header::ETAG, etag);
    }
    response
}

// ===== Management tables =====

struct Resource {
    table: &'static str,
    name: &'static str,
    summary: &'static str,
    /// (field, character limit, required)
    fields: &'static [(&'static str, Option<usize>, bool)],
}

fn resource(kind: &str) -> Option<&'static Resource> {
    const DATABASES: Resource = Resource {
        table: "target_db",
        name: "db_name",
        summary: "connection_info",
        fields: &[
            ("db_name", Some(100), true),
            ("db_type", Some(20), true),
            ("connection_info", Some(500), true),
            ("db_user", Some(100), true),
            ("db_password", Some(200), true),
        ],
    };
    const KNOWLEDGE: Resource = Resource {
        table: "knowledge",
        name: "title",
        summary: "content",
        fields: &[("title", Some(200), true), ("content", None, true)],
    };
    const METHODS: Resource = Resource {
        table: "qa_method",
        name: "title",
        summary: "method",
        fields: &[("title", Some(200), true), ("method", None, true)],
    };
    const QUERIES: Resource = Resource {
        table: "query_registry",
        name: "query_name",
        summary: "query_desc",
        fields: &[
            ("query_type", Some(20), true),
            ("bind_config", None, false),
            ("query_name", Some(100), true),
            ("query_desc", None, false),
            ("input_desc", Some(1000), false),
            ("query_sql", None, true),
            ("output_desc", None, false),
            ("target_db_name", Some(500), true),
        ],
    };
    match kind {
        "databases" => Some(&DATABASES),
        "knowledge" => Some(&KNOWLEDGE),
        "methods" => Some(&METHODS),
        "queries" => Some(&QUERIES),
        _ => None,
    }
}

fn label(key: &str) -> &'static str {
    match key {
        "query_type" => "실행 유형",
        "bind_config" => "바인드 설정",
        "db_name" => "DB 이름",
        "db_type" => "DB 유형",
        "connection_info" => "접속 주소",
        "db_user" => "조회 대상 DB 사용자명",
        "db_password" => "조회 대상 DB 비밀번호",
        "title" => "제목",
        "content" => "지식 본문",
        "method" => "처리 방법",
        "query_name" => "쿼리 이름",
        "query_desc" => "쿼리 설명",
        "input_desc" => "입력 설명",
        "query_sql" => "SQL",
        "output_desc" => "출력 설명",
        "target_db_name" => "대상 DB",
        "name" => "프로젝트 이름",
        "description" => "프로젝트 설명",
        "root" => "프로젝트 폴더",
        "docs" => "참고 문서",
        "include" => "포함 패턴",
        "exclude" => "제외 패턴",
        _ => "입력값",
    }
}

const MAX_TEXT_BYTES: usize = 65535;

fn not_found() -> ApiError {
    ApiError::new(404, "관리 항목을 찾을 수 없습니다.")
}

fn record_id(raw: &str) -> ApiResult<i64> {
    let valid = !raw.is_empty()
        && raw.bytes().all(|b| b.is_ascii_digit())
        && !raw.starts_with('0')
        && raw.parse::<i64>().is_ok_and(|n| n <= 2_147_483_647);
    if valid {
        Ok(raw.parse().unwrap())
    } else {
        Err(ApiError::new(400, "올바른 항목 번호가 필요합니다."))
    }
}

/// The validated, trimmed values of a record.
pub fn validate_record(kind: &str, body: &Value, editing: bool) -> Result<Vec<(String, String)>, ApiError> {
    let config = resource(kind).ok_or_else(not_found)?;
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::new(400, "입력 내용을 확인해주세요."))?;
    let mut values: Vec<(String, String)> = vec![];
    for (key, limit, required) in config.fields {
        let raw = match object.get(*key) {
            Some(Value::String(s)) => s.clone(),
            Some(_) => return Err(ApiError::new(400, format!("{}은(는) 문자열이어야 합니다.", label(key)))),
            None if *key == "query_type" => "QUERY".into(),
            None => String::new(),
        };
        let value = if matches!(*key, "content" | "method" | "query_sql" | "db_password") {
            raw
        } else {
            js_trim(&raw).to_owned()
        };
        if *key == "db_password" && editing && value.is_empty() {
            continue;
        }
        if *required && js_trim(&value).is_empty() {
            return Err(ApiError::new(400, format!("{}을(를) 입력해주세요.", label(key))));
        }
        let too_long = match limit {
            Some(limit) => value.chars().count() > *limit,
            None => !(kind == "knowledge" && *key == "content") && value.len() > MAX_TEXT_BYTES,
        };
        if too_long {
            return Err(ApiError::new(
                400,
                format!(
                    "{}이(가) 너무 깁니다. {} 이내로 입력해주세요.",
                    label(key),
                    limit.map_or_else(|| "UTF-8 기준 65,535바이트".to_owned(), |l| format!("{l}자"))
                ),
            ));
        }
        if value.contains('\0') {
            return Err(ApiError::new(400, format!("{}에 사용할 수 없는 문자가 있습니다.", label(key))));
        }
        values.push(((*key).to_owned(), value));
    }
    let get = |values: &[(String, String)], key: &str| {
        values.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).unwrap_or_default()
    };
    if kind == "databases" {
        if get(&values, "db_type") != "oracle" {
            return Err(ApiError::new(400, "현재 조회 DB는 Oracle만 지원합니다."));
        }
        if get(&values, "db_name").contains(';') {
            return Err(ApiError::new(400, "DB 이름에는 세미콜론을 사용할 수 없습니다."));
        }
        if password_env_reference(&get(&values, "db_password")).is_some_and(|(_, valid)| !valid) {
            return Err(ApiError::new(400, "환경변수 참조는 ENV:변수명 형식으로 입력해주세요."));
        }
    }
    if kind == "queries" {
        crate::execution::execution_spec(
            &get(&values, "query_type"),
            &get(&values, "query_sql"),
            &get(&values, "bind_config"),
        )
        .map_err(|e| ApiError::new(400, e.to_string()))?;
        let names = target_db_names(&get(&values, "target_db_name"));
        if names.is_empty() {
            return Err(ApiError::new(400, "대상 DB를 하나 이상 선택해주세요."));
        }
        for (k, v) in values.iter_mut() {
            if k == "target_db_name" {
                *v = names.join(";");
            }
        }
    }
    Ok(values)
}

fn public_columns(config: &Resource) -> String {
    let mut columns = vec!["seq".to_owned()];
    columns.extend(
        config
            .fields
            .iter()
            .map(|(f, _, _)| *f)
            .filter(|f| *f != "db_password")
            .map(str::to_owned),
    );
    if config.table == "target_db" {
        columns.push("(db_password IS NOT NULL AND db_password <> '') AS has_password".into());
    }
    let all: Vec<&str> = config.fields.iter().map(|(f, _, _)| *f).collect();
    columns.push(format!("SHA2(JSON_ARRAY(seq, {}), 256) AS _fingerprint", all.join(", ")));
    columns.join(", ")
}

/// A record by number, with its revision; `conn` reads inside a write.
async fn get_record(app: &App, kind: &str, id: i64, conn: Option<&mut db::Conn>, lock: bool) -> anyhow::Result<Value> {
    let config = resource(kind).ok_or_else(|| problem(404, "관리 항목을 찾을 수 없습니다."))?;
    let sql = format!(
        "SELECT {} FROM {} WHERE seq = ?{}",
        public_columns(config),
        config.table,
        if lock { " FOR UPDATE" } else { "" }
    );
    let cfg = app.config();
    let rows = match conn {
        Some(conn) => query_on(&cfg.mariadb, conn, &sql, vec![n(id)]).await?,
        None => app.db.query(&cfg.mariadb, &sql, vec![n(id)]).await?,
    };
    let Some(mut row) = rows.into_iter().next() else {
        return Err(problem(404, "항목이 없거나 이미 삭제되었습니다. 목록을 새로고침해주세요."));
    };
    let fingerprint = db::text(&row, "_fingerprint");
    row.remove("_fingerprint");
    row.insert("revision".into(), json!(hmac_revision(app, kind, &fingerprint)));
    Ok(Value::Object(row))
}

/// Runs `work` in a transaction under the admin lock.
async fn write_transaction<T>(
    app: &App,
    work: impl AsyncFnOnce(&mut db::Conn) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let cfg = app.config();
    let cfg = &cfg.mariadb;
    let mut conn = app.db.conn(cfg).await?;
    let acquired = query_on(cfg, &mut conn, "SELECT GET_LOCK(CONCAT(DATABASE(), ':admin'), 5) AS acquired", vec![]).await?;
    if acquired.first().map_or(0, |r| db::int(r, "acquired")) != 1 {
        return Err(problem(409, "다른 설정을 저장 중입니다. 잠시 후 다시 시도해주세요."));
    }
    let result = async {
        plain_on(cfg, &mut conn, "START TRANSACTION").await?;
        match work(&mut conn).await {
            Ok(value) => {
                plain_on(cfg, &mut conn, "COMMIT").await?;
                Ok(value)
            }
            Err(e) => {
                let _ = plain_on(cfg, &mut conn, "ROLLBACK").await;
                Err(e)
            }
        }
    }
    .await;
    if plain_on(cfg, &mut conn, "SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':admin'))").await.is_err() {
        drop(conn);
    }
    result
}

async fn check_references(app: &App, kind: &str, row: &Value, conn: &mut db::Conn) -> anyhow::Result<()> {
    let cfg = app.config();
    let cfg = &cfg.mariadb;
    if kind == "databases" {
        let trim = "^[\u{9}-\u{d}\u{20}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+|[\u{9}-\u{d}\u{20}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+$";
        let refs = query_on(
            cfg,
            conn,
            "SELECT q.query_name FROM query_registry q
             JOIN JSON_TABLE(CONCAT('[', REPLACE(JSON_QUOTE(q.target_db_name), ';', '\",\"'), ']'),
               '$[*]' COLUMNS (db_name VARCHAR(500) PATH '$')) AS names
             JOIN target_db t ON t.db_name = REGEXP_REPLACE(names.db_name, ?, '')
             WHERE t.seq = ? LIMIT 1",
            vec![p(trim), n(row["seq"].as_i64().unwrap_or(0))],
        )
        .await?;
        if let Some(r) = refs.first() {
            return Err(problem(
                409,
                format!(
                    "이 조회 대상 DB는 쿼리 '{}'에서 사용 중입니다. 대상 DB 설정을 먼저 변경해주세요.",
                    db::text(r, "query_name")
                ),
            ));
        }
    }
    if kind == "queries" {
        let methods = query_on(cfg, conn, "SELECT title, method FROM qa_method", vec![]).await?;
        let name = row["query_name"].as_str().unwrap_or_default();
        if let Some(m) = methods.iter().find(|m| name_index_of(&db::text(m, "method"), name).is_some()) {
            return Err(problem(
                409,
                format!(
                    "이 쿼리는 처리 방법 '{}'에서 사용 중입니다. 처리 방법을 먼저 변경해주세요.",
                    db::text(m, "title")
                ),
            ));
        }
    }
    Ok(())
}

async fn save_record(app: &App, kind: &str, body: &Value, id: Option<i64>, revision: Option<String>) -> ApiResult<Value> {
    let config = resource(kind).ok_or_else(not_found)?;
    let revision = match id {
        Some(_) => Some(require_revision(&revision)?),
        None => None,
    };
    let mut values = validate_record(kind, body, id.is_some())?;
    let cfg = app.config();
    let saved = write_transaction(app, async |conn| {
        let mut id = id;
        if let Some(id) = id {
            let old = get_record(app, kind, id, Some(conn), true).await?;
            if old["revision"].as_str() != revision.as_deref() {
                return Err(problem(
                    409,
                    "이 항목은 다른 화면에서 변경되었습니다. 입력 내용을 보관한 뒤 항목을 다시 열어 확인해주세요.",
                ));
            }
            // The stored password goes only to the address it was entered
            // for: kept (left empty) beside a new address, the next query
            // logged in there with it.
            let value = |key: &str| values.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
            if kind == "databases"
                && old["has_password"] == json!(1)
                && value("db_password").is_none()
                && old["connection_info"].as_str() != value("connection_info")
            {
                return Err(problem(
                    400,
                    "접속 주소가 바뀌어 저장된 비밀번호를 새 주소로 보내지 않습니다. 조회 대상 DB 비밀번호를 다시 입력해주세요.",
                ));
            }
            let new_name = values.iter().find(|(k, _)| k == config.name).map(|(_, v)| v.as_str());
            if matches!(kind, "databases" | "queries") && old[config.name].as_str() != new_name {
                check_references(app, kind, &old, conn).await?;
            }
        }
        if kind == "queries" {
            let names = target_db_names(
                &values.iter().find(|(k, _)| k == "target_db_name").map(|(_, v)| v.clone()).unwrap_or_default(),
            );
            let rows = query_on(
                &cfg.mariadb,
                conn,
                &format!("SELECT db_name FROM target_db WHERE db_name IN ({})", marks(names.len())),
                names.iter().map(|n| p(n.clone())).collect(),
            )
            .await?;
            if rows.len() != names.len() {
                return Err(problem(400, "등록되지 않은 조회 대상 DB가 있습니다. 조회 대상 DB 탭에서 먼저 등록해주세요."));
            }
            let canonical: Vec<String> = rows.iter().map(|r| db::text(r, "db_name")).collect();
            for (k, v) in values.iter_mut() {
                if k == "target_db_name" {
                    *v = canonical.join(";");
                }
            }
        }
        let params: Vec<Param> = values.iter().map(|(_, v)| p(v.clone())).collect();
        match id {
            Some(existing) => {
                let mut params = params;
                params.push(n(existing));
                exec_on(
                    &cfg.mariadb,
                    conn,
                    &format!(
                        "UPDATE {} SET {} WHERE seq = ?",
                        config.table,
                        values.iter().map(|(k, _)| format!("{k} = ?")).collect::<Vec<_>>().join(", ")
                    ),
                    params,
                )
                .await?;
            }
            None => {
                let (_, last) = exec_on(
                    &cfg.mariadb,
                    conn,
                    &format!(
                        "INSERT INTO {} ({}) VALUES ({})",
                        config.table,
                        values.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", "),
                        marks(values.len())
                    ),
                    params,
                )
                .await?;
                id = Some(last as i64);
            }
        }
        get_record(app, kind, id.unwrap(), Some(conn), false).await
    })
    .await?;
    Ok(saved)
}

#[derive(Deserialize, Default)]
struct ListQuery {
    q: Option<String>,
    page: Option<String>,
}

async fn list(State(app): State<Arc<App>>, Path(kind): Path<String>, Query(query): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let q = query.q.unwrap_or_default();
    let page = query.page.unwrap_or_else(|| "1".into());
    let page_ok = !page.is_empty()
        && page.len() <= 6
        && page.bytes().all(|b| b.is_ascii_digit())
        && !page.starts_with('0');
    if utf16_len(&q) > 200 || !page_ok {
        return Err(ApiError::new(400, "검색어나 페이지 번호를 확인해주세요."));
    }
    let page: i64 = page.parse().unwrap_or(1);
    if kind == "projects" {
        return Ok(Json(project_list(&app, &q, page)));
    }
    let config = resource(&kind).ok_or_else(not_found)?;
    let cfg = app.config();
    let searchable: Vec<&str> = config.fields.iter().map(|(f, _, _)| *f).filter(|f| *f != "db_password").collect();
    let term = js_trim(&q).to_owned();
    let (filter, params): (String, Vec<Param>) = if term.is_empty() {
        (String::new(), vec![])
    } else {
        (
            format!("WHERE {}", searchable.iter().map(|f| format!("LOCATE(?, {f}) > 0")).collect::<Vec<_>>().join(" OR ")),
            searchable.iter().map(|_| p(term.clone())).collect(),
        )
    };
    let count = app
        .db
        .query(&cfg.mariadb, &format!("SELECT COUNT(*) AS total FROM {} {filter}", config.table), params.clone())
        .await?;
    let total = count.first().map_or(0, |r| db::int(r, "total"));
    let current = page.min(((total + 19) / 20).max(1));
    let mut params = params;
    params.push(n((current - 1) * 20));
    let items = app
        .db
        .query(
            &cfg.mariadb,
            &format!(
                "SELECT seq, {} AS name, LEFT({}, 160) AS summary{} FROM {} {filter} ORDER BY seq DESC LIMIT 20 OFFSET ?",
                config.name,
                config.summary,
                if kind == "queries" { ", query_type" } else { "" },
                config.table
            ),
            params,
        )
        .await?;
    Ok(Json(json!({"items":items,"total":total,"page":current,"pageSize":20})))
}

async fn read(State(app): State<Arc<App>>, Path((kind, id)): Path<(String, String)>) -> ApiResult<Response> {
    if kind == "projects" {
        let project = find_project(&app, &id)?;
        return Ok(record(project_view(&app, &project), StatusCode::OK));
    }
    resource(&kind).ok_or_else(not_found)?;
    let id = record_id(&id)?;
    Ok(record(get_record(&app, &kind, id, None, false).await?, StatusCode::OK))
}

async fn create(State(app): State<Arc<App>>, Path(kind): Path<String>, body: Bytes) -> ApiResult<Response> {
    let body = body_json(&body)?;
    if kind == "projects" {
        return Ok(record(save_project(&app, &body, None, None).await?, StatusCode::CREATED));
    }
    Ok(record(save_record(&app, &kind, &body, None, None).await?, StatusCode::CREATED))
}

async fn update(State(app): State<Arc<App>>, Path((kind, id)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let body = body_json(&body)?;
    if kind == "projects" {
        return Ok(record(save_project(&app, &body, Some(&id), if_match(&headers)).await?, StatusCode::OK));
    }
    resource(&kind).ok_or_else(not_found)?;
    let id = record_id(&id)?;
    Ok(record(save_record(&app, &kind, &body, Some(id), if_match(&headers)).await?, StatusCode::OK))
}

async fn remove(State(app): State<Arc<App>>, Path((kind, id)): Path<(String, String)>, headers: HeaderMap) -> ApiResult<StatusCode> {
    let revision = require_revision(&if_match(&headers))?;
    if kind == "projects" {
        let _guard = app.config_write.lock().await;
        let project = find_project(&app, &id)?;
        if project_revision(&app, &project) != revision {
            return Err(ApiError::new(409, "이 항목은 다른 화면에서 변경되었습니다. 입력 내용을 보관한 뒤 항목을 다시 열어 확인해주세요."));
        }
        let mut config = (*app.config()).clone();
        config.projects.retain(|p| p.seq != project.seq);
        app.store_config(config).map_err(|e| ApiError::new(500, format!("설정을 저장하지 못했습니다: {e}")))?;
        return Ok(StatusCode::NO_CONTENT);
    }
    let config = resource(&kind).ok_or_else(not_found)?;
    let id = record_id(&id)?;
    write_transaction(&app, async |conn| {
        let row = get_record(&app, &kind, id, Some(conn), true).await?;
        if row["revision"].as_str() != Some(revision.as_str()) {
            return Err(problem(409, "이 항목은 다른 화면에서 변경되었습니다. 입력 내용을 보관한 뒤 항목을 다시 열어 확인해주세요."));
        }
        check_references(&app, &kind, &row, conn).await?;
        let cfg = app.config();
        exec_on(&cfg.mariadb, conn, &format!("DELETE FROM {} WHERE seq = ?", config.table), vec![n(id)]).await?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn database_options(State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let cfg = app.config();
    let items = app
        .db
        .query(&cfg.mariadb, "SELECT seq, db_name FROM target_db ORDER BY db_name", vec![])
        .await?;
    Ok(Json(json!({"items":items})))
}

// ===== Projects (config.toml) =====

fn lines(values: &[String]) -> String {
    values.join("\n")
}
fn split_lines(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        Value::String(text) => text.lines().map(js_trim).filter(|l| !l.is_empty()).map(str::to_owned).collect(),
        _ => vec![],
    }
}

fn project_revision(app: &App, project: &Project) -> String {
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(project).unwrap_or_default()));
    hmac_revision(app, "projects", &fingerprint)
}

fn project_view(app: &App, project: &Project) -> Value {
    json!({
        "seq":project.seq,"name":project.name,"description":project.description,
        "root":project.root,"docs":lines(&project.docs),"include":lines(&project.include),
        "exclude":lines(&project.exclude),"revision":project_revision(app, project)
    })
}

fn find_project(app: &App, id: &str) -> ApiResult<Project> {
    let seq: u64 = id.parse().map_err(|_| ApiError::new(400, "올바른 항목 번호가 필요합니다."))?;
    app.config()
        .projects
        .iter()
        .find(|p| p.seq == seq)
        .cloned()
        .ok_or_else(|| ApiError::new(404, "항목이 없거나 이미 삭제되었습니다. 목록을 새로고침해주세요."))
}

fn project_list(app: &App, q: &str, page: i64) -> Value {
    let term = js_trim(q).to_lowercase();
    let mut items: Vec<&Project> = Vec::new();
    let config = app.config();
    for project in config.projects.iter().rev() {
        let haystack = format!("{}\n{}\n{}", project.name, project.description, project.root.display()).to_lowercase();
        if term.is_empty() || haystack.contains(&term) {
            items.push(project);
        }
    }
    let total = items.len() as i64;
    let current = page.min(((total + 19) / 20).max(1));
    let shown: Vec<Value> = items
        .into_iter()
        .skip(((current - 1) * 20) as usize)
        .take(20)
        .map(|p| {
            let summary = if p.description.trim().is_empty() {
                p.root.display().to_string()
            } else {
                p.description.chars().take(160).collect()
            };
            json!({"seq":p.seq,"name":p.name,"summary":summary})
        })
        .collect();
    json!({"items":shown,"total":total,"page":current,"pageSize":20})
}

async fn save_project(app: &App, body: &Value, id: Option<&str>, revision: Option<String>) -> ApiResult<Value> {
    let object = body.as_object().ok_or_else(|| ApiError::new(400, "입력 내용을 확인해주세요."))?;
    for key in ["name", "description", "root", "docs", "include", "exclude"] {
        if let Some(value) = object.get(key)
            && !value.is_string()
            && !(value.is_array() && matches!(key, "docs" | "include" | "exclude"))
        {
            return Err(ApiError::new(400, format!("{}은(는) 문자열이어야 합니다.", label(key))));
        }
    }
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(js_trim).unwrap_or_default().to_owned();
    let _guard = app.config_write.lock().await;
    let mut config = (*app.config()).clone();
    let mut project = match id {
        Some(id) => {
            let existing = find_project(app, id)?;
            let revision = require_revision(&revision)?;
            if project_revision(app, &existing) != revision {
                return Err(ApiError::new(409, "이 항목은 다른 화면에서 변경되었습니다. 입력 내용을 보관한 뒤 항목을 다시 열어 확인해주세요."));
            }
            existing
        }
        None => Project::default(),
    };
    project.name = text("name");
    project.description = text("description");
    project.root = std::path::PathBuf::from(text("root"));
    project.docs = split_lines(object.get("docs").unwrap_or(&Value::Null));
    project.include = split_lines(object.get("include").unwrap_or(&Value::Null));
    project.exclude = split_lines(object.get("exclude").unwrap_or(&Value::Null));
    crate::projects::validate(&project).map_err(|e| ApiError::new(400, e.to_string()))?;
    // The folders are looked at on a blocking thread, as the folder browser
    // reads them: one that did not answer (a network drive gone) held a
    // thread serving every request, questions' too.
    let checked = project.clone();
    tokio::task::spawn_blocking(move || crate::projects::check_paths(&checked))
        .await
        .map_err(|_| ApiError::new(500, "프로젝트 폴더를 확인하지 못했습니다."))?
        .map_err(|e| ApiError::new(400, e.to_string()))?;
    if config
        .projects
        .iter()
        .any(|p| p.seq != project.seq && name_key(&p.name) == name_key(&project.name))
    {
        return Err(ApiError::new(409, "같은 이름의 항목이 이미 있습니다."));
    }
    match config.projects.iter_mut().find(|p| p.seq == project.seq && project.seq != 0) {
        Some(slot) => *slot = project.clone(),
        None => config.projects.push(project.clone()),
    }
    let stored = app
        .store_config(config)
        .map_err(|e| ApiError::new(500, format!("설정을 저장하지 못했습니다: {e}")))?;
    let saved = stored
        .projects
        .iter()
        .find(|p| name_key(&p.name) == name_key(&project.name))
        .cloned()
        .unwrap_or(project);
    Ok(project_view(app, &saved))
}

// ===== Folder browsing =====

#[derive(Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

async fn directories(Query(query): Query<DirectoryQuery>) -> ApiResult<Json<Value>> {
    let listing = tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
        let start = match query.path.filter(|p| !p.trim().is_empty()) {
            Some(path) => std::path::PathBuf::from(path),
            None => std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(std::path::PathBuf::from)
                .unwrap_or(std::env::current_dir()?),
        };
        let path = start.canonicalize()?;
        crate::tools::utf8_path(&path)?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&path)? {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let entry_path = entry.path();
            if entry_path.to_str().is_none() {
                continue;
            }
            if entries.len() == MAX_DIRECTORY_ENTRIES {
                anyhow::bail!("하위 폴더가 너무 많습니다. 원하는 폴더 경로를 직접 입력하세요.");
            }
            entries.push(json!({"name":entry.file_name().to_string_lossy(),"path":entry_path}));
        }
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(json!({"path":path,"parent":path.parent(),"directories":entries}))
    })
    .await
    .map_err(|_| ApiError::new(500, "폴더를 읽지 못했습니다."))?
    .map_err(|e| ApiError::new(400, format!("폴더를 열 수 없습니다: {e}")))?;
    Ok(Json(listing))
}

// ===== Settings =====

fn settings_view(app: &App, config: &Config) -> Value {
    let mut sections = serde_json::to_value(config).unwrap_or_default();
    if let Some(fields) = sections.as_object_mut() {
        fields.remove("projects");
        fields.remove("mcp_servers");
    }
    let started = &app.started;
    let mut restart = vec![];
    if config.server.port != started.server.port {
        restart.push("server.port");
    }
    if config.oracle.client_lib_dir != started.oracle.client_lib_dir {
        restart.push("oracle.client_lib_dir");
    }
    if config.oracle.client_config_dir != started.oracle.client_config_dir {
        restart.push("oracle.client_config_dir");
    }
    let client = match app.oracle.client_state() {
        None => json!({"loaded":false,"message":"아직 Oracle 조회를 하지 않아 클라이언트를 불러오지 않았습니다."}),
        Some(Ok(version)) => json!({"loaded":true,"message":format!("Oracle 클라이언트 {version}")}),
        Some(Err(error)) => json!({"loaded":false,"message":error}),
    };
    json!({
        "config":sections,
        "secrets":{
            "llm_api_key":config.llm.api_key.is_some(),
            "mariadb_password":config.mariadb.password.is_some(),
            "admin_token":config.admin_token.is_some()
        },
        "revision":config.revision(),
        "restart_required":restart,
        "status":{"oracle_client":client}
    })
}

async fn settings_get(State(app): State<Arc<App>>) -> Response {
    let config = app.config();
    record(settings_view(&app, &config), StatusCode::OK)
}

/// The settings a request describes: its `config` sections over the current
/// ones, and its `secrets` (absent keeps, null clears, text sets).
fn draft(current: &Config, body: &Value) -> ApiResult<Config> {
    let mut merged = serde_json::to_value(current).unwrap_or_default();
    if let Some(sections) = body["config"].as_object() {
        for (key, value) in sections {
            // Projects and MCP servers have their own editors.
            if key == "projects" || key == "mcp_servers" {
                continue;
            }
            let Some(section) = merged.get_mut(key) else {
                return Err(ApiError::new(400, format!("알 수 없는 설정 항목입니다: {key}")));
            };
            match (section.as_object_mut(), value.as_object()) {
                (Some(section), Some(fields)) => {
                    for (field, value) in fields {
                        section.insert(field.clone(), value.clone());
                    }
                }
                _ => *section = value.clone(),
            }
        }
    }
    let mut config: Config = serde_json::from_value(merged)
        .map_err(|e| ApiError::new(400, format!("설정 형식이 올바르지 않습니다: {e}")))?;
    config.projects = current.projects.clone();
    config.mcp_servers = current.mcp_servers.clone();
    config.llm.api_key = current.llm.api_key.clone();
    config.mariadb.password = current.mariadb.password.clone();
    config.admin_token = current.admin_token.clone();
    if let Some(secrets) = body["secrets"].as_object() {
        for (key, value) in secrets {
            let secret = match value {
                Value::Null => None,
                Value::String(s) if !s.is_empty() => Some(Secret(s.clone())),
                Value::String(_) => None,
                _ => return Err(ApiError::new(400, "비밀값은 문자열이어야 합니다.")),
            };
            match key.as_str() {
                "llm_api_key" => config.llm.api_key = secret,
                "mariadb_password" => config.mariadb.password = secret,
                "admin_token" => config.admin_token = secret,
                _ => return Err(ApiError::new(400, format!("알 수 없는 비밀값입니다: {key}"))),
            }
        }
    }
    // A stored secret goes only where it was entered for, as an MCP
    // server's secret headers do: with the address alone changed, the API
    // key went to the new host as a bearer token (a connection check sent it
    // without a save), and the management DB password to a server that asks
    // for it encrypted with a key of its own (caching_sha2 without TLS).
    let answered = |key: &str| body["secrets"].get(key).is_some_and(|v| v.is_null() || v.as_str().is_some_and(|v| !v.is_empty()));
    if current.llm.api_key.is_some() && !answered("llm_api_key") && moved(llm_destination(&current.llm), llm_destination(&config.llm)) {
        return Err(ApiError::new(
            400,
            "LLM 주소의 호스트가 바뀌어 저장된 API 키를 새 주소로 보내지 않습니다. API 키를 다시 넣거나 지운 뒤 저장하거나 확인해주세요.",
        ));
    }
    if current.mariadb.password.is_some() && !answered("mariadb_password") && moved(mariadb_destination(&current.mariadb), mariadb_destination(&config.mariadb)) {
        return Err(ApiError::new(
            400,
            "관리 DB 호스트·포트가 바뀌어 저장된 비밀번호를 새 주소로 보내지 않습니다. 비밀번호를 다시 넣거나 지운 뒤 저장하거나 확인해주세요.",
        ));
    }
    Ok(config)
}

/// Whether a secret's destination changed: an address that does not read
/// is refused by the settings check, not here.
fn moved<T: PartialEq>(before: Option<T>, after: Option<T>) -> bool {
    after.is_some() && before != after
}

/// Scheme, host, port, and the proxy a plain-HTTP request goes through.
type Destination = (String, Option<String>, Option<u16>, Option<String>);

/// Where the LLM API key is sent: the base URL's scheme, host and port, and
/// the proxy a plain-HTTP request goes through (it reads the key there).
fn llm_destination(llm: &crate::config::LlmConfig) -> Option<Destination> {
    let url = reqwest::Url::parse(llm.base_url.trim()).ok()?;
    let proxy = (url.scheme() == "http" && !llm.disable_proxy)
        .then(|| llm.proxy.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned))
        .flatten();
    Some((url.scheme().to_owned(), url.host_str().map(str::to_ascii_lowercase), url.port_or_known_default(), proxy))
}

/// Where the management DB password is sent.
fn mariadb_destination(cfg: &crate::config::MariaDbConfig) -> Option<(String, u16)> {
    Some((cfg.host.trim().to_ascii_lowercase(), cfg.port))
}

async fn settings_put(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let body = body_json(&body)?;
    let revision = require_revision(&if_match(&headers))?;
    let _guard = app.config_write.lock().await;
    let current = app.config();
    if current.revision() != revision {
        return Err(ApiError::new(409, "설정이 다른 화면에서 변경되었습니다. 다시 열어 확인해주세요."));
    }
    let config = draft(&current, &body)?;
    config.validate().map_err(|e| ApiError::new(400, e.to_string()))?;
    let stored = app
        .store_config(config)
        .map_err(|e| ApiError::new(500, format!("설정을 저장하지 못했습니다: {e}")))?;
    Ok(record(settings_view(&app, &stored), StatusCode::OK))
}

/// Tries a connection with the draft settings without saving them.
async fn settings_check(State(app): State<Arc<App>>, body: Bytes) -> ApiResult<Json<Value>> {
    let body = body_json(&body)?;
    let config = draft(&app.config(), &body)?;
    let target = body["target"].as_str().unwrap_or_default().to_owned();
    let outcome: anyhow::Result<String> = match target.as_str() {
        "llm" => async {
            config.llm.runnable()?;
            crate::llm::OpenAiClient.probe(&config.llm).await?;
            Ok(format!("{} 모델이 일반 응답·스트리밍·도구 호출에 응답했습니다.", config.llm.model))
        }
        .await,
        "embedding" => async {
            if !config.embedding.enabled() {
                anyhow::bail!("임베딩 주소가 비어 있습니다. 비우면 벡터 검색을 쓰지 않습니다.");
            }
            config.embedding.validate()?;
            let start = std::time::Instant::now();
            crate::embedding::embed(&config.embedding, &["연결 확인".to_owned()], &Default::default())
                .await
                .map_err(|e| anyhow::anyhow!(e.message))?;
            Ok(format!(
                "{} 모델이 {}차원 벡터를 돌려주었습니다 ({} ms).",
                config.embedding.model,
                crate::config::EMBEDDING_DIMENSIONS,
                start.elapsed().as_millis()
            ))
        }
        .await,
        "mariadb" => async {
            // The draft is not saved, so nothing has checked it yet: a pool
            // size past the limit would be allocated as given.
            config.mariadb.validate()?;
            let probe = crate::db::Db::default();
            let rows = probe
                .query(
                    &config.mariadb,
                    "SELECT (SELECT COUNT(*) FROM knowledge) AS knowledge, (SELECT COUNT(*) FROM qa_method) AS methods, (SELECT COUNT(*) FROM query_registry) AS queries",
                    vec![],
                )
                .await;
            probe.close().await;
            let rows = rows?;
            let r = rows.first().cloned().unwrap_or_default();
            Ok(format!(
                "접속했습니다. 지식 {}건, 처리 방법 {}건, 쿼리 {}건이 등록되어 있습니다.",
                db::int(&r, "knowledge"),
                db::int(&r, "methods"),
                db::int(&r, "queries")
            ))
        }
        .await,
        "oracle_client" => match app.oracle.load_client(&app.started.oracle).await {
            Ok(version) => Ok(format!("Oracle 클라이언트 {version}을(를) 불러왔습니다.")),
            Err(e) => Err(anyhow::anyhow!(
                "Oracle 클라이언트를 불러오지 못했습니다: {e} (폴더 설정은 서버를 다시 시작해야 적용됩니다)"
            )),
        },
        _ => return Err(ApiError::new(400, "확인할 대상을 llm, embedding, mariadb, oracle_client 중에서 골라주세요.")),
    };
    Ok(Json(match outcome {
        Ok(message) => json!({"ok":true,"message":message}),
        Err(e) => json!({"ok":false,"message":format!("{e:#}")}),
    }))
}

// ===== MCP servers (config.toml, docs/mcp-design.md) =====

/// Why the screen may not change MCP servers, if it may not. A server runs
/// a command on the server PC, so it takes an admin key — one the backend
/// started with: while no key is set the admin API is open, and whoever set
/// a key first could otherwise add a command at once. A key set since the
/// start counts after a restart, which needs the server PC. Editing
/// config.toml always works.
fn mcp_lock(app: &App) -> Option<&'static str> {
    if app.config().admin_token.is_none() {
        Some("MCP 서버는 서버 PC에서 명령을 실행하는 설정이라 관리자 인증 키를 등록한 뒤에만 화면에서 바꿀 수 있습니다. 설정 탭에서 관리자 인증 키를 먼저 등록하고 backend를 다시 시작하거나, config.toml을 직접 고쳐주세요.")
    } else if app.started.admin_token.is_none() {
        Some("관리자 인증 키가 backend가 시작된 뒤에 등록되었습니다. 키 없이 열려 있던 동안 다른 사람이 먼저 키를 등록했을 수도 있어, MCP 서버(명령 실행)는 backend를 다시 시작한 뒤부터 화면에서 바꿀 수 있습니다. config.toml 직접 편집은 지금도 됩니다.")
    } else {
        None
    }
}

fn require_admin_key(app: &App) -> ApiResult<()> {
    match mcp_lock(app) {
        Some(reason) => Err(ApiError::new(403, reason)),
        None => Ok(()),
    }
}

fn mcp_revision(app: &App, server: &McpServer) -> String {
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(server).unwrap_or_default());
    for (kind, values) in [("env", &server.secret_env), ("headers", &server.secret_headers)] {
        for (key, value) in values {
            for part in [kind, key.as_str(), value.0.as_str()] {
                hash.update(part.len().to_le_bytes());
                hash.update(part.as_bytes());
            }
        }
    }
    hmac_revision(app, "mcp", &hex::encode(hash.finalize()))
}

/// A server as the screen edits it: secrets by name only, with its live
/// state.
fn mcp_view(app: &App, server: &McpServer) -> Value {
    let config = app.config();
    json!({
        "name":server.name,"description":server.description,"enabled":server.enabled,
        "transport":if server.url.trim().is_empty() { "stdio" } else { "http" },
        "command":server.command,"args":server.args,"cwd":server.cwd,"url":server.url,
        "disable_proxy":server.disable_proxy,"tools":server.tools,"timeout_secs":server.timeout_secs,"env":server.env,"headers":server.headers,
        "secrets":{"env":server.secret_env.keys().collect::<Vec<_>>(),"headers":server.secret_headers.keys().collect::<Vec<_>>()},
        "revision":mcp_revision(app, server),
        "status":app.mcp.server_status(&server.name, &config.llm.model)
    })
}

fn find_mcp(app: &App, name: &str) -> ApiResult<McpServer> {
    app.config()
        .mcp_servers
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case(name))
        .cloned()
        .ok_or_else(|| ApiError::new(404, "MCP 서버가 없거나 이미 삭제되었습니다. 목록을 새로고침해주세요."))
}

async fn mcp_list(State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    // The first status after a listing counts every definition's tokens:
    // work for a blocking thread, not for the one serving requests.
    tokio::task::spawn_blocking(move || {
        let config = app.config();
        Json(json!({
            "servers":config.mcp_servers.iter().map(|s| mcp_view(&app, s)).collect::<Vec<_>>(),
            "default_timeout_secs":config.agent.tool_timeout_secs,
            "editable":mcp_lock(&app).is_none(),
            "locked_reason":mcp_lock(&app)
        }))
    })
    .await
    .map_err(|_| ApiError::new(500, "MCP 서버 상태를 만들지 못했습니다."))
}

/// One server as `mcp_view` shows it, its definitions' tokens counted on a
/// blocking thread as the listing's are: a server just connected (or
/// reconnected by a save) counts all of its definitions, up to a thousand.
async fn mcp_record(app: &Arc<App>, server: McpServer, status: StatusCode) -> ApiResult<Response> {
    let app = app.clone();
    let view = tokio::task::spawn_blocking(move || mcp_view(&app, &server))
        .await
        .map_err(|_| ApiError::new(500, "MCP 서버 상태를 만들지 못했습니다."))?;
    Ok(record(view, status))
}

async fn mcp_read(State(app): State<Arc<App>>, Path(name): Path<String>) -> ApiResult<Response> {
    let server = find_mcp(&app, &name)?;
    mcp_record(&app, server, StatusCode::OK).await
}

/// The server `body` describes over `server`: fields present replace it,
/// secrets are set (text), removed (null) or kept (absent). The fields of
/// the other connection kind are dropped.
fn mcp_draft(body: &Value, mut server: McpServer) -> ApiResult<McpServer> {
    let object = body.as_object().ok_or_else(|| ApiError::new(400, "입력 내용을 확인해주세요."))?;
    let (before_url, before_secrets): (String, Vec<String>) = (server.url.clone(), server.secret_headers.keys().cloned().collect());
    let before_headers = server.headers.clone();
    let before_name = server.name.clone();
    let bad = |key: &str| ApiError::new(400, format!("MCP 서버 설정의 {key} 값 형식이 올바르지 않습니다."));
    let text = |key: &str| -> ApiResult<Option<String>> {
        match object.get(key) {
            None => Ok(None),
            Some(Value::String(v)) => Ok(Some(v.clone())),
            Some(Value::Null) => Ok(Some(String::new())),
            Some(_) => Err(bad(key)),
        }
    };
    let list = |key: &str| -> ApiResult<Option<Vec<String>>> {
        match object.get(key) {
            None => Ok(None),
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad(key)))
                .collect::<ApiResult<Vec<_>>>()
                .map(Some),
            Some(Value::String(lines)) => Ok(Some(lines.lines().map(|l| l.trim_end_matches('\r').to_owned()).filter(|l| !l.trim().is_empty()).collect())),
            Some(_) => Err(bad(key)),
        }
    };
    let map = |key: &str| -> ApiResult<Option<std::collections::BTreeMap<String, String>>> {
        match object.get(key) {
            None => Ok(None),
            Some(Value::Object(fields)) => fields
                .iter()
                .map(|(k, v)| v.as_str().map(|v| (js_trim(k).to_owned(), v.to_owned())).ok_or_else(|| bad(key)))
                .collect::<ApiResult<_>>()
                .map(Some),
            Some(_) => Err(bad(key)),
        }
    };
    if let Some(v) = text("name")? {
        server.name = js_trim(&v).to_owned();
    }
    if let Some(v) = text("description")? {
        server.description = js_trim(&v).to_owned();
    }
    match object.get("enabled") {
        None => {}
        Some(Value::Bool(v)) => server.enabled = *v,
        Some(_) => return Err(bad("enabled")),
    }
    match object.get("disable_proxy") {
        None => {}
        Some(Value::Bool(v)) => server.disable_proxy = *v,
        Some(_) => return Err(bad("disable_proxy")),
    }
    if let Some(v) = text("command")? {
        server.command = js_trim(&v).to_owned();
    }
    if let Some(v) = text("cwd")? {
        server.cwd = js_trim(&v).to_owned();
    }
    if let Some(v) = text("url")? {
        server.url = js_trim(&v).to_owned();
    }
    if let Some(v) = list("args")? {
        server.args = v;
    }
    if let Some(v) = list("tools")? {
        let mut tools: Vec<String> = vec![];
        for tool in v.iter().map(|t| js_trim(t).to_owned()).filter(|t| !t.is_empty()) {
            if !tools.contains(&tool) {
                tools.push(tool);
            }
        }
        server.tools = tools;
    }
    // An entry naming a tool as the model sees it (`old__search`) follows a
    // renamed server, or no tool answers it any more and the tool leaves
    // every question unseen.
    if !before_name.is_empty() && server.name != before_name {
        let old = format!("{before_name}__");
        let mut tools: Vec<String> = vec![];
        for tool in &server.tools {
            let tool = match tool.strip_prefix(&old) {
                Some(rest) => format!("{}__{rest}", server.name),
                None => tool.clone(),
            };
            if !tools.contains(&tool) {
                tools.push(tool);
            }
        }
        server.tools = tools;
    }
    match object.get("timeout_secs") {
        None => {}
        Some(Value::Null) => server.timeout_secs = None,
        Some(Value::String(v)) if v.trim().is_empty() => server.timeout_secs = None,
        Some(v) => server.timeout_secs = Some(v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).ok_or_else(|| bad("timeout_secs"))?),
    }
    if let Some(v) = map("env")? {
        server.env = v;
    }
    if let Some(v) = map("headers")? {
        server.headers = v;
    }
    if let Some(secrets) = object.get("secrets") {
        let secrets = secrets.as_object().ok_or_else(|| bad("secrets"))?;
        for (kind, values) in secrets {
            let target = match kind.as_str() {
                "env" => &mut server.secret_env,
                "headers" => &mut server.secret_headers,
                _ => return Err(bad("secrets")),
            };
            // A header is one whatever the case of its name: a token entered
            // again as "Authorization" replaces the "authorization" stored.
            let folded = kind == "headers";
            let values = values.as_object().ok_or_else(|| bad("secrets"))?;
            if values.values().any(|v| !v.is_null() && !v.is_string()) {
                return Err(bad("secrets"));
            }
            // Removals first: the screen lists a value entered in another
            // case beside the stored one, and the stored one's removal may
            // follow it in the body.
            for removals in [true, false] {
                for (key, value) in values.iter().filter(|(_, v)| v.is_null() == removals) {
                    let key = js_trim(key).to_owned();
                    let other = |known: &String| if folded { !known.eq_ignore_ascii_case(&key) } else { *known != key };
                    match value.as_str() {
                        None => target.retain(|known, _| other(known)),
                        Some(v) if !v.is_empty() => {
                            target.retain(|known, _| other(known));
                            target.insert(key, Secret(v.to_owned()));
                        }
                        Some(_) => {}
                    }
                }
            }
        }
    }
    // Stored secret headers (a token) are not sent to another host than the
    // one they were entered for — a mistyped address would receive them.
    // Each must be entered again or removed in the same request.
    let origin = |url: &str| reqwest::Url::parse(url).ok().map(|u| (u.scheme().to_owned(), u.host_str().map(str::to_owned), u.port_or_known_default()));
    if !before_secrets.is_empty() && !server.url.is_empty() && origin(&before_url) != origin(&server.url) {
        // Answered: entered again or removed (an empty value keeps it).
        let answered = |key: &str| {
            object
                .get("secrets")
                .and_then(|s| s.get("headers"))
                .and_then(Value::as_object)
                .is_some_and(|h| {
                    h.iter().any(|(k, v)| js_trim(k).eq_ignore_ascii_case(key) && (v.is_null() || v.as_str().is_some_and(|v| !v.is_empty())))
                })
        };
        let unanswered: Vec<&str> = before_secrets.iter().map(String::as_str).filter(|key| !answered(key)).collect();
        if !unanswered.is_empty() {
            return Err(ApiError::new(
                400,
                format!(
                    "서버 주소의 호스트가 바뀌어 저장된 비밀 헤더({})를 새 주소로 보내지 않습니다. 비밀 헤더를 다시 넣거나 지운 뒤 저장해주세요.",
                    unanswered.join(", ")
                ),
            ));
        }
    }
    // A visible header that reads a secret from the backend's environment
    // (`ENV:WIKI_TOKEN`, as a file-managed server keeps its token) is a
    // stored secret too: kept as it was beside a new host, the token went
    // there. It is removed, and entered again once the address is saved.
    if !server.url.is_empty() && origin(&before_url) != origin(&server.url) {
        let kept: Vec<&str> = server
            .headers
            .iter()
            .filter(|(key, value)| {
                crate::text::password_env_reference(value).is_some()
                    && before_headers.iter().any(|(k, v)| k.eq_ignore_ascii_case(key) && v == *value)
            })
            .map(|(key, _)| key.as_str())
            .collect();
        if !kept.is_empty() {
            return Err(ApiError::new(
                400,
                format!(
                    "서버 주소의 호스트가 바뀌어 환경변수에서 읽는 헤더({})를 새 주소로 보내지 않습니다. 그 헤더를 지우고 주소를 저장한 뒤 다시 넣어주세요.",
                    kept.join(", ")
                ),
            ));
        }
    }
    if server.url.is_empty() {
        server.headers.clear();
        server.secret_headers.clear();
    } else if server.command.is_empty() {
        server.args.clear();
        server.cwd.clear();
        server.env.clear();
        server.secret_env.clear();
    }
    crate::mcp::validate_server(&server).map_err(|e| ApiError::new(400, e.to_string()))?;
    Ok(server)
}

fn store_mcp(app: &App, config: Config) -> ApiResult<()> {
    let stored = app
        .store_config(config)
        .map_err(|e| ApiError::new(500, format!("설정을 저장하지 못했습니다: {e}")))?;
    app.mcp.apply(&stored.mcp_servers);
    Ok(())
}

async fn mcp_create(State(app): State<Arc<App>>, body: Bytes) -> ApiResult<Response> {
    require_admin_key(&app)?;
    let body = body_json(&body)?;
    let server = mcp_draft(&body, McpServer::default())?;
    let _guard = app.config_write.lock().await;
    let mut config = (*app.config()).clone();
    if config.mcp_servers.iter().any(|s| s.name.eq_ignore_ascii_case(&server.name)) {
        return Err(ApiError::new(409, "같은 이름의 MCP 서버가 이미 있습니다."));
    }
    config.mcp_servers.push(server.clone());
    store_mcp(&app, config)?;
    mcp_record(&app, server, StatusCode::CREATED).await
}

const MCP_CHANGED: &str = "이 MCP 서버는 다른 화면에서 변경되었습니다. 입력 내용을 보관한 뒤 다시 열어 확인해주세요.";

async fn mcp_update(State(app): State<Arc<App>>, Path(name): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    require_admin_key(&app)?;
    let body = body_json(&body)?;
    let revision = require_revision(&if_match(&headers))?;
    let _guard = app.config_write.lock().await;
    let existing = find_mcp(&app, &name)?;
    if mcp_revision(&app, &existing) != revision {
        return Err(ApiError::new(409, MCP_CHANGED));
    }
    let server = mcp_draft(&body, existing.clone())?;
    let mut config = (*app.config()).clone();
    if config
        .mcp_servers
        .iter()
        .any(|s| !s.name.eq_ignore_ascii_case(&existing.name) && s.name.eq_ignore_ascii_case(&server.name))
    {
        return Err(ApiError::new(409, "같은 이름의 MCP 서버가 이미 있습니다."));
    }
    for slot in &mut config.mcp_servers {
        if slot.name.eq_ignore_ascii_case(&existing.name) {
            *slot = server.clone();
        }
    }
    store_mcp(&app, config)?;
    mcp_record(&app, server, StatusCode::OK).await
}

async fn mcp_remove(State(app): State<Arc<App>>, Path(name): Path<String>, headers: HeaderMap) -> ApiResult<StatusCode> {
    require_admin_key(&app)?;
    let revision = require_revision(&if_match(&headers))?;
    let _guard = app.config_write.lock().await;
    let existing = find_mcp(&app, &name)?;
    if mcp_revision(&app, &existing) != revision {
        return Err(ApiError::new(409, MCP_CHANGED));
    }
    let mut config = (*app.config()).clone();
    config.mcp_servers.retain(|s| !s.name.eq_ignore_ascii_case(&existing.name));
    store_mcp(&app, config)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn mcp_restart(State(app): State<Arc<App>>, Path(name): Path<String>) -> ApiResult<Response> {
    require_admin_key(&app)?;
    let server = find_mcp(&app, &name)?;
    if !app.mcp.restart(&server.name) {
        return Err(ApiError::new(409, "꺼진 서버는 다시 연결할 수 없습니다. 먼저 사용으로 바꿔 저장해주세요."));
    }
    mcp_record(&app, server, StatusCode::OK).await
}

/// Connects with the draft settings (over the stored ones of `original`,
/// its secrets included), lists the tools and disconnects.
async fn mcp_check(State(app): State<Arc<App>>, body: Bytes) -> ApiResult<Json<Value>> {
    require_admin_key(&app)?;
    let body = body_json(&body)?;
    let base = match body["original"].as_str().filter(|n| !n.is_empty()) {
        Some(name) => find_mcp(&app, name)?,
        None => McpServer::default(),
    };
    let server = mcp_draft(&body, base)?;
    let model = app.config().llm.model.clone();
    let result = app.mcp.probe(&server, &model).await.map_err(|e| ApiError::new(400, e.to_string()))?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_draft_reads_disable_proxy() {
        let base = McpServer { name: "web".into(), command: "node".into(), ..Default::default() };
        let direct = mcp_draft(&json!({"disable_proxy":true}), base.clone()).unwrap();
        assert!(direct.disable_proxy);
        // Absent keeps it; it is no field of one connection kind.
        assert!(mcp_draft(&json!({"url":"https://h/mcp","command":""}), direct.clone()).unwrap().disable_proxy);
        assert!(!mcp_draft(&json!({"disable_proxy":false}), direct).unwrap().disable_proxy);
        assert!(mcp_draft(&json!({"disable_proxy":"yes"}), base).is_err());
        // Saved only when on.
        let toml = |server: &McpServer| toml::to_string(server).unwrap();
        assert!(!toml(&McpServer::default()).contains("disable_proxy"));
        assert!(toml(&McpServer { disable_proxy: true, ..Default::default() }).contains("disable_proxy = true"));
    }

    /// Full review, 2026-10-22: a header read from the environment
    /// (`ENV:NAME`) went on to a new host with the address alone changed,
    /// where a secret header was refused.
    #[test]
    fn a_header_read_from_the_environment_stays_with_its_host() {
        let mut base = McpServer { name: "wiki".into(), url: "https://wiki.example.com/mcp".into(), tools: vec!["*".into()], ..Default::default() };
        base.headers.insert("Authorization".into(), "ENV:WIKI_TOKEN".into());
        base.headers.insert("X-Team".into(), "voc".into());
        let moved = json!({"url":"https://wiki.elsewhere.com/mcp","headers":{"Authorization":"ENV:WIKI_TOKEN","X-Team":"voc"}});
        let refused = mcp_draft(&moved, base.clone()).unwrap_err().message;
        assert!(refused.contains("Authorization") && !refused.contains("X-Team"), "{refused}");
        // The body leaving headers out keeps them, and so is refused too.
        assert!(mcp_draft(&json!({"url":"https://wiki.elsewhere.com/mcp"}), base.clone()).is_err());
        // Removed first, the address saves; the header goes in again after.
        let saved = mcp_draft(&json!({"url":"https://wiki.elsewhere.com/mcp","headers":{"X-Team":"voc"}}), base.clone()).unwrap();
        let again = mcp_draft(&json!({"headers":{"Authorization":"ENV:WIKI_TOKEN","X-Team":"voc"}}), saved).unwrap();
        assert_eq!(again.headers["Authorization"], "ENV:WIKI_TOKEN");
        // A new reference beside the new address is entered now, as is the
        // same host on another path.
        assert!(mcp_draft(&json!({"url":"https://wiki.elsewhere.com/mcp","headers":{"Authorization":"ENV:OTHER_TOKEN"}}), base.clone()).is_ok());
        assert!(mcp_draft(&json!({"url":"https://wiki.example.com/v2/mcp"}), base).is_ok());
    }

    #[test]
    fn records_are_validated_like_the_former_api() {
        let ok = validate_record("knowledge", &json!({"title":"  제목 ","content":" 본문 "}), false).unwrap();
        assert_eq!(ok, vec![("title".into(), "제목".into()), ("content".into(), " 본문 ".into())]);
        assert_eq!(validate_record("knowledge", &json!({"title":"t"}), false).err().unwrap().message, "지식 본문을(를) 입력해주세요.");
        assert!(validate_record("knowledge", &json!({"title":1,"content":"x"}), false).is_err());
        let long = "가".repeat(201);
        assert!(validate_record("knowledge", &json!({"title":long,"content":"x"}), false).is_err());
        let db = json!({"db_name":"A","db_type":"oracle","connection_info":"h:1/s","db_user":"u","db_password":""});
        assert!(validate_record("databases", &db, true).is_ok(), "an empty password keeps the stored one");
        assert!(validate_record("databases", &db, false).is_err());
        let mut bad = db.clone();
        bad["db_password"] = json!("ENV:1bad");
        assert!(validate_record("databases", &bad, true).is_err());
        let query = json!({"query_name":"q","query_sql":"SELECT 1 FROM dual","target_db_name":" A ; a ;B"});
        let values = validate_record("queries", &query, false).unwrap();
        assert!(values.contains(&("target_db_name".into(), "A;B".into())));
        assert!(values.contains(&("query_type".into(), "QUERY".into())));
        let mut bad = query.clone();
        bad["query_sql"] = json!("DELETE FROM t");
        assert!(validate_record("queries", &bad, false).is_err());
        assert!(validate_record("other", &query, false).is_err());
    }

    #[test]
    fn ids_and_revisions_are_checked() {
        assert!(record_id("12").is_ok());
        assert!(record_id("012").is_err());
        assert!(record_id("2147483648").is_err());
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_MATCH, HeaderValue::from_str(&format!("\"{}\"", "a".repeat(64))).unwrap());
        assert_eq!(if_match(&headers), Some("a".repeat(64)));
        headers.insert(header::IF_MATCH, HeaderValue::from_static("\"zz\""));
        assert_eq!(if_match(&headers), None);
        assert!(token_matches(Some(&HeaderValue::from_static("k")), "k"));
        assert!(!token_matches(None, "k"));
    }

    #[test]
    fn settings_drafts_keep_secrets_unless_named() {
        let mut current = Config::default();
        current.llm.api_key = Some(Secret("sk".into()));
        current.llm.base_url = "http://x/v1".into();
        let config = draft(&current, &json!({"config":{"llm":{"model":"m"}},"secrets":{"admin_token":"t"}})).unwrap();
        assert_eq!(config.llm.model, "m");
        assert_eq!(config.llm.base_url, "http://x/v1", "a partial section keeps its other fields");
        assert_eq!(config.llm.api_key.unwrap().0, "sk");
        assert_eq!(config.admin_token.unwrap().0, "t");
        let config = draft(&current, &json!({"secrets":{"llm_api_key":null}})).unwrap();
        assert!(config.llm.api_key.is_none());
        assert!(draft(&current, &json!({"config":{"nope":{}}})).is_err());
    }

    /// Settings review, 2026-10-22: with the address alone changed, the
    /// stored API key went to the new host (a connection check sent it at
    /// once), and the management DB password to the new server.
    #[test]
    fn stored_secrets_stay_with_the_address_they_were_entered_for() {
        let mut current = Config::default();
        current.llm.api_key = Some(Secret("sk".into()));
        current.llm.base_url = "http://llm.local:8000/v1".into();
        current.mariadb.password = Some(Secret("pw".into()));
        let refused_by = |current: &Config, body: Value| draft(current, &body).err().map(|e| e.message);
        for body in [
            json!({"config":{"llm":{"base_url":"http://other.local:8000/v1"}}}),
            json!({"config":{"llm":{"base_url":"https://llm.local:8000/v1"}}}),
            json!({"config":{"llm":{"base_url":"http://llm.local:9000/v1"}}}),
            json!({"config":{"llm":{"proxy":"http://proxy.local:3128"}}}),
            json!({"config":{"llm":{"base_url":"http://other.local:8000/v1"}},"secrets":{"llm_api_key":""}}),
        ] {
            assert!(refused_by(&current, body.clone()).is_some_and(|m| m.contains("API 키")), "{body}");
        }
        for body in [
            json!({"config":{"llm":{"base_url":"HTTP://LLM.local:8000/v2"}}}),
            json!({"config":{"llm":{"base_url":"http://other.local:8000/v1"}},"secrets":{"llm_api_key":"sk2"}}),
            json!({"config":{"llm":{"base_url":"http://other.local:8000/v1"}},"secrets":{"llm_api_key":null}}),
            json!({"config":{"llm":{"model":"m","base_url":"not a url"}}}),
        ] {
            assert!(refused_by(&current, body.clone()).is_none(), "{body}");
        }
        // Over HTTPS a proxy carries the request encrypted.
        current.llm.base_url = "https://llm.local/v1".into();
        assert!(refused_by(&current, json!({"config":{"llm":{"proxy":"http://proxy.local:3128"}}})).is_none());
        for body in [json!({"config":{"mariadb":{"host":"db.elsewhere"}}}), json!({"config":{"mariadb":{"port":3307}}})] {
            assert!(refused_by(&current, body.clone()).is_some_and(|m| m.contains("비밀번호")), "{body}");
        }
        assert!(refused_by(&current, json!({"config":{"mariadb":{"host":"db.elsewhere"}},"secrets":{"mariadb_password":"pw2"}})).is_none());
        assert!(refused_by(&current, json!({"config":{"mariadb":{"user":"other","pool_size":5}}})).is_none());
        // Nothing stored, nothing to keep.
        current.llm.api_key = None;
        current.mariadb.password = None;
        assert!(refused_by(&current, json!({"config":{"llm":{"base_url":"http://x/v1"},"mariadb":{"host":"h"}}})).is_none());
    }
}
