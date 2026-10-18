// Debug 和 Release 都是桌面窗口应用，不能额外弹一个控制台。
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    gamepilot_lib::run();
}
