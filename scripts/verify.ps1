# New AI 一键回归脚本
# 用法: pwsh -File scripts/verify.ps1
# 注意: 不设 $ErrorActionPreference='Stop'，避免 cargo/node 的 stderr 进度输出被误判为错误
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$app = Join-Path $root 'packages\app'
$srcTauri = Join-Path $app 'src-tauri'

Write-Host '==> 停止可能锁文件的运行实例' -ForegroundColor DarkGray
Get-Process new-ai -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2

Write-Host ''
Write-Host '=== [1/4] Rust cargo test ===' -ForegroundColor Cyan
Push-Location $srcTauri
cargo test --release -- --test-threads=1 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'cargo test failed'; exit 1 }
Pop-Location

Write-Host ''
Write-Host '=== [2/4] 前端纯函数测试 test-level-a ===' -ForegroundColor Cyan
$esbuild = Get-ChildItem -Path (Join-Path $root 'node_modules\.pnpm') -Recurse -Filter 'esbuild.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'win32-x64' } |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $esbuild) { Write-Error 'esbuild.exe not found'; exit 1 }
$esbuildPath = $esbuild.FullName
Push-Location $app
& $esbuildPath test-level-a.ts --bundle --format=esm --platform=node --external:@tauri-apps/api/core --outfile=test-level-a.mjs 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'esbuild test-level-a failed'; exit 1 }
node test-level-a.mjs 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'test-level-a failed'; exit 1 }

Write-Host ''
Write-Host '=== [3/4] store 运行时测试 ===' -ForegroundColor Cyan
& $esbuildPath store-test.ts --bundle --format=esm --platform=node --alias:@tauri-apps/api/core=./mock-tauri.ts --outfile=store-test.mjs 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'esbuild store-test failed'; exit 1 }
node store-test.mjs 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'store-test failed'; exit 1 }
Remove-Item test-level-a.mjs, store-test.mjs -ErrorAction SilentlyContinue
Pop-Location

Write-Host ''
Write-Host '=== [4/4] vue-tsc 类型检查 ===' -ForegroundColor Cyan
Push-Location $app
& (Join-Path $app 'node_modules\.bin\vue-tsc.CMD') --noEmit 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'vue-tsc failed'; exit 1 }
Pop-Location

Write-Host ''
Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green
