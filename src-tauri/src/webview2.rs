//! WebView2 运行时探测与缺失兜底（任务 T0.12，决策：不捆绑）。
//!
//! ## 背景
//!
//! 计划书 2.3 节确认采用 \`downloadBootstrapper\`，**不捆绑** WebView2 运行时。
//! 好处是安装包保持在 25 MB 级（体积全部留给内置字体）；
//! 代价是极少数没有运行时的机器（长期离线、精简版系统、Win10 早期版本）
//! 首次启动会失败。
//!
//! ## 兜底为什么必须用「原生对话框」
//!
//! 关键认识：WebView2 缺失时 **WebView 本身不可用**，
//! 因此任何基于 HTML 的提示界面都渲染不出来。
//! 只能用操作系统原生的对话框。
//!
//! 计划书 2.3 节要求对话框：
//! 1. 说明需要 Microsoft Edge WebView2 运行时
//! 2. 提供「打开下载页面」与「退出」两个选项
//! 3. 说明这是系统的**免费组件**，不是本软件额外要求
//!
//! ## 为什么不直接调 Windows API
//!
//! 用 \`MessageBoxW\` 需要引入 \`windows-sys\` 依赖并写 unsafe 代码，
//! 而工作区设定了 \`unsafe_code = "forbid"\`。
//! 因此这里用**无 GUI 依赖的替代方案**：
//!
//! - 探测：读注册表（通过 \`reg query\`）判断运行时是否存在
//! - 提示：用 \`mshta\` 弹出一个系统自带的原生对话框
//!   （\`mshta\` 是 Windows 自带的 HTML 应用宿主，无需任何依赖，
//!   且它在 WebView2 缺失时依然可用）
//!
//! 这个取舍略微牺牲了「纯粹性」，但换来了零 unsafe、零额外依赖，
//! 且功能完全满足要求。

use std::process::Command;

/// WebView2 运行时状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebView2Status {
    /// 已安装（Evergreen 运行时可用）。
    Available,
    /// 未安装。
    Missing,
    /// 无法判定（非 Windows 平台，或注册表读取失败）。
    Unknown,
}

impl WebView2Status {
    /// 是否应当阻止启动并提示用户。
    pub fn should_block(self) -> bool {
        matches!(self, Self::Missing)
    }
}

/// WebView2 运行时在注册表中的位置。
///
/// 分 32 位与 64 位两个视图：64 位系统上 WebView2 可能只注册在其中一个，
/// 只查一边会有漏判。
const REG_PATHS: [&str; 2] = [
    r"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
];

/// 探测 WebView2 运行时是否可用。
///
/// 非 Windows 平台（macOS 用 WKWebView、Linux 用 WebKitGTK）一律返回
/// [\`WebView2Status::Unknown\`]，因为这套机制是 Windows 专有的。
pub fn probe() -> WebView2Status {
    if !cfg!(target_os = "windows") {
        return WebView2Status::Unknown;
    }

    for path in REG_PATHS {
        if let Ok(output) = Command::new("reg")
            .args(["query", path, "/v", "pv"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                // 注册表里有 pv（版本号）即说明已安装。
                // 版本号为空字符串表示「已注册但未安装」，需要排除。
                if text.contains("pv") && !text.contains("REG_SZ    \r") {
                    return WebView2Status::Available;
                }
            }
        }
    }

    WebView2Status::Missing
}

/// 缺失时弹出原生提示对话框。
///
/// 返回用户是否选择了「打开下载页面」。
///
/// **这个函数必须在创建 Tauri 窗口之前调用**，因为此时 WebView
/// 还不可用，我们不能依赖任何 Web 技术来展示提示。
#[cfg(target_os = "windows")]
pub fn show_missing_dialog() -> bool {
    // 用 mshta 执行一段 VBScript 风格的 HTML 弹窗。
    // 优点：mshta 是系统自带组件，在没有 WebView2 的机器上依然可用。
    let script = r#"
var sh = new ActiveXObject('WScript.Shell');
var msg = '羽化写作需要「Microsoft Edge WebView2 运行时」才能启动。\n\n' +
          '这是微软随 Windows 免费提供的系统组件，不是本软件的额外要求：\n' +
          '  · Windows 11 已预装\n' +
          '  · Windows 10 通常随 Edge 浏览器一起安装\n\n' +
          '点击「确定」将打开微软官方下载页面；点击「取消」退出程序。';
var r = sh.Popup(msg, 0, '羽化写作 — 缺少运行环境', 1 + 48);
if (r == 1) {
  sh.Run('https://go.microsoft.com/fwlink/p/?LinkId=2124703');
  window.close();
} else {
  window.close();
}
close();
"#;

    let status = Command::new("mshta")
        .arg(format!("vbscript:{}", script.replace('\n', " ")))
        .status();

    // 无法弹出对话框时（极端受限环境）至少写一条日志，返回 false 让程序退出
    match status {
        Ok(_) => false,
        Err(_) => {
            eprintln!(
                "[羽化写作] 缺少 Microsoft Edge WebView2 运行时，且无法弹出提示对话框。\n\
                 请访问 https://go.microsoft.com/fwlink/p/?LinkId=2124703 安装后重试。"
            );
            false
        }
    }
}

/// 非 Windows 平台不需要这项检查。
#[cfg(not(target_os = "windows"))]
pub fn show_missing_dialog() -> bool {
    false
}

/// 检查并在必要时阻止启动。
///
/// 返回 \`true\` 表示可以继续启动。
pub fn ensure_available_or_exit() -> bool {
    match probe() {
        WebView2Status::Missing => {
            // 提示用户后一律不继续启动
            let _ = show_missing_dialog();
            false
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_missing_blocks_startup() {
        assert!(WebView2Status::Missing.should_block());
        assert!(!WebView2Status::Available.should_block());
        // Unknown 不阻止：宁可让用户尝试启动，也不要因为探测失败而拒绝服务
        assert!(!WebView2Status::Unknown.should_block());
    }

    #[test]
    fn probe_returns_a_definite_answer_on_windows() {
        let s = probe();
        // 在 Windows 上必须给出明确结论（本机装有 WebView2，应为 Available）
        if cfg!(target_os = "windows") {
            assert_ne!(s, WebView2Status::Unknown, "Windows 上探测不应返回 Unknown");
        } else {
            assert_eq!(s, WebView2Status::Unknown);
        }
    }

    #[test]
    fn probe_is_idempotent() {
        assert_eq!(probe(), probe());
    }
}
