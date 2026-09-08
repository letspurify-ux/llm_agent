# 표시 버그 회귀 검사 목록

수식·Markdown·차트 관련으로 지금까지 발견한 결함과 이를 지키는 정식 테스트를 연결한다.
테스트 입력은 저장소에 보관하며 실제 ReactMarkdown/KaTeX 렌더 결과와 Chrome 화면을 검사한다.
예제 수와 Node 테스트 수는 다르다. 하나의 테스트가 여러 입력 조합을 전수 검사한다.

## 필수 실행

저장소 루트에서:

```sh
npm ci --prefix frontend
npm ci --prefix backend
npm --prefix frontend run test:regression
```

Node 22 이상과 Chrome이 필요하다. 필요하면 `CHROME_PATH`로 실행 파일을 지정한다.
이 명령은 백엔드 응답 전송 검사, 프런트엔드 전체 단위 검사, 실제 Chrome UI 검사,
현재 소스를 새로 빌드하는 production 검사를 순서대로 실행한다. 어느 단계든 실패하면 종료 코드가
실패이며, Chrome이 없으면 검사를 건너뛰지 않고 실패한다. 실제 DB·LLM 접속은 필요 없다.
[CI](../.github/workflows/rendering-regressions.yml)도 모든 push/PR에서 같은 명령을 실행한다.
브랜치 보호의 필수 상태 검사 설정은 이 워크플로 추가와 별개다.

## 결함과 판정

| 발견한 결함 / 보존할 동작 | 정식 테스트 | 실패 판정 |
|---|---|---|
| `gather`, `split`, `flalign`, `multline`/`multiline`, `subequation(s)`, `tag` 원문 노출 | [math.test.js](../frontend/test/math.test.js) | 환경·행·명시적 번호·정확한 수식 원문과 렌더 수 대조 |
| 원화/전각 백슬래시, 제어 공백·기호, `ce`/`pu` | 같은 math 테스트, [200개 표](../frontend/test/latex-table-200.test.js) | 명령 정규화·화학식 렌더 확인, 통화·코드 원문 보존 |
| 표의 근호·적분·곡률, 공백·절댓값 파이프 때문에 수식과 셀 잘림 | math 테스트, 200개 표 테스트 | 정상 540개 조합, 오류 90개 조합의 원문·열·이웃 셀·다음 행 보존 |
| 미완성 구분자·중괄호·미지원 명령이 다음 수식이나 답변을 삼킴 | math 테스트, [valid-math-edge.test.js](../frontend/test/valid-math-edge.test.js) | 오류의 정확한 원문, 다른 목록·인용문 경계, 뒤의 정상 수식 보존 |
| Markdown이 수식의 `_`, `*`, 백슬래시, 엔티티를 먼저 해석함 | math 테스트 | 24식 × 4구분자 × 6위치 = 576개 조합의 수식·구조 대조 |
| 구분자 없는 번호 수식이 인용/목록 기호를 가져가거나 번호 목록에서 누락 | [mixed-content.test.js](../frontend/test/mixed-content.test.js) | LF/CRLF, 5종 컨테이너에서 수식과 목록·인용 구조 동시 확인 |
| 깊은 중첩 인용문, 다음 줄 tag, 소수점 식, 참조 링크 속 수식 누락 | valid-math-edge 테스트 | 78개 정상 예제와 144개 서식 조합, 합친 문서의 정확한 원문·링크·구조 확인 |
| 긴 일반 텍스트의 번호 탐색으로 화면 정지 | valid-math-edge 테스트 | 7만 자 입력을 제한 시간 내 별도 프로세스에서 처리 |
| 좁은 화면에서 식 번호와 본문 겹침 | [valid-edge-checks.mjs](../frontend/test/ui/valid-edge-checks.mjs) | 실제 본문/번호 bounding box 충돌, 가로 넘침 검사 |
| 표의 수식 파이프와 축약/생략/명시적 참조 링크 충돌로 링크 소실·중복 | [table-link-edge.test.js](../frontend/test/table-link-edge.test.js) | LF/CRLF 본문 360개·머리글 360개 조합, 180개 합친 표의 링크 개수·URL·제목·수식·셀 대조 |
| 뒤에 미완성 코드 펜스가 오면 앞의 참조 링크 소실 | 같은 table-link-edge 테스트 | 펜스의 모든 접두사에서 완성된 링크 유지 |
| 표에 수식 200개가 함께 있을 때 누락·잘림 | 200개 표 테스트, [latex-table-200-checks.mjs](../frontend/test/ui/latex-table-200-checks.mjs) | 고정 Markdown 파일과 200개 서로 다른 식·800개 셀 전수 대조 및 실제 화면 확인 |
| 중첩 표·수식·차트·Mermaid·각주·인쇄 조합 | mixed-content 테스트, [mixed-content-checks.mjs](../frontend/test/ui/mixed-content-checks.mjs) | 수식 원문, 차트 막대, Mermaid 노드, 각주 링크, 모바일/데스크톱/인쇄 레이아웃 확인 |
| 미완성 수식이 뒤의 코드 블록·정상 수식을 삼킴, 수식 모양 각주 식별자, 연속 `$x$$y$` 누락 | [rendering-combinations.test.js](../frontend/test/rendering-combinations.test.js) | 정상 쌍·오류 격리·컨테이너·개행 등 1,198개 입력 대조 |
| 표의 `\\<br>` 원문 노출, 한 셀의 수식·목록·인용·설명·시각화 분리 | [rich-table.test.js](../frontend/test/rich-table.test.js), [rich-table-checks.mjs](../frontend/test/ui/rich-table-checks.mjs) | 실제 블록 구조·셀 수·이웃 값·수식 원문과 데스크톱/320px 그림 크기 확인 |
| 표 안 및 독립 문단의 직렬화된 Mermaid/chart가 코드로 남음 | 같은 rich-table 테스트, ui/production 테스트 | `<br>`·리터럴 `\\n`·백틱 변형·스트림 접두사·미리보기에서 최종 그림으로 전환 |
| 인용문·목록·직렬화된 표 셀 차트의 조회 참조 누락 | rendering-combinations·rich-table 테스트, [rendering-browser.mjs](../frontend/test/review/rendering-browser.mjs) | 서버가 실제 조회 결과를 채우고 `|`·백슬래시·`<br>`·코드 모양의 값을 그대로 보존, 예산 상한 확인 |
| 이중 이스케이프된 근의 공식·개행, 이스케이프된 인용 기호 | rich-table 테스트 | 근의 공식과 조건의 정확한 TeX 원문, 정상 `\\nu`·행 구분자·코드·주소 보존 |
| Mermaid 흐름도 수식 라벨이 달러 원문으로 남음 | ui/production 테스트 | 실제 MathML 조판 크기, 혼합 그림 렌더, 수식·다른 라벨의 이미지 자동 요청 차단 |
| 스트림 중간의 수식/표/펜스, reset, 중단·재시도, 홈 이동 뒤 늦은 응답 | [ui.test.mjs](../frontend/test/ui/ui.test.mjs), [stream.test.js](../frontend/test/stream.test.js) | 미완성 미리보기·완료 답변·대화 이력 분리, UTF-8/JSON 조각 경계 보존 |
| JSON 디코딩에서 TeX 백슬래시가 제어 문자로 변환되거나 응답 소실 | [llm-openai.test.js](../backend/test/llm-openai.test.js) | 정상/덜 이스케이프된 기존 코퍼스 및 최신 4개 전체 문서의 최종 원문·1/7/1000자 조각 대조 |
| 개발 모드만 통과하고 배포 빌드에서 회귀 | [production.test.mjs](../frontend/test/ui/production.test.mjs) | 실제 빌드에서 200개 표·78개 정상 예제·180개 링크 표와 복합 콘텐츠 검사 |
| Chrome 누락으로 화면 검사가 생략되는데 전체 성공 | [driver.test.js](../frontend/test/driver.test.js), [필수 실행기](../frontend/test/run-regressions.mjs) | 브라우저 없는 필수 모드는 예외, 전체 실행은 REQUIRE_CHROME=1 전달 |
| Linux에서 패널을 펼칠 때 머리글이 63px 이동 | ui.test의 `펼침(⚡ 실행된 쿼리·표로 보기)` 및 진행 중 펼침/접힘 검사 | 클릭 직전 좌표와 펼친 뒤 좌표의 차이가 6px 미만, 머리글 위치 복원 |
| 한 라벨의 첫 글자 조각만 측정해 흐름도 일부 글자가 8px로 축소 | ui.test의 `좁은 화면: 흐름도 글자` | 모든 tspan의 실제 높이가 9px 이상, 인쇄에서는 최소 폭 해제 |

