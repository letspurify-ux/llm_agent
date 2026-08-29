# bge-m3 임베딩 서버 기동 (Windows)
# 사용: start.bat  (또는 powershell -File start.ps1)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Url   = 'http://localhost:11434'
$Model = 'bge-m3'

function Test-Server {
    try { Invoke-RestMethod "$Url/api/tags" -TimeoutSec 3 | Out-Null; $true } catch { $false }
}

# 1) Ollama 설치 확인
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "[X] Ollama가 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host "    winget install Ollama.Ollama"
    Write-Host "    또는 https://ollama.com/download 에서 설치 후 다시 실행하세요."
    exit 1
}

# 2) 서버 기동 (Windows는 설치 시 트레이 앱이 이미 떠 있는 경우가 많다)
if (Test-Server) {
    Write-Host "[O] Ollama 서버 이미 실행 중"
} else {
    Write-Host "[.] Ollama 서버 시작..."
    Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
    $up = $false
    foreach ($i in 1..30) { Start-Sleep -Seconds 1; if (Test-Server) { $up = $true; break } }
    if (-not $up) {
        Write-Host "[X] 서버가 30초 내에 뜨지 않았습니다. 포트 11434 사용 여부를 확인하세요." -ForegroundColor Red
        exit 1
    }
    Write-Host "[O] Ollama 서버 시작됨"
}

# 3) 모델 준비 (없을 때만 다운로드)
if (((ollama list) -join "`n") -notmatch [regex]::Escape($Model)) {
    Write-Host "[.] $Model 다운로드 중 (~1.2GB, 네트워크에 따라 수 분)..."
    ollama pull $Model
    if ($LASTEXITCODE -ne 0) { Write-Host "[X] 모델 다운로드 실패" -ForegroundColor Red; exit 1 }
}
Write-Host "[O] $Model 준비됨"

# 4) 한국어 임베딩 검증 (최초 호출은 모델 로드로 ~30초 소요)
Write-Host "[.] 임베딩 검증 중 (최초 호출은 모델 로드로 30초 정도 걸립니다)..."
try {
    $json  = @{ model = $Model; input = '가상계측 임베딩 검증' } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)   # 한글 본문은 UTF-8 바이트로 전송
    $res   = Invoke-RestMethod "$Url/v1/embeddings" -Method Post -ContentType 'application/json' -Body $bytes -TimeoutSec 180
    $dim   = $res.data[0].embedding.Count
    if ($dim -ne 1024) {
        Write-Host "[X] 차원이 $dim 입니다. vec_store는 VECTOR(1024) 기준이므로 모델을 확인하세요." -ForegroundColor Red
        exit 1
    }
    Write-Host "[O] 임베딩 정상 ($dim 차원)" -ForegroundColor Green
} catch {
    Write-Host "[X] 임베딩 호출 실패: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "준비 완료. backend/.env 에 아래가 설정되어 있어야 합니다:" -ForegroundColor Cyan
Write-Host "  EMBEDDING_URL=$Url/v1"
Write-Host "  EMBEDDING_MODEL=$Model"
Write-Host "중지하려면 stop.bat 를 실행하세요."
