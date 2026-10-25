# ADR 0003：Windows 本机窗口设备（句柄绑定 + 前台/后台双通道）

- **状态**：已接受
- **日期**：2026-10-22
- **决策者**：@mini

## 背景

目标场景从 Android 手游扩展到 **PC 游戏挂机**。`Controller` 抽象（`resolution / screenshot /
click / swipe / press / text`）与 macOS 窗口设备（`Mac:///?window=<句柄>`）已经证明
"把一个窗口当设备"这条路可行，Windows 侧只差实现（`macos.py` 里一直留着 TODO）。

Windows 与 macOS 的差异集中在四件事，必须各自决策：

1. **怎么定位窗口**：`HWND` 会随窗口重开而变；用户希望"选一个窗口就绑定它"；
2. **怎么抓图**：`PrintWindow` 对 GDI/部分 DX 窗口有效且不怕遮挡；很多游戏（尤其独占全屏）
   抓不到；`BitBlt` 屏幕 DC 能抓 GPU 画面但要求可见、未被遮挡；
3. **怎么输入**：`SendInput` 最可靠但会抢鼠标/焦点；`PostMessage` 后台可用但部分游戏忽略；`SendMessage` 同步消息能进 UE/Unity 的窗口过程；
4. **依赖**：`pywin32` 是 Windows-only 且引入新依赖；项目规范只允许白名单许可 + 尽量不加依赖。

## 决策

1. **句柄绑定就是设备身份**：
   - URI `Windows:///?hwnd=<十进制>`，会话 id `windows:<HWND>`（与 `macos:<编号>` 同构）；
   - `window.list` 一次返回 `handle / hwnd / process / title / class / client 区域 / uri / deviceId`，
     界面点一行直接把 `uri` 交给 `device.connect`；同时支持手输句柄（`0x1A2B` 由
     `parse_device_uri` 统一归一化成十进制，避免同一窗口出两个会话）；
   - 兜底定位 `?pid=` / `?title=` / `?exe=` / `?class=`。
2. **抓图：官方 WGC 优先，旧链路兜底**（2026-10-22 更新）：
   - 装可选依赖 `windows-capture`（MIT）时，`capture=auto` 走 **Windows Graphics Capture**
     （微软官方 API，Win10 1903+）：按窗口抓、支持 D3D/GPU、被遮挡也能抓。实测同一 UE 窗口
     ~50fps、拷贝 <5ms；帧是整窗 BGRA，按客户区偏移裁成 BGR；
   - 回退链路：`PrintWindow(PW_CLIENTONLY|PW_RENDERFULLCONTENT)` → 整窗 `PrintWindow` 裁剪 →
     `BitBlt` 屏幕 DC → `BitBlt` 窗口 DC。每帧检测全黑（均值 < 2），成功方式缓存；
   - 不直接做 DXGI Desktop Duplication：WGC 已覆盖按窗口抓的需求，DXGI 只作为将来全屏/超高帧率的备选。
3. **界面只留前台 / 后台两档，其余为高级 URI 档**：
   - `post=global`（界面「前台」，引擎默认）：`SendInput` + 虚拟屏绝对坐标（Per-Monitor DPI 感知），
     点前按 `SwitchToThisWindow` → AttachThreadInput → 模拟 Alt → 置顶四级兜底激活窗口，
     点后把鼠标放回原处；**激活失败直接报错**，绝不把点击发给别的窗口；
   - `post=sync`（界面「后台」）：`SendMessageTimeout` 同步投递（`WM_LBUTTON*` / `WM_KEY*` / `WM_CHAR`），
     不抢鼠标/焦点；**实测 UE 游戏后台按键/鼠标移动/菜单可走通**；
   - `post=message`：`PostMessage` 排队投递，不阻塞但部分引擎忽略（同一款 UE 游戏实测后台收不到），高级档；
   - `post=hybrid`：兼容档——动作前临时把目标窗口切前台、用真实 `SendInput`，动作后把焦点还原；
     只认真实输入的游戏（含这场实测的 UE 游戏）最后只能用它，代价是每次动作闪一下焦点；
   - `cursor=1`：给后台模式叠加光标跟随（手势期间临时把指针放到目标点），兼容用系统光标算落点的 UI；
   - 后台鼠标消息会沿子窗口树下钻到真正接收输入的子窗口（Chromium/Electron/WinForms 控件）。
4. **只用 stdlib `ctypes`，不新增依赖**：`ctypes.wintypes` + 手写 `argtypes/restype`，
   模块在非 Windows 上 import 安全；打包（PyInstaller）无需额外 hidden import。

## 后果

**收益**

- PC 窗口与 Android/iOS/macOS 共用一套设备层/会话层/识别器/状态图，前端只多一个「本机窗口」Tab；
- 用户路径短：打开设备弹层 → 选窗口（或粘句柄）→ 直接出画面、可录制、可跑流程；
- 后台同步模式给"一边挂机一边用电脑"留了口子（UE 实测可用），前台模式保证最坏情况下的兼容性。

**代价 / 风险**

- 独占全屏、反作弊、管理员权限三座山仍在，文档与错误信息里明说；
- 后台消息的兼容性仍取决于游戏（反作弊/驱动级原始输入只认前台）；界面只保留**前台 / 后台**两档，
  `message`/`hybrid`/`cursor` 作为高级 URI 档保留（不再堆 UI 按钮）；
- 截图性能未针对 4K/高帧率优化（WGC 回调里已裁到客户区并只留最新帧；`PrintWindow` 回退路径仍是每帧建 DIB + 一次拷贝）。

**验证**

`scripts/smoke-windows-window.py`（真实引擎子进程 + Tk 测试窗口）21 项检查全过：
枚举 → 绑定句柄 → WGC/PrintWindow 首帧非黑 → `engine.frame` 出图 → `SendInput` 点击真的落到窗口 →
`post=message` 重新绑定 → 原生 WinForms 按钮的后台同步点击。另有 40+ 条离线单测覆盖过滤/句柄/坐标/黑帧/按键（含游戏键映射）/`window.list` 分发。
