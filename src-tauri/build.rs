//! Tauri 构建脚本。
//!
//! tauri-build 会读取 tauri.conf.json 生成必要的资源与权限清单。
fn main() {
    tauri_build::build()
}
