// 실제 ReactMarkdown·브라우저·배포 검증이 공유하는 수식. 화면에서 손상되기 쉬운 문법을 포함한다.
export const MATH_CORPUS = [
  String.raw`a_{i} * b_{j} + c^{2}`,
  String.raw`\frac{1}{2} + \sqrt{x^2 + 1}`,
  String.raw`\text{cost: \$5} + x`,
  String.raw`\text{[guide](https://example.test) and *stars*}`,
  String.raw`\verb|$| + x`,
  String.raw`\left|x\right| + \left\|y\right\|`,
  String.raw`\begin{array}{c|c} a & b \\ c & d \end{array}`,
  String.raw`\begin{pmatrix*}[r] 1 & 2 \\ 3 & 4 \end{pmatrix*}`,
  String.raw`\begin{cases} x & x>0 \\ -x & x\le0 \end{cases}`,
  String.raw`\begin{aligned} a &= b+c \\ &= d \end{aligned}`,
  String.raw`\begin{alignedat}{2}a&=b & c&=d\end{alignedat}`,
  String.raw`\begin{alignat*}{2}a&=b & c&=d\end{alignat*}`,
  String.raw`\begin{split} a &= b+c \\ &= d \end{split}`,
  String.raw`\begin{gather} x=1 \\ y=2 \end{gather}`,
  String.raw`\begin{equation}\begin{split} a &= b+c \\ &= d \end{split}\tag{A}\end{equation}`,
  String.raw`\begin{CD} A @>f>> B \\ @VgVV @VVhV \\ C @>>k> D \end{CD}`,
  String.raw`\begin{flalign*} &x=1 && \\ &y=2 && \end{flalign*}`,
  String.raw`\begin{multiline} x+y \\ =3 \end{multiline}`,
  String.raw`\begin{multlined} x+y \\ =3 \end{multlined}`,
  String.raw`\begin{eqnarray*} x & = & 1 \\ y & = & 2 \end{eqnarray*}`,
  String.raw`\begin{subequations}\begin{equation}x=1\tag{1a}\end{equation}\begin{equation}y=2\tag{1b}\end{equation}\end{subequations}`,
  String.raw`\ce{2H2 + O2 -> 2H2O}`,
  String.raw`\ce{^{14}_{6}C}`,
  String.raw`\pu{123 kJ mol-1}`,
];

export const MATH_LAYOUT_CASES = [
  '\\begin{gather}\nx=1 \\\\\n\ny=2\n\\end{gather}',
  '> \\[\n> \\begin{aligned}\n> x&=1 \\\\\n> y&=2\n> \\end{aligned}\n> \\]',
  '- 식:\n\n  \\begin{gather}\n  x=1 \\\\\n\n  y=2\n  \\end{gather}',
  '수식 &amp; $x_1 + y_2$ **설명**',
  '₩[ x^2 ₩]',
  '```LaTeX\n\\[ x=1 \\]\n```',
  String.raw`물 \ce{H2O} 입니다.`,
  String.raw`$E=mc^2$ \tag{1}`,
];

export const MATH_AUDIT_ANSWER = [
  '### 수식 표시 점검',
  ...MATH_LAYOUT_CASES,
  '| 수식 | 값 |\n|---|---|\n' + MATH_CORPUS.map((tex, i) => `| $${tex}$ | ${i + 1} |`).join('\n'),
  '앞 설명 $\\unsupportedExample{x}$ 뒤 설명',
  '금액 ₩100, $200 · 원문 `\\ce{H2O}`',
].join('\n\n');
