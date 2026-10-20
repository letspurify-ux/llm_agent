// mermaid가 글자 크기를 재어 둔 캐시에 상한을 둔다. Mermaid.jsx가 mermaid보다 먼저 이 파일을 읽는다.
//
// mermaid는 라벨의 폭·높이를 잴 때(calculateTextDimensions)와 줄을 나눌 때(wrapLabel·breakString) 그 결과를
// es-toolkit의 memoize로 기억하는데, 그 캐시는 지우는 길이 없는 Map이다 — 키는 '글자 + 글꼴'이라 서로 다른
// 글자가 그려질 때마다 항목이 하나씩 늘고, 홈으로 돌아가도(새 대화) 줄지 않는다. 답변의 그림 글자에는 조회
// 결과가 섞이므로 같은 글자가 다시 올 일도 드물다. 실측(headless Chrome, 힙 스냅샷): 메시지 30개짜리 시퀀스
// 그림 하나에 약 32항목·5KB, 클래스 그림 하나에 약 1.3KB가 쌓여, 그림 40개 뒤 1,280항목·200KB가 탭이 열려
// 있는 내내 남았다(흐름도·간트는 이 캐시를 쓰지 않는다). 대화를 거듭할수록 끝없이 자라는 것은 화면에서 이것뿐이다.
//
// memoize는 캐시를 만들 때 memoize.Cache를 읽는다(new memoize.Cache()). 그래서 mermaid의 모듈이 평가되기 전에
// 이것을 상한 있는 캐시로 바꿔 두면 mermaid가 만드는 세 캐시가 모두 그것이 된다 — ES 모듈은 import 순서대로
// 평가되므로 Mermaid.jsx에서 'mermaid'보다 위에 두기만 하면 된다. es-toolkit을 직접 의존성으로 둔 것은 mermaid와
// 같은 한 벌을 받기 위해서다: 버전이 갈려 두 벌이 깔리면 여기서 바꾼 것이 mermaid의 것에 닿지 않는다
// (test/mermaid-memo.test.js가 그 어긋남을 잡는다).
//
// 넘치면 가장 오래 쓰지 않은 것부터 버린다. 버린 글자가 다시 오면 한 번 더 잴 뿐이라 그림은 같다. 상한은 그림
// 하나가 재는 글자보다 넉넉해야 한다 — 한 번 그리는 도중에 밀려나면 같은 글자를 거듭 재느라 느려진다.
import { memoize } from 'es-toolkit/compat';

export const MEMO_LIMIT = 2000;

export class BoundedCache extends Map {
  get(key) {
    if (!super.has(key)) return undefined;
    // 쓴 것을 맨 뒤로 옮긴다 — Map은 넣은 순서를 지키므로 맨 앞이 가장 오래 쓰지 않은 것이 된다.
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    super.delete(key);
    super.set(key, value);
    while (this.size > MEMO_LIMIT) super.delete(super.keys().next().value);
    return this;
  }
}

memoize.Cache = BoundedCache;
