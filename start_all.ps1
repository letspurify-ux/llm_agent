# 로컬 개발 스택 전체 기동 (Windows) — start_all.sh의 Windows판: 인프라 3종 + 백엔드/프론트엔드.
# 사용: start_all.bat [--apps-only]
#
# 앱은 각 디렉터리의 start.bat을 부른다. 여기서 'start' 창과 창 제목 판정을 다시 쓰지 않는 이유:
# 그 사본이 생기는 순간 "떠 있는지 어떻게 판정하는가"가 두 벌이 되고, 한쪽만 고치면
# start_all로 띄운 프로세스를 stop.bat이 못 잡거나 그 반대가 된다.
#
# 인프라는 Windows에서 흔한 설치 방식을 전제한다 — MariaDB는 MSI가 등록한 Windows 서비스,
# Oracle은 Docker Desktop의 컨테이너, Ollama는 PATH의 ollama. 다르게 설치했으면 건너뛰고
# 알린다. 없다고 실패시키지 않는 이유는 start_all.sh와 같다:
#   Oracle 없음  → 설정의 Oracle mock을 켜면 데모 데이터로 동작
#   Ollama 없음  → 검색이 통째로 성립하지 않는다. 서버는 뜨고 답변도 나가지만 지식·처리방법·쿼리를
#                  하나도 찾지 못하고, 그 사실이 화면과 chat_log에 '검색 불가'로 남는다
#   MariaDB 없음 → 이건 진짜로 못 뜬다. 유일하게 필수라 아래에서 따로 다룬다.
#
# 환경 변수: MARIADB_SERVICE(서비스 이름 — 없으면 'MariaDB*'로 찾는다), ORACLE_CONTAINER(oracle1521),
# ORACLE_WAIT_S(180).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = $PSScriptRoot

$AppsOnly = $false
foreach ($arg in $args) {
    if (@('-a', '--apps-only') -contains $arg) { $AppsOnly = $true }
    elseif (@('-h', '--help', '/?') -contains $arg) {
        Write-Host '사용법: start_all.bat [--apps-only]'
        Write-Host '  (기본)         MariaDB·Oracle·Ollama를 기동한 뒤 백엔드·프론트엔드를 띄운다'
        Write-Host '  --apps-only    인프라는 건드리지 않고 백엔드·프론트엔드만 띄운다'
        exit 0
    }
    else { Write-Host "알 수 없는 인자: $arg (--help 참고)"; exit 2 }
}

$OracleContainer = if ($env:ORACLE_CONTAINER) { $env:ORACLE_CONTAINER } else { 'oracle1521' }
# Oracle은 컨테이너 안에서 인스턴스가 열릴 때까지 시간이 걸린다(콜드 스타트 1분 내외).
$OracleWaitS = if ($env:ORACLE_WAIT_S) { [int]$env:ORACLE_WAIT_S } else { 180 }
$OllamaUrl = 'http://localhost:11434'

