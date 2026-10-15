// 설정 화면의 항목 정의와 값 변환. 화면은 입력 글자를 다루고, 서버는 backend/src/config.rs의 타입을 받는다 —
// 두 모양 사이의 변환을 여기 한 곳에 둔다(순수 함수라 회귀 테스트가 붙는다).
//   [키 (구역.이름), 이름표, 종류, 도움말]
//   종류: text · url · optionalText(비우면 없음) · number(0 이상 정수) · optionalNumber(비우면 기본값)
//         · decimal(소수) · percent(화면 %, 서버 0~1) · mib(화면 MiB, 서버 바이트) · boolean · effort · folder
export const SETTING_GROUPS = [
  { id: 'llm', title: '모델 연결 (LLM)', check: 'llm',
    description: 'OpenAI 호환 /chat/completions 주소와 모델입니다. OpenRouter, vLLM, Ollama(/v1) 모두 이 형식입니다.',
    fields: [
      ['llm.base_url', '주소 (base URL)', 'url', '예: https://openrouter.ai/api/v1 · http://localhost:11434/v1'],
      ['llm.model', '모델', 'text', '예: qwen/qwen3.8-27b'],
      ['llm.reasoning_effort', '추론 강도', 'effort', '지원하지 않는 모델이면 "보내지 않음"을 고르세요.'],
      ['llm.enable_thinking', '추론(thinking) 사용', 'boolean', '끄면 추론 강도 대신 none을 보냅니다.'],
      ['llm.context_tokens', '컨텍스트 (토큰)', 'number', '모델이 받는 최대 입력+출력. 작을수록 답이 빠르고 오래된 맥락이 일찍 비워집니다.'],
      ['llm.output_tokens', '출력 한도 (토큰)', 'number'],
      ['llm.request_timeout_secs', '무응답 한도 (초)', 'number', '응답 시작 전과 스트림 도중의 침묵 한도입니다.'],
      ['llm.retries', '재시도 횟수', 'number'],
      ['llm.proxy', 'HTTP 프록시', 'optionalText', '비우면 시스템 설정을 따릅니다.'],
      ['llm.disable_proxy', '프록시 사용 안 함', 'boolean'],
      ['llm.stream_usage', '스트림에 토큰 사용량 요청', 'boolean'],
      ['llm.legacy_max_tokens', 'max_tokens 이름으로 보내기 (구형 서버)', 'boolean'],
    ] },
  { id: 'embedding', title: '임베딩·검색', check: 'embedding',
    description: '지식·처리 방법·쿼리의 의미 검색에 쓰는 임베딩 서버(Ollama 등)입니다. 주소를 비우면 의미 검색 없이 정확한 쿼리 이름 조회만 됩니다.',
    fields: [
      ['embedding.url', '주소', 'optionalText', '예: http://localhost:11434/v1'],
      ['embedding.model', '모델', 'text', '1024차원 모델이어야 합니다 (bge-m3, qwen3-embedding:0.6b).'],
      ['embedding.query_prefix', '검색어 앞 지시문', 'text', '비워 두는 것을 권장합니다. \\n은 줄바꿈으로 바뀝니다.'],
      ['embedding.sync_interval_secs', '동기화 주기 (초)', 'number', '0이면 주기 동기화를 끕니다(기동 시 한 번은 실행).'],
      ['embedding.max_distance', '관련도 거리 문턱', 'decimal', '코사인 거리. 가까운 상위 3건은 문턱과 무관하게 보입니다. 기본 0.4'],
      ['embedding.ef_search', '벡터 탐색 깊이', 'number', '기본 150'],
      ['embedding.timeout_secs', '응답 한도 (초)', 'number'],
    ] },
  { id: 'mariadb', title: '관리 DB (MariaDB)', check: 'mariadb',
    description: '지식·처리 방법·쿼리·조회 대상 DB와 대화 로그를 저장하는 DB입니다. 바꾸면 다음 요청부터 새 접속을 씁니다.',
    fields: [
      ['mariadb.host', '호스트', 'text'],
      ['mariadb.port', '포트', 'number'],
      ['mariadb.user', '사용자', 'text'],
      ['mariadb.database', 'DB 이름', 'text'],
      ['mariadb.pool_size', '연결 수', 'number'],
      ['mariadb.timeout_ms', '쿼리 한도 (ms)', 'number'],
    ] },
  { id: 'oracle', title: '조회 대상 DB (Oracle)', check: 'oracle_client', status: 'oracle_client',
    description: 'Oracle 조회에는 Oracle Instant Client가 필요합니다. 폴더 설정은 서버를 다시 시작해야 적용됩니다.',
    fields: [
      ['oracle.client_lib_dir', 'Instant Client 폴더', 'folder', '비우면 OS 검색 경로(PATH 등)를 따릅니다.'],
      ['oracle.client_config_dir', 'tnsnames.ora 폴더 (TNS_ADMIN)', 'folder'],
      ['oracle.timeout_ms', '조회 한도 (ms)', 'number'],
      ['oracle.routine_read_only', '프로시저·함수를 읽기 전용 트랜잭션으로 실행', 'boolean', '실수로 섞인 DML을 막을 뿐 쓰기 차단 경계는 아닙니다.'],
      ['oracle.mock', '데모 데이터로 응답 (mock)', 'boolean', '실제 DB에 접속하지 않고 데모 쿼리에 고정된 행을 돌려줍니다.'],
    ] },
  { id: 'agent', title: '실행·컨텍스트',
    description: '질문 하나가 쓸 수 있는 모델 요청과 시간, 그리고 대화 맥락을 비우는 기준입니다.',
    fields: [
      ['agent.run_seconds', '질문당 시간 (초)', 'number', '질문은 답할 때까지 모델을 부릅니다. 끝나기 45초 전에는 도구 없이 답하게 합니다. 화면은 450초에 요청을 끊습니다.'],
      ['agent.high_water', '맥락 비우기 시작 (%)', 'percent', '입력 예산의 이 비율을 넘으면 오래된 대화·도구 결과부터 맥락에서 뺍니다.'],
      ['agent.low_water', '맥락 비우기 목표 (%)', 'percent'],
      ['agent.result_tokens', '도구 결과 하나 (토큰)', 'optionalNumber', '비우면 25,000(컨텍스트가 작으면 그 1/8). 호출마다 따로 받고, 한 응답의 결과가 맥락에 다 들어가지 않을 때만 큰 결과부터 줄입니다.'],
      ['agent.history_bytes', '대화 이력 보관 (MiB)', 'mib'],
      ['agent.result_store_bytes', '조회 결과 보관 (MiB)', 'mib'],
      ['agent.tool_timeout_secs', '소스 도구 한도 (초)', 'number'],
      ['agent.session_idle_minutes', '대화 보관 (분, 마지막 사용 후)', 'number'],
      ['agent.max_sessions', '보관 대화 수', 'number'],
    ] },
  { id: 'server', title: '서버',
    fields: [
      ['server.port', '포트', 'number', '서버를 다시 시작해야 적용됩니다.'],
      ['server.chat_log_retention_days', '대화 로그 보관 (일)', 'number'],
    ] },
];

