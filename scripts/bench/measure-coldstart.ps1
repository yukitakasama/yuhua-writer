param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$SettleSec = 15,
  [int]$SampleSec = 300,
  [int]$IntervalMs = 1000
)

# 冷启动内存与空闲 CPU 采集（M1 / M1b / M4）。
# 用法（仓库根目录，Git Bash 下）：
#   /c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe `
#     -NoProfile -ExecutionPolicy Bypass -File scripts/bench/measure-coldstart.ps1 `
#     -Exe "D:\path\to\target\release\yuhua-writer.exe" -SettleSec 180 -SampleSec 300 -IntervalMs 5000
# 前置：先 `pnpm exec tauri build --no-bundle` 产出 exe。
# 脚本会在采样结束后强制关掉它启动的进程树。
# 用 PowerShell 是因为 Windows 的进程工作集与 CPU 时间只能从
# Get-Process / Get-CimInstance 拿，Git Bash 的 ps 不报这些。
#
# 两个踩过的坑，改动本文件时别退回去：
#
# 1. **本文件必须存成带 BOM 的 UTF-8。** 文件里有中文注释；Windows
#    PowerShell 5.1 读无 BOM 的文件时按系统 ANSI 代码页（本机是 GBK）解码，
#    多字节序列会吃掉相邻字符，脚本结构直接被破坏 —— 报的是
#    「无法对 Null 数组进行索引」这种看不出根因的错。pwsh 7 默认 UTF-8 故
#    看不出来，只在 5.1 上复现。
# 2. **调用 powershell.exe 时用绝对路径。** 在非登录 / 后台 shell 里，
#    `pwsh`（WindowsApps 的应用执行别名）和裸 `powershell.exe` 都可能解析不到，
#    退出码 127 且不打印任何东西 —— 看着像脚本崩了，其实是命令没跑成。
#    System32 下这个路径是真实二进制，两边都能用。

function Get-Tree([int]$RootId) {
  # 递归取整棵进程树：Tauri 主进程 -> WebView2 浏览器进程 -> 各渲染子进程
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $found = New-Object 'System.Collections.Generic.List[int]'
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  $queue.Enqueue($RootId)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    if ($found.Contains($cur)) { continue }
    $found.Add($cur)
    foreach ($c in $all) {
      if ($c.ParentProcessId -eq $cur) { $queue.Enqueue($c.ProcessId) }
    }
  }
  return $found
}

$proc = Start-Process -FilePath $Exe -PassThru
Write-Output "PID=$($proc.Id)"
Start-Sleep -Seconds $SettleSec

if ($null -eq (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
  Write-Output "APP_EXITED_EARLY"
  exit 1
}

$treeIds = Get-Tree $proc.Id
Write-Output "TREE_PIDS=$($treeIds -join ',')"
Write-Output ("TREE_NAMES=" + (($treeIds | ForEach-Object {
        (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName
      }) -join ','))

$mb = 1MB
$samples = @()
$peakTreeWS = 0.0
$peakTreePriv = 0.0
$peakMainWS = 0.0
# M4 归因：整棵树的 CPU 增量只说明「有没有泄漏」，不说明「是谁在耗」。
# WebView2 的子进程角色（browser / gpu-process / renderer / utility）只能逐个看
# 才有意义 —— 上次就是靠这个发现 37% 的单核占用全在 gpu-process 上。
$cpuStart = @{}
$cpuDeltaByPid = @{}
# 采样窗口的长度必须是**真实流逝时间**。每轮采样本身要花 1～几秒
# （枚举全机进程树找父进程），把 `-IntervalMs` 累加起来当分母会系统性
# 高估 M4 —— 分母被压短，同样的 CPU 增量算出几倍的百分比。
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $SampleSec) {
  $elapsed = $sw.Elapsed.TotalSeconds
  $treeWS = 0.0
  $treePriv = 0.0
  $mainWS = 0.0
  $treeCpu = 0.0
  foreach ($id in (Get-Tree $proc.Id)) {
    $q = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -eq $q) { continue }
    $treeWS += $q.WorkingSet64
    $treePriv += $q.PrivateMemorySize64
    $treeCpu += $q.CPU
    if ($null -eq $cpuStart[$id]) {
      $cpuStart[$id] = $q.CPU
      $cpuDeltaByPid[$id] = [pscustomobject]@{ Name = $q.ProcessName; Cpu = 0.0 }
    }
    $cpuDeltaByPid[$id].Cpu = $q.CPU - $cpuStart[$id]
    if ($q.Id -eq $proc.Id) { $mainWS = $q.WorkingSet64 }
  }
  if ($treeWS -eq 0) { Write-Output ("APP_EXITED_AT={0:N0}s" -f $elapsed); break }
  if ($treeWS / $mb -gt $peakTreeWS) { $peakTreeWS = $treeWS / $mb }
  if ($treePriv / $mb -gt $peakTreePriv) { $peakTreePriv = $treePriv / $mb }
  if ($mainWS / $mb -gt $peakMainWS) { $peakMainWS = $mainWS / $mb }
  $samples += , @($elapsed, ($mainWS / $mb), ($treeWS / $mb), ($treePriv / $mb), $treeCpu)
  Start-Sleep -Milliseconds $IntervalMs
}