function ok($m)   { Write-Host "  [O] $m" }
function skip($m) { Write-Host "  [-] $m" }
function warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# 설정값은 백엔드가 읽는 곳에서 읽는다 — backend\config.toml이 있으면 그것만, 없으면(첫 기동 전)
# 백엔드가 그때 가져올 프로세스 환경 > backend\.env (backend/src/config.rs import_env).
# 설정 화면에서 임베딩 모델을 바꾼 설치에서 옛 이름을 보고 "준비됨"이라 알리면, 새 모델 없이 모든
# 검색이 '검색 불가'가 되는데 이 스크립트는 성공을 보고한다.
$ConfigPath = Join-Path $Root 'backend\config.toml'
$DotEnvPath = Join-Path $Root 'backend\.env'
function Get-ConfigValue($section, $key) {
    $inside = $false
    foreach ($line in Get-Content -LiteralPath $ConfigPath -Encoding UTF8) {
        if ($line -match '^\[') { $inside = ($line.Trim() -eq "[$section]"); continue }
        if ($inside -and $line -match "^\s*$key\s*=\s*(.*?)\s*$") { return ($Matches[1] -replace '^["'']|["'']$', '') }
    }
}
function Get-DotEnvValue($key) {
    if (-not (Test-Path -LiteralPath $DotEnvPath)) { return }
    $value = $null
    foreach ($line in Get-Content -LiteralPath $DotEnvPath -Encoding UTF8) {
        if ($line -match "^$key=(.*)$") { $value = $Matches[1] -replace '"', '' }
    }
    $value
}
function Get-Setting($section, $key, $envKey, $default) {
    if (Test-Path -LiteralPath $ConfigPath) {
        $value = Get-ConfigValue $section $key
    } else {
        $value = [Environment]::GetEnvironmentVariable($envKey)
        if (-not $value) { $value = Get-DotEnvValue $envKey }
    }
    if ($value) { $value } else { $default }
}
$EmbeddingModel = Get-Setting 'embedding' 'model' 'EMBEDDING_MODEL' 'qwen3-embedding:0.6b'
$DbHost = Get-Setting 'mariadb' 'host' 'MARIADB_HOST' 'localhost'
$DbPort = [int](Get-Setting 'mariadb' 'port' 'MARIADB_PORT' 3306)