차트 파싱·빈 데이터·오류 데이터, Markdown 링크·코드·이미지, Mermaid 보안, 미리보기 상태의
기존 `chart`, `markdown`, `mermaid-secure`, `preview` 테스트도 전체 단위/UI 검사에 함께 포함된다.
화면 판정은 단순히 KaTeX 요소가 있는지만 세지 않고 원문·이웃 콘텐츠·링크·실제 크기도 확인한다.
단위 테스트 파일은 순서대로 실행한다. 조합 전수 검사의 CPU 부하가 다른 파일의 성능 비율 측정에
섞이지 않도록 하며, 기존 시간 제한과 성능 비율 기준은 유지한다. 미완성 수식의 비용 비교는
작은/큰 입력을 번갈아 세 번 측정한 중앙값을 사용해 한 번의 GC로 인한 오판을 줄인다.
새 버그는 실패 입력과 기대 결과를 해당 코퍼스/테스트에 먼저 추가한 뒤 수정하며,
화면 배치 결함이면 UI 공통 판정과 production 경로에도 포함한다.

## 실행 결과

2026-09-09 수정 후 필수 회귀 검사에서 백엔드 전송 103개, 프런트 단위 287개, Chrome UI 87개,
production 3개, 총 480개가 통과했다(실패·취소·건너뜀 0개). 정적 교차 조합 1,198개와
production 화면 20개를 포함한다. 마지막 직렬화 명령 보존 보완의 단위 검사 8개도 재실행해 통과했다.
이후 조회값의 문자 `<br>` 보호를 추가하고 프런트 단위 288개·백엔드 전체 564개를 재실행해 모두 통과했다.
자세한 수정 전 재현과 검증 범위는 [조합 정밀 검토](rendering-combination-review.md)에 기록했다.

2026-09-08 로컬에서 `npm --prefix frontend run test:regression`으로 백엔드 전송 103개,
프런트엔드 단위 273개, 실제 Chrome UI 84개, production 2개, 총 462개가 통과했다.
실패·취소·건너뜀은 모두 0개다. 이는 위에 명시한 입력과 동작의 검증 결과이며,
모든 임의 입력에 결함이 없다는 보장은 아니다.

CI 최초 실행에서는 한글 글꼴이 없는 환경의 차트 검사 전제 실패도 확인했다.
Linux 작업에 `fonts-noto-cjk` 설치를 추가했고, 위 두 화면 문제는 원격 재현 결과에 따라
수정했다. 패널 검사는 좌표 측정과 클릭을 같은 JS 작업으로 묶어 통신 사이의 이동도 배제한다.
