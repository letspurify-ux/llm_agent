# qwen3-embedding 임베딩 서버 (Windows)

SPACE VOC Agent의 벡터 검색에 쓰는 임베딩 모델(`qwen3-embedding:0.6b`, 1024차원)을 Windows에서 기동한다.
`bge-m3`(setup/bge-m3)와 같은 자리를 대신하는 모델이므로 둘 중 하나만 쓴다.

**임베딩 서버는 필수다.** 검색이 벡터 단일 경로라 없으면 지식·처리방법·쿼리를 하나도 찾지 못하고,
그 상태는 화면과 chat_log에 '검색 불가'로 남는다.
모델이 유휴 5분 뒤 내려가지 않게 `OLLAMA_KEEP_ALIVE=-1`을 둔다 — `start.bat`이 걸어 주고, 다른 방법으로 띄우면 직접 설정한다.

## 이 모델을 고른 근거 (이 저장소에서 실측)

| 항목 | 값 | 왜 중요한가 |
|---|---|---|
| 차원 | **1024** | `vec_*` 테이블이 `VECTOR(1024)`다. 다른 차원이면 스키마를 통째로 바꿔야 한다 |
| 정규화 | L2 (노름 1.0) | 코사인 거리 계산이 `bge-m3`와 같은 자에서 성립한다 |
| 크기 | 639MB (Q4_K_M) | bge-m3(1.2GB)보다 작다 |
| 컨텍스트 | 32k 토큰 | 임베딩 원문 상한(`MAX_EMBED_TEXT_LEN` 4,000자)에 여유가 크다 |

**관련도 문턱(`search.js MAX_DIST = 0.55`)은 그대로 쓸 수 있다.** 이 저장소의 실제 지식 7건(청크 전체)에
관련 질문 8개·무관 질문 5개를 걸어 코사인 거리를 재 보면:

| | 관련 질문 ↔ 정답 문서 | 무관 질문 ↔ 모든 문서 | 놓침 | 오탐 |
|---|---|---|---:|---:|
| bge-m3 | 0.241 ~ 0.486 | 0.629 ~ 0.805 | 0/8 | 0/35 |
| qwen3-embedding:0.6b | 0.226 ~ 0.514 | 0.675 ~ 0.857 | 0/8 | 0/35 |

두 모델 다 0.55에서 놓침·오탐이 없고, 분리 여유는 qwen3 쪽이 조금 더 넓다(0.161 vs 0.143).
**등록 지식이 늘면 이 값을 다시 재라** — 근거는 `chat_log`의 `trace.search.top`에 남는 거리 분포다.

## 사전 준비 (최초 1회)

Ollama 설치:

```
winget install Ollama.Ollama
```

winget이 없으면 https://ollama.com/download 에서 설치한다. 설치 후 새 터미널을 열어야
`ollama` 명령을 인식한다.

## 사용

기동:

```
start.bat
```

`start.bat`이 하는 일 — Ollama 설치 확인 → 서버 기동(이미 떠 있으면 재사용) →
모델 없으면 다운로드(~640MB) → 한국어 임베딩 호출로 1024차원이 나오는지 검증.
최초 실행은 모델 다운로드와 로드로 몇 분 걸리고, 이후에는 수 초 만에 끝난다.

중지:

```
stop.bat
```

모델 파일은 남으므로 다시 기동할 때 재다운로드하지 않는다.

## 인터넷이 안 되는 사내망 (오프라인 반입)

`ollama pull`은 `registry.ollama.ai`로 나간다. 사내망에서 그 주소가 막혀 있으면 **인터넷이 되는 PC에서
받아 파일로 옮긴다.** Ollama의 모델 저장소는 평범한 파일 두 종류라 복사만으로 옮겨진다.

1) 인터넷이 되는 PC에서:

```
ollama pull qwen3-embedding:0.6b
```

2) 그 PC의 아래 두 자리를 통째로 복사한다 (Windows는 `%USERPROFILE%\.ollama\models`,
   macOS/Linux는 `~/.ollama/models`):

```
models\manifests\registry.ollama.ai\library\qwen3-embedding\0.6b   ← 작은 JSON 파일 하나
models\blobs\sha256-06507c7b4268...   ← 639MB (모델 본체)
models\blobs\sha256-9202febed9e2...   ← 266B (설정)
```

  옮길 blob의 이름은 위 manifest 파일 안에 `digest`로 적혀 있다 — `sha256:` 의 콜론을 하이픈으로
  바꾼 것이 파일 이름이다. 그 두 개만 있으면 되고, 다른 모델의 blob은 가져갈 필요가 없다.

