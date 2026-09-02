# New AI 一键回归脚本
# 用法: pwsh -File scripts/verify.ps1
# 注意: 不设 $ErrorActionPreference='Stop'，避免 cargo/node 的 stderr 进度输出被误判为错误
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$app = Join-Path $root 'packages\app'

Write-Host '==> 停止可能锁文件的运行实例' -ForegroundColor DarkGray
Get-Process new-ai -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2

Write-Host ''
Write-Host '=== [1/3] Rust cargo test ===' -ForegroundColor Cyan
Push-Location (Join-Path $app 'src-tauri')
cargo test --release -- --test-threads=1 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'cargo test failed'; exit 1 }
Pop-Location

Write-Host ''
Write-Host '=== [2/3] 前端 Vitest ===' -ForegroundColor Cyan
Push-Location $app
pnpm test 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'vitest failed'; exit 1 }
Pop-Location

Write-Host ''
Write-Host '=== [3/3] vue-tsc 类型检查 ===' -ForegroundColor Cyan
Push-Location $app
pnpm exec vue-tsc --noEmit 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'vue-tsc failed'; exit 1 }
Pop-Location

Write-Host ''
Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green
