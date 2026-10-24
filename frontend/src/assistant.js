// 이 서버의 역할(설정 탭의 '어시스턴트')이 화면에 보이는 것 — 이름·부제·예시 질문과, 관리 화면이 탭을 고르는 도구 묶음.
// 서버가 index.html을 내줄 때 <meta name="assistant-profile">로 넣는다(backend/src/ui.rs personalized). 그래서 첫 화면부터
// 그 이름이 보이고, 페이지를 열 때 따로 요청하지 않는다. 설정을 저장하면 저장 결과로 바로 바꾼다(SettingsPanel onSaved).
// Vite 개발 서버가 내주는 index.html에는 meta가 없어 기본값으로 보인다 — 운영 화면은 늘 백엔드가 내준다.
export const DEFAULT_PROFILE = Object.freeze({
  name: 'AI Assistant',
  subtitle: '',
  examples: Object.freeze(['너는 어떤 일을 할 수 있어?']),
  knowledge: true,
  database: true,
});
export const MAX_EXAMPLES = 3;

const text = value => (typeof value === 'string' ? value.trim() : '');

// 서버가 준 값(meta의 JSON, 저장한 설정의 assistant 구역) → 화면이 쓰는 모양. 모양이 어긋난 값은 기본값으로 둔다.
export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_PROFILE;
  return {
    name: text(raw.name) || DEFAULT_PROFILE.name,
    subtitle: text(raw.subtitle),
    examples: Array.isArray(raw.examples) ? raw.examples.map(text).filter(Boolean).slice(0, MAX_EXAMPLES) : DEFAULT_PROFILE.examples,
    knowledge: raw.knowledge !== false,
    database: raw.database !== false,
  };
}

export function profileFromPage(doc = globalThis.document) {
  const content = doc?.querySelector?.('meta[name="assistant-profile"]')?.getAttribute('content');
  if (!content) return DEFAULT_PROFILE;
  try { return normalizeProfile(JSON.parse(content)); } catch { return DEFAULT_PROFILE; }
}

// 머리글은 이름의 첫 낱말을 강조한다(예전 'SPACE Assistant'의 SPACE처럼). 한 낱말이면 그 전부다.
export function brandParts(name) {
  const at = name.search(/\s/);
  return at < 0 ? [name, ''] : [name.slice(0, at), name.slice(at)];
}

// 관리 화면의 탭 중 이 역할이 쓰는 것. 꺼진 도구 묶음의 자료는 이 서버의 에이전트가 읽지 않는다.
const SECTION_GROUP = { databases: 'database', methods: 'database', queries: 'database', knowledge: 'knowledge' };
export function sectionShown(key, profile) {
  const group = SECTION_GROUP[key];
  return !group || profile[group] !== false;
}
