// 답변 속 주소를 다루는 규칙의 회귀 테스트 — 실행: npm test (frontend/)
//
// 이 계약이 깨져도 오류로는 보이지 않는다: 링크가 같은 탭에서 열려 대화가 통째로 사라지거나(이력은
// 메모리에만 있다), 모델이 쓴 주소 하나가 사용자가 누르기도 전에 바깥으로 나가는 요청이 된다.
// 그 재료에는 조회 결과(자유 텍스트)가 섞이므로, 그 통로는 열려 있어서는 안 된다.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { isInPage, linkAttrs, imageKind, mdUrlTransform, cleanUrl, imageTarget, linkTarget, mdProps } from '../src/markdown.js';

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

test('주소 판정은 브라우저가 먼저 걷어내는 것을 걷어내고 본다', () => {
  // 브라우저는 주소를 읽기 전에 앞뒤의 제어문자·공백을 자르고 탭·줄바꿈은 어디에 있든 뺀다.
  // 그림 자리의 이 판정이 그림 src의 유일한 관문이므로(mdUrlTransform이 원문을 그대로 넘긴다)
  // 같은 규칙으로 걷어낸 뒤에 판정해야 한다.
  //   지금 파이프라인은 여기 오기 전에 micromark가 이런 글자를 %09·%20으로 바꿔 두므로, 아래 값들은
  //   '렌더러가 만들어 내는 모양'이 아니라 이 함수를 직접 부르는 쪽에 대한 계약이다.
  for (const src of ['  //host.example/a.png', '\t//host.example/a.png', '//host.example/a.png\n', ' /\\host.example/a.png'])
    assert.strictEqual(imageKind(src), 'text', JSON.stringify(src));
  assert.strictEqual(imageKind('java\tscript:alert(1)'), 'text');   // java(탭)script: → javascript:
  assert.strictEqual(imageKind('  \t\n '), 'text');                  // 걷어내면 남는 것이 없다
  assert.strictEqual(imageKind(' https://ex.test/a.png '), 'link');  // 걷어낸 뒤 열 수 있으면 연다
});

test('앞에 붙은 제어문자는 판정을 비켜 가지 못한다 (브라우저가 그것을 떼고 읽는다)', () => {
  // new URL('\x01javascript:alert(1)', base) === 'javascript:alert(1)' — 앞의 C0 제어문자는
  // 잘려 나가므로, 걷어내지 않고 방식을 찾으면 살아 있는 javascript: 주소를 링크로 내주게 된다.
  assert.strictEqual(new URL('\x01javascript:alert(1)', 'http://h/').href, 'javascript:alert(1)');
  assert.strictEqual(imageKind('\x01javascript:alert(1)'), 'text');
  assert.strictEqual(imageKind('\x01//evil.example/x.png'), 'text');
  assert.strictEqual(imageKind('\x02 data:image/png;base64,AAAA'), 'text');
  assert.strictEqual(imageKind('\x01https://ex.test/a.png'), 'link');   // 떼고 나면 열 수 있는 주소다
});

test('판정한 값과 여는 값이 같다 (걷어낸 주소 하나로 정하고 그것을 연다)', () => {
  // 그림 자리(AltImage)와 링크 자리(NewTabLink)는 같은 규칙을 두 번 쓴다. 한쪽만 걷어내면
  // 브라우저가 같은 앵커로 읽는 주소를 두고 그림은 제자리에서, 링크는 새 탭에서 열게 된다 —
  // 그 새 탭은 대화 없는 앱을 한 벌 더 띄운다. 그래서 판정은 어느 자리에서든 cleanUrl 뒤에 한다.
  assert.strictEqual(cleanUrl(' #다음-절'), '#다음-절');
  assert.strictEqual(imageKind(' #다음-절'), 'inpage');
  assert.deepStrictEqual(linkAttrs(' #다음-절'), {});                  // 그림과 같은 판정: 제자리에서
  assert.deepStrictEqual(linkAttrs('\t#다음-절'), {});
  assert.ok(isInPage(' #a') && isInPage('#\ta') && !isInPage(' https://a'));
  // 걷어내면 남는 것이 없는 주소는 링크가 아니다 — 빈 href는 '현재 문서'라 누르면 대화가 사라진다
  assert.strictEqual(cleanUrl('  \t '), '');
  assert.strictEqual(cleanUrl('https://ex.test/a\tb.png'), 'https://ex.test/ab.png');
  assert.strictEqual(cleanUrl(undefined), '');
});

test('그림의 주소만 원문 그대로 받는다 — 링크의 href는 기본 규칙 그대로', () => {
  const img = { tagName: 'img' };
  const a = { tagName: 'a' };
  // 그림은 <img>가 되지 않으므로(AltImage) 원문이 '무엇을 가리키는가'를 보여줄 유일한 단서다.
  // 기본 규칙에 맡기면 이 주소들이 빈 문자열로 지워져 화면에 '🖼 이미지'만 남는다.
  assert.strictEqual(mdUrlTransform('data:image/png;base64,AAAA', 'src', img), 'data:image/png;base64,AAAA');
  assert.strictEqual(mdUrlTransform('tel:+8210', 'src', img), 'tel:+8210');
  assert.strictEqual(mdUrlTransform('javascript:alert(1)', 'src', img), 'javascript:alert(1)');
  // 원문을 받아도 여는 것은 imageKind가 좁힌다 — 위험한 주소는 글자로만 남는다.
  for (const src of ['data:image/png;base64,AAAA', 'javascript:alert(1)'])
    assert.strictEqual(imageKind(mdUrlTransform(src, 'src', img)), 'text', src);
  // 링크(href)는 기본 규칙 그대로 — javascript:는 빈 href가 되고 NewTabLink가 글자로만 남긴다.
  assert.strictEqual(mdUrlTransform('javascript:alert(1)', 'href', a), '');
  assert.strictEqual(mdUrlTransform('https://ex.test/a', 'href', a), 'https://ex.test/a');
  assert.strictEqual(mdUrlTransform('/보고서.pdf', 'href', a), '/보고서.pdf');
});

