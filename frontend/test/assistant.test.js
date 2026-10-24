import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILE, normalizeProfile, profileFromPage, brandParts, sectionShown } from '../src/assistant.js';

// 서버가 index.html에 넣는 역할 정보(backend/src/ui.rs personalized)를 화면이 읽는 길.
const page = content => ({ querySelector: selector => (selector === 'meta[name="assistant-profile"]' && content != null ? { getAttribute: () => content } : null) });

test('index.html의 meta에서 역할을 읽고, 없거나 깨졌으면 기본값이다', () => {
  const profile = profileFromPage(page(JSON.stringify({ name: ' SPACE Assistant ', subtitle: '지식', examples: ['a', ' ', 'b', 'c', 'd'], knowledge: false, database: true })));
  assert.deepEqual(profile, { name: 'SPACE Assistant', subtitle: '지식', examples: ['a', 'b', 'c'], knowledge: false, database: true });
  assert.equal(profileFromPage(page(null)), DEFAULT_PROFILE);
  assert.equal(profileFromPage(page('{깨진')), DEFAULT_PROFILE);
  assert.equal(profileFromPage(undefined), DEFAULT_PROFILE);
});

test('모양이 어긋난 값은 그 칸만 기본값이 된다', () => {
  assert.equal(normalizeProfile(null), DEFAULT_PROFILE);
  assert.equal(normalizeProfile([]), DEFAULT_PROFILE);
  const odd = normalizeProfile({ name: '', subtitle: 3, examples: 'x' });
  assert.equal(odd.name, 'AI Assistant');
  assert.equal(odd.subtitle, '');
  assert.deepEqual(odd.examples, DEFAULT_PROFILE.examples);
  assert.equal(odd.knowledge && odd.database, true);
  // 관리자가 예시를 모두 지웠으면 예시 없이 보인다.
  assert.deepEqual(normalizeProfile({ name: 'x', examples: [] }).examples, []);
});

test('머리글은 이름의 첫 낱말을 강조한다', () => {
  assert.deepEqual(brandParts('AI Assistant'), ['AI', ' Assistant']);
  assert.deepEqual(brandParts('SPACE VOC 도우미'), ['SPACE', ' VOC 도우미']);
  assert.deepEqual(brandParts('도우미'), ['도우미', '']);
});

test('꺼진 도구 묶음의 관리 탭은 보이지 않는다', () => {
  const tabs = profile => ['databases', 'knowledge', 'methods', 'queries', 'projects', 'mcp', 'settings'].filter(k => sectionShown(k, profile));
  assert.deepEqual(tabs(DEFAULT_PROFILE), ['databases', 'knowledge', 'methods', 'queries', 'projects', 'mcp', 'settings']);
  assert.deepEqual(tabs({ ...DEFAULT_PROFILE, database: false }), ['knowledge', 'projects', 'mcp', 'settings']);
  assert.deepEqual(tabs({ ...DEFAULT_PROFILE, knowledge: false }), ['databases', 'methods', 'queries', 'projects', 'mcp', 'settings']);
  assert.deepEqual(tabs({ ...DEFAULT_PROFILE, knowledge: false, database: false }), ['projects', 'mcp', 'settings']);
});
