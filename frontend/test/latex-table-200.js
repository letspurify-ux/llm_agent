// 20개 분야 × 서로 다른 10개 수식. 숫자만 바꾼 반복 대신 문법과 조판 구조를 다양하게 둔다.
// 테스트용 Markdown 파일과 브라우저 픽스처가 아래 한 원본을 공유한다.
const groups = [
  ['대수', String.raw`
a+b=b+a
(a+b)c=ac+bc
(a+b)^2=a^2+2ab+b^2
a^2-b^2=(a-b)(a+b)
x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
\binom{n}{k}=\frac{n!}{k!(n-k)!}
a\equiv b\pmod{m}
\gcd(a,b)\operatorname{lcm}(a,b)=|ab|
\prod_{k=1}^{n}(x-a_k)
\underbrace{x+\cdots+x}_{n\text{ times}}=nx
`],
  ['거듭제곱·근호', String.raw`
\sqrt{a^2}=|a|
\sqrt[3]{x^3}=x
x^{m+n}=x^m x^n
\frac{x^m}{x^n}=x^{m-n}
(x^m)^n=x^{mn}
\sqrt{x\sqrt{x\sqrt{x}}}
x^{-1}=\frac{1}{x}
x^{1/2}=\sqrt{x}
\sqrt{\frac{a}{b}}=\frac{\sqrt{a}}{\sqrt{b}}
\sqrt{1+\sqrt{1+x^2}}
`],
  ['분수·절댓값', String.raw`
\frac{1}{1+\frac{1}{x}}
\dfrac{x+1}{x-1}
\tfrac{a}{b}+\tfrac{c}{d}=\tfrac{ad+bc}{bd}
|x+y|\le |x|+|y|
\left|\frac{x-y}{x+y}\right|
\left\|\mathbf{x}\right\|_2=\sqrt{\sum_i x_i^2}
\kappa=\frac{|x'y''-y'x''|}{(x'^2+y'^2)^{3/2}}
\frac{\lvert a-b\rvert}{\lvert a+b\rvert}
\frac{\frac{a}{b}}{\frac{c}{d}}=\frac{ad}{bc}
\left.\frac{dy}{dx}\right|_{x=0}
`],
  ['삼각함수', String.raw`
\sin^2 x+\cos^2 x=1
\tan x=\frac{\sin x}{\cos x}
\sin(a+b)=\sin a\cos b+\cos a\sin b
\cos(a+b)=\cos a\cos b-\sin a\sin b
\sin(2x)=2\sin x\cos x
\cos(2x)=1-2\sin^2 x
\arcsin x+\arccos x=\frac{\pi}{2}
\sinh x=\frac{e^x-e^{-x}}{2}
\cosh^2 x-\sinh^2 x=1
\tanh x=\frac{\sinh x}{\cosh x}
`],
  ['로그·지수', String.raw`
e^{x+y}=e^x e^y
\ln(ab)=\ln a+\ln b
\ln\frac{a}{b}=\ln a-\ln b
\log_a b=\frac{\ln b}{\ln a}
e^{\ln x}=x
\ln(x^r)=r\ln x
\exp\left(-\frac{x^2}{2}\right)
2^{\log_2 x}=x
\log_{10}(10^x)=x
\ln\left|\frac{x-1}{x+1}\right|
`],
  ['극한', String.raw`
\lim_{x\to0}\frac{\sin x}{x}=1
\lim_{n\to\infty}\left(1+\frac{1}{n}\right)^n=e
\lim_{x\to0}\frac{e^x-1}{x}=1
\lim_{x\to0}\frac{\ln(1+x)}{x}=1
\lim_{x\to\infty}\frac{1}{x}=0
\lim_{h\to0}\frac{f(x+h)-f(x)}{h}
\limsup_{n\to\infty}a_n
\liminf_{n\to\infty}a_n
\lim_{x\to a^-}f(x)
\lim_{x\to a^+}f(x)
`],
  ['미분', String.raw`
\frac{d}{dx}x^n=nx^{n-1}
\frac{d}{dx}\sin x=\cos x
\frac{d}{dx}\ln|x|=\frac{1}{x}
\frac{d}{dx}e^x=e^x
(fg)'=f'g+fg'
\left(\frac{f}{g}\right)'=\frac{f'g-fg'}{g^2}
\frac{d}{dx}f(g(x))=f'(g(x))g'(x)
\frac{\partial^2 f}{\partial x\,\partial y}
\nabla f=\left(\frac{\partial f}{\partial x},\frac{\partial f}{\partial y}\right)
\frac{d^n}{dx^n}e^{ax}=a^n e^{ax}
`],
  ['적분', String.raw`
\int\frac{1}{x}\,dx=\ln|x|+C
\int x^n\,dx=\frac{x^{n+1}}{n+1}+C
\int_0^1 x^2\,dx=\frac{1}{3}
\int e^x\,dx=e^x+C
\int\cos x\,dx=\sin x+C
\int u\,dv=uv-\int v\,du
\int_{-\infty}^{\infty}e^{-x^2}\,dx=\sqrt{\pi}
\iint_D f(x,y)\,dx\,dy
\iiint_V\rho\,dV
\oint_C\mathbf{F}\cdot d\mathbf{r}
`],
  ['급수·곱', String.raw`
\sum_{k=1}^n k=\frac{n(n+1)}{2}
\sum_{k=1}^n k^2=\frac{n(n+1)(2n+1)}{6}
\sum_{k=0}^n r^k=\frac{1-r^{n+1}}{1-r}
\sum_{k=0}^{\infty}\frac{x^k}{k!}=e^x
\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}
\prod_{k=1}^n k=n!
\sum_{\substack{i+j=n\\i,j\ge0}}a_i b_j
\sum_{i=1}^n\sum_{j=1}^m a_{ij}
\prod_{p\text{ prime}}\frac{1}{1-p^{-s}}
\sum_{n=0}^{\infty}(-1)^n\frac{x^{2n+1}}{(2n+1)!}
`],
  ['행렬', String.raw`
\begin{pmatrix}a&b\\c&d\end{pmatrix}
\begin{bmatrix}1&0\\0&1\end{bmatrix}
\begin{vmatrix}a&b\\c&d\end{vmatrix}=ad-bc
\begin{Vmatrix}a&b\\c&d\end{Vmatrix}
\begin{Bmatrix}a&b\\c&d\end{Bmatrix}
\begin{matrix}1&2&3\\4&5&6\end{matrix}
\begin{pmatrix*}[r]-1&20\\300&-4\end{pmatrix*}
\begin{array}{c|c}a&b\\c&d\end{array}
\begin{smallmatrix}a&b\\c&d\end{smallmatrix}
A^{-1}=\frac{1}{ad-bc}\begin{pmatrix}d&-b\\-c&a\end{pmatrix}
`],
  ['벡터·선형대수', String.raw`
\mathbf{a}\cdot\mathbf{b}=\sum_i a_i b_i
\mathbf{a}\times\mathbf{b}=-\mathbf{b}\times\mathbf{a}
\det(AB)=\det(A)\det(B)
\operatorname{tr}(AB)=\operatorname{tr}(BA)
A\mathbf{v}=\lambda\mathbf{v}
\operatorname{rank}(A)+\operatorname{nullity}(A)=n
\langle x,y\rangle=\overline{\langle y,x\rangle}
\nabla\cdot\mathbf{F}=\frac{\partial F_x}{\partial x}+\frac{\partial F_y}{\partial y}+\frac{\partial F_z}{\partial z}
\nabla\times(\nabla f)=\mathbf{0}
\operatorname{proj}_{u}v=\frac{\langle v,u\rangle}{\langle u,u\rangle}u
`],
  ['확률', String.raw`
P(A|B)=\frac{P(A\cap B)}{P(B)}
P(A\cup B)=P(A)+P(B)-P(A\cap B)
P(A^c)=1-P(A)
P(A\mid B)=\frac{P(B\mid A)P(A)}{P(B)}
\mathbb{E}[X]=\sum_x xP(X=x)
\operatorname{Var}(X)=\mathbb{E}[X^2]-\mathbb{E}[X]^2
P(X=k)=\binom{n}{k}p^k(1-p)^{n-k}
P(X=k)=e^{-\lambda}\frac{\lambda^k}{k!}
f(x)=\frac{1}{\sqrt{2\pi\sigma^2}}e^{-\frac{(x-\mu)^2}{2\sigma^2}}
P(|X-\mu|\ge k\sigma)\le\frac{1}{k^2}
`],
  ['통계', String.raw`
\bar{x}=\frac{1}{n}\sum_{i=1}^n x_i
s^2=\frac{1}{n-1}\sum_{i=1}^n(x_i-\bar{x})^2
z=\frac{x-\mu}{\sigma}
\operatorname{Cov}(X,Y)=\mathbb{E}[(X-\mu_X)(Y-\mu_Y)]
\rho=\frac{\operatorname{Cov}(X,Y)}{\sigma_X\sigma_Y}
\hat{\beta}=(X^\top X)^{-1}X^\top y
\operatorname{MSE}=\frac{1}{n}\sum_i(y_i-\hat{y}_i)^2
\operatorname{SE}(\bar{x})=\frac{s}{\sqrt{n}}
t=\frac{\bar{x}-\mu_0}{s/\sqrt{n}}
\chi^2=\sum_i\frac{(O_i-E_i)^2}{E_i}
`],
  ['집합·논리', String.raw`
A\subseteq B\subseteq C
A\cap(B\cup C)=(A\cap B)\cup(A\cap C)
(A\cup B)^c=A^c\cap B^c
\forall x\in\mathbb{R},\ x^2\ge0
\exists x\in\mathbb{N}:x>10
p\implies q
p\iff q
\neg(p\land q)=(\neg p)\lor(\neg q)
\{x\in\mathbb{R}\mid |x|<1\}
f:A\to B,\quad x\mapsto f(x)
`],
  ['복소수', String.raw`
e^{i\theta}=\cos\theta+i\sin\theta
e^{i\pi}+1=0
|z|=\sqrt{z\overline{z}}
\operatorname{Re}(z)=\frac{z+\overline{z}}{2}
\operatorname{Im}(z)=\frac{z-\overline{z}}{2i}
\overline{zw}=\overline{z}\,\overline{w}
z^{-1}=\frac{\overline{z}}{|z|^2}
(\cos\theta+i\sin\theta)^n=\cos(n\theta)+i\sin(n\theta)
z=re^{i\theta}
\arg(z_1z_2)\equiv\arg z_1+\arg z_2\pmod{2\pi}
`],
  ['함수·물리', String.raw`
\Gamma(z)=\int_0^{\infty}t^{z-1}e^{-t}\,dt
B(x,y)=\frac{\Gamma(x)\Gamma(y)}{\Gamma(x+y)}
\zeta(s)=\sum_{n=1}^{\infty}\frac{1}{n^s}
\operatorname{erf}(x)=\frac{2}{\sqrt{\pi}}\int_0^x e^{-t^2}\,dt
\mathcal{F}\{f\}(\omega)=\int_{-\infty}^{\infty}f(t)e^{-i\omega t}\,dt
\mathcal{L}\{f\}(s)=\int_0^{\infty}e^{-st}f(t)\,dt
E=mc^2\tag{1}
F=G\frac{m_1m_2}{r^2}
i\hbar\frac{\partial\psi}{\partial t}=\hat{H}\psi
\Delta x\,\Delta p\ge\frac{\hbar}{2}
`],
  ['다중 행 환경', String.raw`
\begin{gather}x+y=10\\x-y=4\end{gather}
\begin{gather*}a=1\\b=2\end{gather*}
\begin{gathered}x^2+y^2=1\\x=y\end{gathered}
\begin{align}a&=b+c\\&=d\end{align}
\begin{align*}x&=1\\y&=2\end{align*}
\begin{aligned}f(x)&=x^2\\f'(x)&=2x\end{aligned}
\begin{split}a&=b+c\\&=d+e\end{split}
\begin{equation}a^2+b^2=c^2\end{equation}
\begin{equation*}\sum_i p_i=1\end{equation*}
\begin{alignat*}{2}a&=b & c&=d\end{alignat*}
`],
  ['정렬·구간 환경', String.raw`
\begin{cases}x&x\ge0\\-x&x<0\end{cases}
\begin{dcases}\frac{1}{x}&x\ne0\\0&x=0\end{dcases}
\begin{rcases}x>0\\y>0\end{rcases}\implies xy>0
\begin{alignedat}{2}x&=1&y&=2\end{alignedat}
\begin{array}{rcl}a&=&b+c\\d&=&e\end{array}
\begin{array}{|c|c|}\hline a&b\\\hline c&d\\\hline\end{array}
\begin{CD}A @>f>> B\\@VgVV @VVhV\\C @>>k> D\end{CD}
\begin{bmatrix*}[l]1&2\\30&40\end{bmatrix*}
\begin{darray}{cc}\frac{1}{2}&\frac{1}{3}\\\frac{1}{4}&\frac{1}{5}\end{darray}
\begin{equation}\begin{split}x&=a+b\\&=c\end{split}\tag{A}\end{equation}
`],
  ['화학식', String.raw`
\ce{H2O}
\ce{2H2 + O2 -> 2H2O}
\ce{CO2 + H2O <=> H2CO3}
\ce{SO4^2-}
\ce{^{14}_{6}C}
\ce{NH4+}
\ce{Fe^3+ + e- -> Fe^2+}
\ce{CH3-CH2-OH}
\ce{A ->[\Delta] B}
\ce{CaCO3 -> CaO + CO2}
`],
  ['단위·문자 조판', String.raw`
\pu{123 kJ mol-1}
\pu{9.81 m s-2}
\pu{1.23e5 Pa}
\pu{298 K}
\text{cost: \$5}+x
\text{A\&B}:\quad x_1+x_2
\overbrace{a+b+c}^{\text{sum}}
\underbracket{x+y}_{\text{pair}}
\cancel{x}+y
\boxed{\displaystyle\frac{a+b}{c+d}}
`],
];

const wrappers = [tex => `$${tex}$`, tex => `$ ${tex} $`, tex => `$${tex} $`,
  tex => `$ ${tex}$`, tex => `\\(${tex}\\)`, tex => `\\[${tex}\\]`, tex => `$$${tex}$$`];
export const LATEX_200_CASES = groups.flatMap(([category, source]) => source.trim().split('\n').map(tex => ({ category, tex })))
  .map((entry, index) => {
    const id = String(index + 1).padStart(3, '0');
    const slash = ['\\', '₩', '￦'][index % 3];
    return { ...entry, id, input: wrappers[index % wrappers.length](entry.tex.replaceAll('\\', slash)), marker: `행 ${id} 완료` };
  });

// raw |도 의도적으로 유지한다. GFM에 먼저 넘겨 수식이나 마지막 열이 사라지면 테스트가 실패해야 한다.
export const LATEX_200_MARKDOWN = '# LaTeX 수식 200개 표 검증\n\n' +
  '| 번호 | 분야 | 수식 | 행 확인 |\n|---|---|---|---|\n' +
  LATEX_200_CASES.map(({ id, category, input, marker }) => `| ${id} | ${category} | ${input} | ${marker} |`).join('\n') + '\n';