3) 사내망 PC의 같은 경로에 그대로 붙여 넣은 뒤 확인한다:

```
ollama list
```

  `qwen3-embedding:0.6b`가 보이면 끝이다. `start.bat`은 이미 있는 모델을 다시 받지 않는다.

**프록시만 있는 경우**는 반입까지 갈 필요가 없다 — `HTTPS_PROXY`를 설정한 뒤 `ollama pull`을 직접 실행한다.

## 백엔드 연결

`backend/.env`:

```
EMBEDDING_URL=http://localhost:11434/v1
EMBEDDING_MODEL=qwen3-embedding:0.6b
```

`EMBEDDING_MODEL`을 바꾸면 **저장된 벡터가 전부 낡은 것이 된다** — 변경 감지 해시에 모델명이 들어 있어
(`embed-sync.js`) 다음 동기화가 전 행을 자동으로 다시 임베딩한다. 등록 규모에 따라 수 분 걸리고,
그동안 검색은 옛 벡터로 계속 동작한다. 즉시 반영하려면 `backend`에서 `npm run embed`를 실행한다.

### 질의 지시문 (선택)

Qwen3-Embedding 계열은 **질의에만** 한 문장 지시문을 붙이도록 학습됐다(문서에는 붙이지 않는다).
쓰려면 `backend/.env`에 아래를 둔다:

```
EMBEDDING_QUERY_PREFIX="Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: "
```

**반드시 큰따옴표로 감쌀 것** — dotenv는 큰따옴표일 때만 `\n`을 줄바꿈으로 풀고 값 끝의 공백을 지킨다.
(따옴표를 잊어도 백엔드가 `\n`을 되살리지만, 끝의 공백은 dotenv 단계에서 이미 잘려 되살릴 수 없다.)

설정하지 않으면 아무것도 붙지 않으며 지금까지와 동일하게 동작한다 — `bge-m3`처럼 지시문을 쓰지 않는
모델에는 **비워 두어야 한다**(붙이면 오히려 거리가 멀어진다, 실측).

**이 저장소의 등록 데이터로 재 보면 붙이지 않는 쪽이 낫다.** 실제 서버를 띄워 같은 질문 넷을 넣은 결과:

| 질문 | 접두 없음 (지식·처리방법·쿼리) | 접두 있음 |
|---|---|---|
| 배치가 실패했는데 어떻게 다시 돌리나요 | 1 · 1 · 2 | 1 · 1 · 2 |
| 가상계측이 뭐야 | 5 · 1 · 3 | 4 · **0** · **0** |
| 시스템 점검은 언제 하나요 | 1 · 1 · 3 | 1 · **0** · **0** |
| 오늘 점심 뭐 먹지 (무관) | 0 · 0 · 1 | 0 · 0 · 0 |

지식은 비슷하지만 **처리방법·쿼리가 0건으로 떨어진다** — 그 둘은 문단이 아니라 제목과 짧은 설명이라
"retrieve relevant passages"라는 지시문과 어울리지 않는다. 그리고 그 경로가 끊기면 에이전트가
조회를 아예 시작하지 못한다. 그래서 **기본은 비워 두는 것**이고, 사내 문서로 바꾼 뒤 다시 재 볼 것 —
그러라고 손잡이로 뺀 값이다(대상별로 다른 지시문이 필요하면 그때 코드를 나눈다).

## 문제 해결

**포트 11434가 이미 사용 중** — Ollama 트레이 앱이 이미 실행 중일 가능성이 높다.
`start.bat`은 이 경우 기존 서버를 그대로 쓰므로 정상이다.

**차원이 1024가 아니라는 오류** — `qwen3-embedding`의 다른 크기(4b·8b)는 차원이 다르다.
`EMBEDDING_MODEL`에 태그(`:0.6b`)까지 정확히 적혔는지 확인한다.

**다운로드 실패** — 위 '인터넷이 안 되는 사내망' 절차를 따른다.

**Docker를 선호하는 경우**:

```
docker run -d --name ollama -p 11434:11434 -v ollama:/root/.ollama ollama/ollama
docker exec ollama ollama pull qwen3-embedding:0.6b
```

이 경우 `start.bat` 없이 `docker start ollama` / `docker stop ollama`로 기동·중지한다.
