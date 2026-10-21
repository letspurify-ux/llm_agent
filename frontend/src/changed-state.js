import { useCallback, useRef, useState } from 'react';

// 값이 실제로 바뀔 때만 setState를 부르는 useState. 크기 관찰자·창 이벤트처럼 같은 값을 거듭 알려 오는
// 자리에서 쓴다.
//
// React 18은 같은 값이라 렌더를 건너뛴 업데이트도 버리지 않는다 — 그 업데이트 객체를 훅의 대기열에 이어
// 두고(enqueueConcurrentHookUpdateAndEagerlyBailout) 그 컴포넌트가 다음에 실제로 렌더될 때에야 비운다.
// 값이 그대로인 한 그 컴포넌트는 렌더되지 않으므로 대기열은 끝없이 자란다. 실측(headless Chrome): 수식이
// 많은 답변에서 창 크기를 150번 바꾸자 인라인 수식들의 대기열에 업데이트 5천여 개(업데이터 클로저 3천여 개)가
// 쌓였고 힙이 바꿀 때마다 약 15KB씩 늘었다. 창 가장자리를 끄는 한 번에 resize가 수십 번 온다.
// 마지막으로 넣은 값을 따로 들고 있다가 같으면 아예 부르지 않는다. same은 모듈 상수여야 한다(바뀌면 setter도
// 새로 만들어진다).
export function useChangedState(initial, same = Object.is) {
  const [value, setValue] = useState(initial);
  const last = useRef(value);
  const set = useCallback(next => {
    if (same(last.current, next)) return;
    last.current = next;
    setValue(next);
  }, [same]);
  return [value, set];
}
