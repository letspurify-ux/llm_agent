# 로컬 개발 스택 전체 중지 (Windows) — stop_all.sh의 Windows판, start_all.bat의 역순.
# 사용: stop_all.bat [--apps-only]
#
# 앱을 먼저 내리는 이유: 관리 DB를 먼저 내리면 그 사이 백엔드의 주기 작업(임베딩 동기화·chat_log 정리)과
# 진행 중인 질문이 접속 실패로 끝난다. (Windows의 stop.bat은 강제 종료라 stop.sh처럼 백엔드가 풀을
# 정리하고 나갈 틈은 없다 — backend\stop.bat 참고.)
#
# 앱은 각 디렉터리의 stop.bat을 부른다 — 창 제목 판정이 그쪽에 있고, 여기서 다시 taskkill을 짜면
# 그 판정이 두 벌이 되어 한쪽만 고쳐질 때 엉뚱한 창을 죽인다.
#
# 환경 변수: MARIADB_SERVICE(서비스 이름 — 없으면 'MariaDB*'로 찾는다), ORACLE_CONTAINER(oracle1521).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = $PSScriptRoot

$AppsOnly = $false
foreach ($arg in $args) {
    if (@('-a', '--apps-only') -contains $arg) { $AppsOnly = $true }
    elseif (@('-h', '--help', '/?') -contains $arg) {
        Write-Host '사용법: stop_all.bat [--apps-only]'
        Write-Host '  (기본)         백엔드·프론트엔드를 내린 뒤 MariaDB·Oracle·Ollama도 내린다'
        Write-Host '  --apps-only    인프라는 그대로 두고 백엔드·프론트엔드만 내린다'
        exit 0
    }
    else { Write-Host "알 수 없는 인자: $arg (--help 참고)"; exit 2 }
}

$OracleContainer = if ($env:ORACLE_CONTAINER) { $env:ORACLE_CONTAINER } else { 'oracle1521' }

function ok($m)   { Write-Host "  [O] $m" }
function skip($m) { Write-Host "  [-] $m" }
function warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

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
# 탐색기에서 두 번 눌러 실행했으면 끝나자마자 창이 닫혀 결과를 읽을 수 없다 — 그때만 멈춘다.
# 판정은 start_all.ps1과 같다.
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

Write-Host '== 앱 =='
& (Join-Path $Root 'frontend\stop.bat')
& (Join-Path $Root 'backend\stop.bat')

if ($AppsOnly) {
    Write-Host ''
    Write-Host '인프라는 그대로 두었다 (--apps-only).'
    Wait-IfDoubleClicked 'stop_all.bat'
    exit 0
}

Write-Host ''
Write-Host '== 인프라 =='
# 인프라는 이 저장소만 쓰는 것이 아닐 수 있다 — 다른 프로젝트가 같은 MariaDB나 Ollama를
# 쓰고 있으면 여기서 내리는 것이 뜻밖의 결과가 된다. 그래서 무엇을 내리는지 한 줄씩 밝히고,
# 앱만 내리고 싶을 때를 위해 --apps-only를 둔다.

$svc = Find-MariaDbService
if (-not $svc) {
    skip 'MariaDB 서비스 없음'
} elseif ($svc.Status -eq 'Stopped') {
    skip 'MariaDB 실행 중이 아님'
} elseif (Invoke-NetService stop $svc.Name) {
    ok "MariaDB 정지 ($($svc.Name))"
} else {
    warn "MariaDB 정지 실패 — 관리자 권한으로 다시 실행하거나 services.msc에서 '$($svc.Name)'을 중지할 것"
}

# 엔진이 꺼져 있으면 docker ps가 실패하고, 그때는 컨테이너도 떠 있을 수 없다.
$running = if (have docker) { & docker ps --format '{{.Names}}' 2> $null } else { @() }
if (@($running) -contains $OracleContainer) {
    # stop은 SIGTERM 뒤 유예를 준다 — 컨테이너 안에서 인스턴스가 정상 종료(shutdown immediate)할
    # 시간을 주지 않으면 다음 기동이 인스턴스 복구부터 시작해 훨씬 오래 걸린다.
    & docker stop $OracleContainer *> $null
    if ($LASTEXITCODE -eq 0) { ok "Oracle 정지 ($OracleContainer)" } else { skip 'Oracle 정지 실패' }
} else {
    skip 'Oracle 실행 중이 아님'
}

# Windows의 Ollama는 서비스가 아니라 트레이 앱('ollama app')이 띄운 서버이거나 start_all.bat이 띄운
# 'ollama serve'다 — 내릴 서비스 관리자가 없으므로 setup\qwen3-embedding\stop.ps1처럼 프로세스를 끝낸다.
# 트레이 앱을 먼저 끝낸다: 서버만 끝내면 트레이 앱이 곧바로 다시 띄운다. (Get-Process는 이름순으로
# 돌려주므로 순서를 따로 잡는다.) 서버가 끝나면서 함께 사라지는 모델 실행 프로세스도 있어, 하나하나의
# 종료 결과 대신 끝난 뒤에 남은 것이 있는지로 판정한다.
$names = 'ollama app', 'ollama', 'ollama_llama_server'
$ollama = @(Get-Process $names[0] -ErrorAction SilentlyContinue) + @(Get-Process $names[1..2] -ErrorAction SilentlyContinue)
if ($ollama.Count -eq 0) {
    skip 'Ollama 실행 중이 아님'
} else {
    $ollama | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    if (Get-Process $names -ErrorAction SilentlyContinue) { warn 'Ollama 정지 실패 — 작업 관리자에서 ollama 프로세스를 끝낼 것' }
    else { ok 'Ollama 정지 (모델 파일은 남아 있어 다시 받지 않는다)' }
}

Wait-IfDoubleClicked 'stop_all.bat'