test('그리는 자리는 판정과 주소를 함께 받는다 — 어긋난 짝을 만들 수 없다', () => {
  // '걷어낸 값으로 판정하고 그 값을 href에 쓴다'가 부르는 쪽의 기억에 맡겨져 있었을 때, 그림 자리와
  // 링크 자리는 실제로 갈려 있었다. 그 어긋남은 오류로 보이지 않는다 — 판정은 '제자리'인데 붙은
  // 속성은 새 탭이라, 같은 앵커를 누르면 대화 없는 앱이 한 벌 더 뜬다.
  assert.deepStrictEqual(imageTarget(' #절'), { url: '#절', kind: 'inpage', attrs: {} });
  assert.deepStrictEqual(linkTarget(' #절'), { url: '#절', attrs: {} });
  const 새탭 = { target: '_blank', rel: 'noopener noreferrer' };
  assert.deepStrictEqual(imageTarget(' https://ex.test/a.png '), { url: 'https://ex.test/a.png', kind: 'link', attrs: 새탭 });
  assert.deepStrictEqual(linkTarget('/보고서.pdf'), { url: '/보고서.pdf', attrs: 새탭 });
  // 열어 주지 않는 것들 — 주소는 남고(무엇을 가리키는지 보여야 한다) 판정만 글자다
  assert.strictEqual(imageTarget('\x01javascript:alert(1)').kind, 'text');
  assert.strictEqual(imageTarget('https://ex.test/a.png', true).kind, 'text');   // 링크 안
  assert.strictEqual(linkTarget(undefined).url, '');                             // 부르는 쪽이 글자로 남긴다
  // 어느 주소를 주어도 판정은 늘 함께 나온 url에서 나온 것이다
  for (const src of ['  #s', ' https://ex.test/a', '\tdata:image/png;base64,AA', '//host.example/a.png', ''])
    assert.strictEqual(imageTarget(src).kind, imageKind(imageTarget(src).url), JSON.stringify(src));
});

test('urlTransform과 img는 한 벌로만 나온다 (한쪽만 걸린 자리를 만들 수 없게)', () => {
  // urlTransform은 그림 src의 기본 검사를 걷어낸다 — 그 값을 <img>로 만들지 않는 img 컴포넌트가
  // 함께 있어야만 안전하다. 둘을 따로 넘기던 때에는 그 짝을 <ReactMarkdown> 자리마다 사람이
  // 기억해야 했고, 한 자리가 그것을 잊으면 모델이 쓴 주소가 사용자가 누르기도 전에 불려 나간다
  // (오류도, 콘솔 한 줄도 남지 않는다).
  const img = () => null;
  const 한벌 = mdProps({ a: () => null, img });
  assert.strictEqual(한벌.urlTransform, mdUrlTransform);
  assert.strictEqual(한벌.components.img, img);
  // img 없이는 만들어 주지 않는다 — 그 자리가 바로 뚫리는 자리다
  assert.throws(() => mdProps({ a: () => null }), /img/);
  assert.throws(() => mdProps({}), /img/);
  assert.throws(() => mdProps(), /img/);
  // 부르는 쪽이 뒤에서 img만 갈아 끼우지 못하게 얼려 둔다(모듈 상수로 한 번만 만든다)
  assert.ok(Object.isFrozen(한벌) && Object.isFrozen(한벌.components));
});

test('화면의 모든 <ReactMarkdown>이 그 한 벌을 받는다 (App.jsx)', () => {
  // 이 계약은 한 자리만 어긋나도 조용히 뚫리는데, 그 자리는 렌더된 화면에서만 보인다 — 새로 생긴
  // <ReactMarkdown> 하나를 UI 검사가 마침 지나가지 않으면 아무도 보지 못한다. 그래서 자리 자체를 센다.
  // 주석은 걷어내고 본다 — 이 규칙을 설명하는 글에도 <ReactMarkdown>이 나오고, 그것까지 세면
  // 검사가 코드가 아니라 설명을 탓한다.
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
  const 한벌들 = [...src.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*mdProps\(/g)].map(m => m[1]);
  assert.ok(한벌들.length > 0, 'mdProps로 묶은 한 벌이 하나도 없다');
  const 자리들 = [...src.matchAll(/<ReactMarkdown\b[^>]*>/g)].map(m => m[0]);
  assert.ok(자리들.length > 0, '<ReactMarkdown>을 찾지 못했다 — 이 검사가 헛것을 보고 있다');
  for (const 자리 of 자리들)
    assert.ok(한벌들.some(n => 자리.includes(`{...${n}}`)),
      `한 벌(mdProps)을 받지 않는 <ReactMarkdown>이 있다 — 그림 주소가 곧바로 <img src>가 된다: ${자리}`);
  // 풀어서 따로 넘기는 자리도 없어야 한다 — 그러면 짝을 맞추는 일이 다시 사람의 기억이 된다
  assert.ok(!/urlTransform=/.test(src), 'urlTransform을 따로 넘기는 자리가 있다 (mdProps로 묶어야 한다)');
  assert.ok(!/components=/.test(src), 'components를 따로 넘기는 자리가 있다 (mdProps로 묶어야 한다)');
});
