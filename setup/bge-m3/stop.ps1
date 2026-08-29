# bge-m3 임베딩 서버 중지 (Windows)
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
Write-Host "    중지 상태에서도 시스템은 LIKE 검색만으로 정상 동작합니다."
