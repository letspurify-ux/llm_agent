# qwen3-embedding 임베딩 서버 중지 (Windows)
# 사용: stop.bat
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$procs = Get-Process ollama, 'ollama app' -ErrorAction SilentlyContinue
if (-not $procs) {
    Write-Host "[O] 이미 중지되어 있습니다."
    exit 0
}
$procs | Stop-Process -Force
Start-Sleep -Seconds 1
Write-Host "[O] Ollama 중지됨 (모델 파일은 보존되므로 재다운로드 불필요)"
Write-Host "    검색은 벡터 단일 경로라, 중지한 동안에는 지식·처리방법·쿼리를 하나도 찾지 못하고" -ForegroundColor Yellow
Write-Host "    화면과 chat_log에 '검색 불가'로 남습니다." -ForegroundColor Yellow
