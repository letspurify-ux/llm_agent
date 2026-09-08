// 운영 스키마와 같은 1024차원. 위치로 응답 순서와 본문 대응을 구분한다.
export const vector = (slot = 0) => Array.from({ length: 1024 }, (_, i) => Number(i === slot));