# 관리 DB가 접속을 받는지는 포트로 본다 — mysqladmin은 MSI 설치에서 PATH에 없는 경우가 많다.
function Test-Port($hostName, $port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.ConnectAsync($hostName, $port).Wait(1000) } catch { $false } finally { $client.Close() }
}
function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}
# 서비스 시작·중지는 관리자 권한이 필요하다 — 일반 창에서 실행했으면 이 한 명령만 UAC 확인을 거쳐
# 올린다. net은 서비스가 그 상태에 이를 때까지 기다린다(sc.exe는 요청만 남기고 바로 돌아온다).
function Invoke-NetService($verb, $name) {
    try {
        if (Test-Admin) { & net.exe $verb $name *> $null; return ($LASTEXITCODE -eq 0) }
        $p = Start-Process net.exe -ArgumentList $verb, "`"$name`"" -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
        $p.ExitCode -eq 0
    } catch { $false }   # UAC에서 '아니요'
}
function Find-MariaDbService {
    if ($env:MARIADB_SERVICE) { Get-Service -Name $env:MARIADB_SERVICE -ErrorAction SilentlyContinue }
    else { Get-Service -Name 'MariaDB*' -ErrorAction SilentlyContinue | Select-Object -First 1 }
}
function Test-DockerEngine { & docker version --format '{{.Server.Version}}' *> $null; $LASTEXITCODE -eq 0 }
function Test-Ollama {
    try { Invoke-RestMethod "$OllamaUrl/api/tags" -TimeoutSec 3 | Out-Null; $true } catch { $false }
}
# 이름을 태그까지 대조한다 — 태그 없는 이름은 Ollama가 ':latest'로 읽는다. 앞부분만 보면 다른 태그가
# 깔려 있어도 '준비됨'이 되는데, 백엔드가 청하는 바로 그 모델이 없으니 검색이 성립하지 않는다.
function Test-OllamaModel($name) {
    $want = if ($name -match ':') { $name } else { "${name}:latest" }
    try { $tags = Invoke-RestMethod "$OllamaUrl/api/tags" -TimeoutSec 5 } catch { return $false }
    [bool]($tags.models | Where-Object { $_.name -eq $want })
}
# 탐색기에서 두 번 눌러 실행했으면 끝나자마자 창이 닫혀 위의 [!] 줄을 읽을 수 없다 — 그때만 멈춘다.
# 판정: 이 PowerShell을 부른 cmd의 명령줄에 이 .bat이 있고 그 cmd를 탐색기가 띄웠다. (Win+R로 연 cmd
# 창도 부모가 탐색기지만 명령줄에 이 파일이 없고, PowerShell 창에서 실행하면 부모가 PowerShell이다.)
function Wait-IfDoubleClicked($batName) {
    try {
        $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
        $cmd = Get-CimInstance Win32_Process -Filter "ProcessId=$($self.ParentProcessId)"
        $shell = Get-CimInstance Win32_Process -Filter "ProcessId=$($cmd.ParentProcessId)"
        if ($cmd.CommandLine -like "*$batName*" -and $shell.Name -eq 'explorer.exe') {
            Read-Host 'Enter를 누르면 창을 닫는다' | Out-Null
        }
    } catch { }
}

# ===== 인프라 =====
if (-not $AppsOnly) {
    Write-Host '== 인프라 =='

    # --- MariaDB (관리 DB) — 유일한 필수 구성요소 ---
    $svc = Find-MariaDbService
    if (Test-Port $DbHost $DbPort) {
        ok "MariaDB 이미 실행 중 (${DbHost}:$DbPort)"
    } elseif (@('localhost', '127.0.0.1', '::1') -notcontains $DbHost) {
        warn "관리 DB(${DbHost}:$DbPort)가 응답하지 않는다 — 다른 PC의 MariaDB라 여기서 기동하지 않는다. 관리 DB 없이는 모든 질문이 실패한다."
    } elseif (-not $svc) {
        warn "MariaDB 서비스를 찾지 못했다 — 직접 기동하거나 MARIADB_SERVICE에 서비스 이름을 넣을 것. 관리 DB 없이는 모든 질문이 실패한다."
    } else {
        $started = ($svc.Status -ne 'Stopped') -or (Invoke-NetService start $svc.Name)
        if (-not $started) {
            warn "MariaDB 서비스($($svc.Name))를 시작하지 못했다 — 관리자 권한으로 다시 실행하거나 services.msc에서 시작할 것. 관리 DB 없이는 모든 질문이 실패한다."
        } else {
            # 서비스가 'Running'이 된 직후에도 포트는 아직 안 열려 있을 수 있다. 여기서 기다리지 않고 백엔드를
            # 띄우면 기동 시 임베딩 동기화와 chat_log 정리가 접속 실패로 죽고, /api/health는 계속 ok를 돌려줘
            # 원인이 보이지 않는다.
            foreach ($i in 1..30) { if (Test-Port $DbHost $DbPort) { break }; Start-Sleep -Seconds 1 }
            if (Test-Port $DbHost $DbPort) { ok "MariaDB 기동 ($($svc.Name))" }
            else { warn "MariaDB가 30초 내에 ${DbHost}:$DbPort 에서 응답하지 않는다 — services.msc의 '$($svc.Name)' 상태와 설정 탭의 관리 DB 포트를 확인할 것" }
        }
    }

    # --- Oracle (조회 DB, 선택) ---
    if (-not (have docker)) {
        skip 'Oracle 건너뜀 (docker 없음) — 설정의 Oracle mock을 켜면 데모 데이터로 동작'
    } elseif (-not (Test-DockerEngine)) {
        # Docker Desktop을 대신 띄우지 않는다 — Oracle을 컨테이너로 쓰지 않는 PC에서도 매번 무거운
        # 엔진을 올리고 기다리게 된다. 엔진이 꺼진 것을 '컨테이너 없음'으로 잘못 알리지만 않는다.
        skip 'Oracle 건너뜀 (Docker 엔진이 꺼져 있다) — 컨테이너를 쓰려면 Docker Desktop을 띄운 뒤 다시 실행할 것'
    } else {
        & docker inspect $OracleContainer *> $null
        if ($LASTEXITCODE -ne 0) {
            skip "Oracle 건너뜀 ('$OracleContainer' 컨테이너 없음) — README '조회용 Oracle 테스트 DB' 참고"
        } else {
            & docker start $OracleContainer *> $null
            # 준비 판정에 'docker logs | findstr READY'를 쓰지 않는다. 로그는 재기동을 넘어 쌓이므로
            # 지난 실행이 남긴 READY 한 줄에 곧바로 걸려, 아직 열리지 않은 DB를 '준비됨'으로 읽는다.
            # 이미지가 싣고 있는 healthcheck.sh는 실제로 인스턴스에 붙어보므로 그 착각이 없다.
            Write-Host -NoNewline '  [.] Oracle 준비 대기'
            $ready = $false
            $tries = [math]::Max(1, [math]::Floor($OracleWaitS / 3))
            foreach ($i in 1..$tries) {
                & docker exec $OracleContainer healthcheck.sh *> $null
                if ($LASTEXITCODE -eq 0) { $ready = $true; break }
                Write-Host -NoNewline '.'
                Start-Sleep -Seconds 3
            }
            Write-Host ''
            if ($ready) { ok "Oracle 준비 완료 ($OracleContainer)" }
            else { warn "Oracle이 ${OracleWaitS}초 내에 준비되지 않았다 — 'docker logs $OracleContainer' 확인" }
        }
    }

    # --- Ollama (임베딩) — 검색의 유일한 경로다 ---
    if (-not (have ollama)) {
        warn 'Ollama 미설치 — 검색이 성립하지 않는다. 지식·처리방법·쿼리를 하나도 찾지 못한다 (winget install Ollama.Ollama, setup\qwen3-embedding\README.md)'
    } elseif (Test-Ollama) {
        ok 'Ollama 이미 실행 중'
    } else {
        # 보통은 설치 때 깔린 트레이 앱이 로그인과 함께 서버를 띄운다. 그 앱을 꺼 두었거나 stop_all.bat으로
        # 내린 뒤라면 setup\qwen3-embedding\start.ps1처럼 서버만 숨김 창으로 띄운다(이 창을 닫아도 남는다).
        Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
        foreach ($i in 1..30) { if (Test-Ollama) { break }; Start-Sleep -Seconds 1 }
        if (Test-Ollama) { ok 'Ollama 기동' }
        else { warn 'Ollama가 30초 내에 응답하지 않는다 — 그동안의 질문은 검색 없이 답한다' }
    }

    # 모델이 없으면 임베딩 호출이 매번 실패하고, 그것은 곧 검색이 없다는 뜻이다(벡터 단일 경로).
    # 답변은 나가지만 등록된 자료를 하나도 못 찾는다. 있는지만 보고, 없으면 받는다(최초 1회).
    if ((have ollama) -and (Test-Ollama)) {
        if (Test-OllamaModel $EmbeddingModel) {
            ok "임베딩 모델 $EmbeddingModel 준비됨"
        } else {
            Write-Host "  [.] $EmbeddingModel 내려받는 중 (최초 1회, 수 분 걸릴 수 있다)..."
            & ollama pull $EmbeddingModel *> $null
            if ($LASTEXITCODE -eq 0) { ok "$EmbeddingModel 준비됨" }
            else { warn "$EmbeddingModel 다운로드 실패 — 이 모델 없이는 검색이 성립하지 않는다" }
        }
    }
    Write-Host ''
}

# ===== 앱 =====
# 인프라보다 나중에 띄운다. 백엔드는 기동 시점에 관리 DB로 임베딩 동기화와 chat_log 정리를
# 시작하므로, MariaDB보다 먼저 뜨면 그 두 작업이 접속 실패로 죽는다.
Write-Host '== 앱 =='
& (Join-Path $Root 'backend\start.bat')
if ($LASTEXITCODE -ne 0) { warn '백엔드를 띄우지 못했다 — 위 출력 참고' }
& (Join-Path $Root 'frontend\start.bat')
if ($LASTEXITCODE -ne 0) { warn '프론트엔드를 띄우지 못했다 — 위 출력 참고' }

Write-Host ''
Write-Host '로그: backend\logs\backend.log · frontend\logs\frontend.log'
Write-Host '중지: stop_all.bat'
Wait-IfDoubleClicked 'start_all.bat'
