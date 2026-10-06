param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$AppArgs = "",
  [int]$IntervalMs = 50,
  [string]$OutFile = ""
)

# 单进程导出负载的峰值内存采样（M7 / P8 / P9 / P10 配套）。
# 用法（仓库根目录，先 `cargo build --release -p yuhua-export --example export_peak`）：
#   pwsh -File scripts/bench/measure-peak.ps1 -Exe target/release/examples/export_peak.exe `
#     -AppArgs m7 -IntervalMs 20
# AppArgs 取 p8（30 万字/100 章）或 m7（100 万字/300 章），分开跑才能分别拿到峰值。
# WorkingSet 是**轮询到的最大值**，不是 OS 记录的真实历史峰值：
# 采样间隔决定分辨率，因此报告里必须连同间隔一起写出来。

$mb = 1MB
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($OutFile -eq "") { $OutFile = Join-Path $env:TEMP "export_peak_stdout.txt" }
$p = Start-Process -FilePath $Exe -ArgumentList $AppArgs -PassThru -RedirectStandardOutput $OutFile -NoNewWindow

$peakWS = 0.0
$peakPriv = 0.0
$samples = 0
while (-not $p.HasExited) {
  Start-Sleep -Milliseconds $IntervalMs
  $q = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  if ($null -eq $q) { continue }
  $samples++
  $ws = $q.WorkingSet64 / $mb
  $priv = $q.PrivateMemorySize64 / $mb
  if ($ws -gt $peakWS) { $peakWS = $ws }
  if ($priv -gt $peakPriv) { $peakPriv = $priv }
}
$sw.Stop()
$p.WaitForExit()

Write-Output ("EXE={0}" -f $Exe)
Write-Output ("WALL_SEC={0:N2}" -f ($sw.Elapsed.TotalSeconds))
Write-Output ("SAMPLES={0}" -f $samples)
Write-Output ("INTERVAL_MS={0}" -f $IntervalMs)
Write-Output ("PEAK_WORKING_SET_MB={0:N2}" -f $peakWS)
Write-Output ("PEAK_PRIVATE_MB={0:N2}" -f $peakPriv)
Write-Output ("EXIT_CODE={0}" -f $p.ExitCode)
Write-Output "---- 被测程序输出 ----"
Get-Content $OutFile | ForEach-Object { Write-Output $_ }
