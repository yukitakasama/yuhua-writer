param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Runs = 3,
  [int]$TimeoutSec = 40
)

# P3 代理指标：进程启动 → 主窗口句柄出现。
# 用法：pwsh -File scripts/bench/measure-startup.ps1 -Exe target/release/yuhua-writer.exe -Runs 4
# 「可输入」还需要页面加载完 + CodeMirror 挂载，这一段本脚本测不到，
# 必须在应用内埋点（见 docs/benchmarks.md 的说明）。
# 脚本会在每次测量后强制关掉它启动的那个进程。

$mb = 1MB
$results = @()
for ($i = 1; $i -le $Runs; $i++) {
  $t0 = Get-Date
  $p = Start-Process -FilePath $Exe -PassThru
  $shown = $null
  $deadline = $t0.AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 25
    $q = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
    if ($null -eq $q) { break }
    if ($q.MainWindowHandle -ne 0) { $shown = Get-Date; break }
  }
  if ($null -ne $shown) {
    $ms = ($shown - $t0).TotalMilliseconds
    $results += $ms
    Write-Output ("RUN{0}_WINDOW_MS={1:N0}" -f $i, $ms)
  } else {
    Write-Output ("RUN{0}_WINDOW=TIMEOUT_OR_NO_WINDOW" -f $i)
  }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
}
if ($results.Count -gt 0) {
  $sorted = $results | Sort-Object
  Write-Output ("MEDIAN_WINDOW_MS={0:N0}" -f $sorted[[int]($sorted.Count / 2)])
}
