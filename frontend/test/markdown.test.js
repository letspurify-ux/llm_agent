// 답변 속 주소를 다루는 규칙의 회귀 테스트 — 실행: npm test (frontend/)
//
// 이 계약이 깨져도 오류로는 보이지 않는다: 링크가 같은 탭에서 열려 대화가 통째로 사라지거나(이력은
// 메모리에만 있다), 모델이 쓴 주소 하나가 사용자가 누르기도 전에 바깥으로 나가는 요청이 된다.
// 그 재료에는 조회 결과(자유 텍스트)가 섞이므로, 그 통로는 열려 있어서는 안 된다.
import { test } from 'node:test';
import assert from 'node:assert';
import { isInPage, linkAttrs, imageKind } from '../src/markdown.js';

test('링크는 새 탭에서, 페이지 안 앵커만 제자리에서 연다', () => {
  // 같은 탭에서 열리면 대화가 사라진다. noreferrer까지 붙여 사내 주소가 referer로 새지 않게 한다.
  assert.deepStrictEqual(linkAttrs('https://intra.example/a'), { target: '_blank', rel: 'noopener noreferrer' });
  assert.deepStrictEqual(linkAttrs('/보고서.pdf'), { target: '_blank', rel: 'noopener noreferrer' });
  assert.deepStrictEqual(linkAttrs('#다음-절'), {});
  assert.ok(isInPage('#a') && !isInPage('https://a') && !isInPage(undefined));
});

test('그림은 어떤 주소여도 <img>가 되지 않고, 열 수 있는 것만 링크가 된다', () => {
  // 링크로 여는 것: http(s)와 주소만 적힌 상대 경로
  for (const src of ['https://ex.test/a.png', 'http://ex.test/a.png', 'chart.png', '/img/a.png', './a.png', '?id=3'])
    assert.strictEqual(imageKind(src), 'link', src);
  // 페이지 안 앵커는 제자리에서 (링크와 같은 규칙 — 새 탭으로 열면 대화 없는 앱이 한 벌 더 뜬다)
  assert.strictEqual(imageKind('#s3'), 'inpage');
  // 그림 자리에 올 것이 아닌 방식과, 바깥으로 나가는 '//호스트'(역슬래시 변형 포함)는 글자로만
  for (const src of ['mailto:a@b.test', 'tel:+8210', 'data:image/png;base64,AAAA', 'blob:http://x/y',
    '//host.example/a.png', '/\\host.example/a.png', '\\\\host.example\\a.png'])
    assert.strictEqual(imageKind(src), 'text', src);
  // 주소가 없거나 링크 안이면 <a>를 또 열 수 없다 — 중첩 앵커는 바깥 링크를 누를 수 없게 만든다
  assert.strictEqual(imageKind('', false), 'text');
  assert.strictEqual(imageKind(undefined, false), 'text');
  assert.strictEqual(imageKind('https://ex.test/a.png', true), 'text');
});
