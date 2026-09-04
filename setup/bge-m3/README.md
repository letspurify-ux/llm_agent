# bge-m3 임베딩 서버 (Windows)

SPACE VOC Agent의 벡터 검색에 쓰는 임베딩 모델(bge-m3, 1024차원)을 Windows에서 기동한다.

**임베딩 서버는 필수다.** 검색이 벡터 단일 경로라 없으면 지식·처리방법·쿼리를 하나도 찾지 못하고,
그 상태는 화면과 chat_log에 '검색 불가'로 남는다. 표현이 다른 질문("측정 안 하고 품질 아는 방법" ↔ "가상계측")도 의미로 찾는다.
모델이 유휴 5분 뒤 내려가지 않게 `OLLAMA_KEEP_ALIVE=-1`을 둔다 — `start.bat`이 걸어 주고, 다른 방법으로 띄우면 직접 설정한다.

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
bge-m3 없으면 다운로드(~1.2GB) → 한국어 임베딩 호출로 1024차원이 나오는지 검증.
최초 실행은 모델 다운로드와 로드로 몇 분 걸리고, 이후에는 수 초 만에 끝난다.

중지:

```
stop.bat
```

모델 파일은 남으므로 다시 기동할 때 재다운로드하지 않는다.

## 백엔드 연결

`backend/.env`에 아래가 있어야 한다 (`.env.example` 기본값과 동일):

```
EMBEDDING_URL=http://localhost:11434/v1
EMBEDDING_MODEL=bge-m3
```

서버를 재시작할 필요는 없다. 임베딩 서버가 살아나면 다음 요청부터 벡터 검색이 켜지고,
그동안 등록된 데이터는 60초 주기 동기화가 자동으로 임베딩한다. 즉시 반영하려면
`backend`에서 `npm run embed`를 실행한다.

## 문제 해결

**포트 11434가 이미 사용 중** — Ollama 트레이 앱이 이미 실행 중일 가능성이 높다.
`start.bat`은 이 경우 기존 서버를 그대로 쓰므로 정상이다.

**차원이 1024가 아니라는 오류** — `vec_store` 테이블이 `VECTOR(1024)`로 정의되어 있어
다른 차원의 모델은 쓸 수 없다. `EMBEDDING_MODEL`을 확인한다.

**사내 프록시 환경에서 다운로드 실패** — `HTTPS_PROXY` 환경변수를 설정한 뒤 `ollama pull bge-m3`를
직접 실행한다.

**Docker를 선호하는 경우** — Ollama 설치 대신 컨테이너로도 된다:

```
docker run -d --name ollama -p 11434:11434 -v ollama:/root/.ollama ollama/ollama
```

```
docker exec ollama ollama pull bge-m3
```

이 경우 `start.bat` 없이 `docker start ollama` / `docker stop ollama`로 기동·중지한다.
