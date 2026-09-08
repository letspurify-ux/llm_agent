// 같은 원문을 서로 다른 Markdown 컨테이너에 넣는다. 기대 수식은 생성 규칙과 별도로 명시한다.
export const MIXED_FORMULAS = [
  String.raw`\sqrt{a^2}=|a|`, String.raw`\ce{H2O}`, String.raw`\frac{1}{x}`,
  String.raw`\begin{gather}x+y=10\\x-y=4\end{gather}`,
  String.raw`\int_0^1 x\,dx=\frac12`, String.raw`E=mc^2 \tag{1}`, 'E=mc^2',
];
export const MIXED_BODY = [
  '복합 시작 — 금액 $100, $200, ₩ 300 / 환경 변수 `$HOME` / 코드 `\\sqrt{x}`.',
  '',
  '| 항목 | 수식 | 비고 |', '| --- | --- | --- |',
  String.raw`| 절댓값 | $\sqrt{a^2}=|a|$ | 오른쪽 보존 |`,
  String.raw`| 화학 | $\ce{H2O}$ | 물 |`,
  '',
  String.raw`[역수 $\frac{1}{x}$](https://example.test/a?q=$HOME)와 각주[^mixed].`,
  '',
  String.raw`\begin{gather}x+y=10\\x-y=4\end{gather}`,
  '', '$$', String.raw`\int_0^1 x\,dx=\frac12`, '$$', '',
  '```chart', 'type: bar', 'title: 중첩 관측값', '| 항목 | 값 |', '| --- | --- |',
  '| 하나 | 2 |', '| 둘 | 4 |', '```', '',
  '```mermaid', 'flowchart LR', '  A[입력] --> B[계산] --> C[결과]', '```', '',
  '````text', '```chart', '이것은 코드 예시', String.raw`$\frac{a}{b}$`, '```', '````', '',
  '![이미지 자리](/__probe-pixel.png?mixed=1)', '', String.raw`E=mc^2 \tag{1}`, '', '복합 끝',
].join('\n');

export const MIXED_WRAPPERS = {
  plain: body => body,
  quote: body => body.split('\n').map(line => '> ' + line).join('\n'),
  list: body => '1. 바깥 목록\n\n' + body.split('\n').map(line => '   ' + line).join('\n'),
  nested: body => '1. 바깥 목록\n\n   - 안쪽 목록\n\n' + body.split('\n').map(line => '     > ' + line).join('\n'),
  quoteList: body => '> 1. 인용 목록\n>\n' + body.split('\n').map(line => '>    ' + line).join('\n'),
};
export const mixedContent = (kind = 'nested') => MIXED_WRAPPERS[kind](MIXED_BODY)
  + '\n\n[^mixed]: 각주 수식 $E=mc^2$ 확인.\n';
export const NESTED_MIXED_ANSWER = mixedContent();
