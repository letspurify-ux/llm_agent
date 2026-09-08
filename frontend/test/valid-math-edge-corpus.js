// 유효한 수식과 Markdown 조합. 기대 원문은 컨테이너·구분자와 독립적으로 둔다.
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
export const EDGE_CASES = [];
const gather = String.raw`\begin{gather}
x=1\\
y>0
\end{gather}`;
const aligned = String.raw`\begin{aligned}
x&=1\\
y&>0
\end{aligned}`;
for (const [name, wrap] of Object.entries(MIXED_WRAPPERS)) {
  for (const [kind, source, tex] of [
    ['bare', gather, gather], ['brackets', '\\[\n' + aligned + '\n\\]', aligned],
    ['inline', '\\(\n' + aligned + '\n\\)', aligned], ['dollars', '$$\n' + aligned + '\n$$', aligned],
  ]) for (const slash of ['\\', '₩']) {
    EDGE_CASES.push({ name: `${name}/${kind}/${slash}`, md: wrap(source.replaceAll('\\', slash)), tex });
  }
  EDGE_CASES.push({ name: `${name}/tag-newline`, md: wrap('$E=mc^2$\n\\tag{A}'), tex: String.raw`E=mc^2 \tag{A}` });
  EDGE_CASES.push({ name: `${name}/decimal-tag`, md: wrap(String.raw`x=1.25 \tag{D}`), tex: String.raw`x=1.25 \tag{D}` });
}
for (const [name, wrap] of Object.entries(MIXED_WRAPPERS)) {
  for (const [kind, source] of [
    ['full', '[분수 $\\frac{1}{x}$][eq]\n\n[eq]: https://example.test/math?q=$HOME "수식 제목"'],
    ['collapsed', '[$x=1$][]\n\n[$x=1$]: https://example.test/math?q=$HOME "수식 제목"'],
    ['shortcut', '[$x=1$]\n\n[$x=1$]: https://example.test/math?q=$HOME "수식 제목"'],
    ['strong', '[**$x=1$**][eq]\n\n[eq]: https://example.test/math?q=$HOME "수식 제목"'],
  ]) EDGE_CASES.push({ name: `${name}/reference-${kind}`, md: wrap(source),
    tex: kind === 'full' ? String.raw`\frac{1}{x}` : 'x=1', href: 'https://example.test/math?q=$HOME' });
}
// 링크 식별자끼리 섞이지 않도록 각 예시는 별도 답변으로 검증한다.
export const edgeAnswer = c => `${c.md}\n\n정상 입력 검증 끝`;
for (const [kind, label] of [
  ['escaped', String.raw`$x=1$ \*근거\*`], ['entity', '$x=1$ &amp; 근거'],
  ['case', String.raw`$\Gamma(x)$`], ['multiline', '$x=1$\n근거'],
]) for (const suffix of ['', '[]']) {
  EDGE_CASES.push({ name: `reference-${kind}/${suffix || 'shortcut'}`,
    md: `[${label}]${suffix}\n\n[${label.replaceAll('\n', ' ')}]: https://example.test/math?q=$HOME "수식 제목"`,
    tex: kind === 'case' ? String.raw`\Gamma(x)` : 'x=1', href: 'https://example.test/math?q=$HOME' });
}
// 중복 참조 정의는 같은 URL·제목이다. 단독 예시와 긴 복합 답변을 모두 검증한다.
export const VALID_EDGE_ANSWER = EDGE_CASES.map((c, i) => `## 정상 예제 ${i + 1}\n\n${c.md}`).join('\n\n')
  + '\n\n정상 입력 검증 끝';
