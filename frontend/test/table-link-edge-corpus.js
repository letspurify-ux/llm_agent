import { MIXED_WRAPPERS } from './mixed-content-corpus.js';

export const TABLE_LINK_CASES = [];
for (const tex of ['|x|', String.raw`\left|x\right|`, String.raw`\begin{array}{c|c}a&b\\c&d\end{array}`])
  for (const label of [`$${tex}$`, `설명 $${tex}$`, `**$${tex}$**`])
    for (const type of ['full', 'collapsed', 'shortcut', 'inline']) {
      const href='https://example.test/a?q=$HOME';
      const target=type==='inline' ? `(${href} "원래 제목")` : type==='full' ? '[eq]' : type==='collapsed' ? '[]' : '';
      const definition=type==='inline' ? '' : `\n\n[${type==='full'?'eq':label}]: ${href} "원래 제목"`;
      TABLE_LINK_CASES.push({tex,href,md:`| 수식 | 비고 |\n|---|---|\n| [${label}]${target} | 보존 |${definition}`});
    }

export const TABLE_LINK_EXPECTED = Object.values(MIXED_WRAPPERS).flatMap(() => TABLE_LINK_CASES);
export const TABLE_LINK_ANSWER = Object.values(MIXED_WRAPPERS).flatMap(wrap => TABLE_LINK_CASES.map(c => wrap(c.md))).join('\n\n') + '\n\n표 링크 검사 끝';
