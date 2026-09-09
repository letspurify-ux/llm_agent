// 요청 취소의 공통 경계. AbortSignal을 직접 기다리지 않는 DB·테스트 대역도 호출부는 즉시
// 빠져나갈 수 있게 하고, 실제 작업이 signal을 지원하면 같은 신호로 상류 작업까지 끊는다.

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('요청이 중지되었습니다.');
  error.name = 'AbortError';
  throw error;
}

// promise 자체를 취소하는 함수는 아니다. signal을 지원하지 않는 작업은 뒤에서 마무리되지만,
// 요청 루프는 곧바로 물러난다. promise에는 끝까지 처리기를 붙여 늦은 거부가 unhandledRejection으로
// 새지 않게 한다.
export function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  try { throwIfAborted(signal); } catch (error) { return Promise.reject(error); }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      try { throwIfAborted(signal); }
      catch (error) { finish(reject, error); }
    };

    signal.addEventListener('abort', onAbort, { once: true });
    // aborted 확인과 리스너 등록 사이의 경주를 닫는다.
    if (signal.aborted) onAbort();
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