if ($samples.Count -eq 0) { Write-Output "NO_SAMPLES"; exit 1 }

$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
# M4 必须是**采样窗口内的 CPU 增量**：进程 CPU 时间是自启动累计的，
# 直接把终值除以窗口长度会把启动风暴算进「空闲 CPU」，数字必然虚高。
$cpuDelta = $samples[-1][4] - $samples[0][4]

# 「冷启动后稳定态」取采样窗口最后 60 秒的平均，比首末单点稳
$from = $elapsed - 60
$tail = @($samples | Where-Object { $_[0] -ge $from })
if ($tail.Count -eq 0) { $tail = $samples }

function AvgAt($rows, [int]$col) {
  if ($rows.Count -eq 0) { return 0.0 }
  return (($rows | ForEach-Object { $_[$col] } | Measure-Object -Average).Average)
}

$spanSec = $samples[-1][0] - $samples[0][0]
if ($spanSec -le 0) { $spanSec = $elapsed }

Write-Output ("SETTLE_SEC={0}" -f $SettleSec)
Write-Output ("SAMPLE_SPAN_SEC={0:N1}" -f $spanSec)
Write-Output ("CORES={0}" -f $cores)
Write-Output ("M1b_main_first_mb={0:N2}" -f $samples[0][1])
Write-Output ("M1b_main_avg_tail_mb={0:N2}" -f (AvgAt $tail 1))
Write-Output ("M1b_main_peak_mb={0:N2}" -f $peakMainWS)
Write-Output ("M1_tree_ws_first_mb={0:N2}" -f $samples[0][2])
Write-Output ("M1_tree_ws_avg_tail_mb={0:N2}" -f (AvgAt $tail 2))
Write-Output ("M1_tree_ws_peak_mb={0:N2}" -f $peakTreeWS)
Write-Output ("M1_tree_private_avg_tail_mb={0:N2}" -f (AvgAt $tail 3))
Write-Output ("M1_tree_private_peak_mb={0:N2}" -f $peakTreePriv)
Write-Output ("M4_tree_cpu_delta_seconds={0:N2}" -f $cpuDelta)
Write-Output ("M4_tree_pct_of_one_core={0:N3}" -f (($cpuDelta / $spanSec) * 100.0))
Write-Output ("M4_tree_pct_of_machine={0:N3}" -f (($cpuDelta / ($spanSec * $cores)) * 100.0))
Write-Output "M4_PER_PROCESS pid|name|cpu_delta_s|pct_of_one_core"
foreach ($id in $cpuDeltaByPid.Keys | Sort-Object { - $cpuDeltaByPid[$_].Cpu }) {
  $delta = $cpuDeltaByPid[$id].Cpu
  Write-Output ("{0} {1} {2:N2} {3:N3}" -f $id, $cpuDeltaByPid[$id].Name, $delta, (($delta / $spanSec) * 100.0))
}
Write-Output "TREND elapsed|main_ws|tree_ws|tree_private|tree_cpu_s"
# 连同累计 CPU 一起打印：任意子窗口的空闲 CPU 都能事后由这份趋势算出来，
# 不必为了换一个窗口长度再跑一次 5 分钟。
$lastPrinted = -30.0
foreach ($s in $samples) {
  if (($s[0] - $lastPrinted) -ge 30 -or $s -eq $samples[-1]) {
    $lastPrinted = $s[0]
    Write-Output ("{0:N0}s {1:N2} {2:N2} {3:N2} {4:N2}" -f $s[0], $s[1], $s[2], $s[3], $s[4])
  }
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
foreach ($id in (Get-Tree $proc.Id)) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
Write-Output "CLOSED"