export const SECRETS = [
  { key: 'llm_api_key', group: 'llm', label: 'API 키', help: '서버의 config.credentials.json에만 저장되고 화면으로 돌아오지 않습니다.' },
  { key: 'mariadb_password', group: 'mariadb', label: '비밀번호' },
  { key: 'admin_token', group: 'server', label: '관리자 인증 키', help: '바꾸면 이 화면도 새 키로 다시 인증해야 합니다.' },
];

const FIELDS = SETTING_GROUPS.flatMap(g => g.fields);
const MIB = 1024 * 1024;
const get = (config, key) => key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), config);

// 서버 값 → 입력 글자.
export function formOf(config) {
  const form = {};
  for (const [key, , type] of FIELDS) {
    const value = get(config, key);
    form[key] = type === 'boolean' ? !!value
      : value == null ? ''
        : type === 'percent' ? String(Math.round(Number(value) * 1000) / 10)
          : type === 'mib' ? String(Math.round((Number(value) / MIB) * 100) / 100)
            : String(value);
  }
  return form;
}

// 입력 글자 → 서버 값. 숫자가 아닌 글자는 problems로 모아 저장 전에 알린다.
export function configOf(form) {
  const config = {};
  const problems = [];
  for (const [key, label, type] of FIELDS) {
    const raw = form[key];
    const text = typeof raw === 'string' ? raw.trim() : raw;
    let value;
    if (type === 'boolean') value = !!raw;
    else if (type === 'optionalText') value = text ? text : (key === 'embedding.url' ? '' : null);
    else if (type === 'text' || type === 'url' || type === 'folder' || type === 'effort') value = key === 'embedding.query_prefix' ? raw : text;
    else if (type === 'optionalNumber' && text === '') value = null;
    else {
      const n = Number(text);
      const integer = type === 'number' || type === 'optionalNumber';
      if (text === '' || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
        problems.push(`${label}에는 ${integer ? '0 이상의 정수' : '0 이상의 숫자'}를 입력해주세요.`);
        continue;
      }
      value = type === 'percent' ? n / 100 : type === 'mib' ? Math.round(n * MIB) : n;
    }
    const [section, name] = key.split('.');
    (config[section] ??= {})[name] = value;
  }
  return { config, problems };
}
