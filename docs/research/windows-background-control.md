# Windows 游戏「后台控制」方案调研（2026-10）

> 目的：给 GamePilot 的 PC 窗口自动化选一条**能用、可维护、许可干净**的路线。
> 结论先行：网上用得最多的「后台」方案基本都超出"纯外部"范畴（Hook/注入/驱动/硬件）；
> 纯用户态能覆盖的天花板就是我们现在的 **同步窗口消息 + SendInput + WGC**。

## 0. 结论速览

| 排名（使用广度） | 方案 | 代表 | 原理 | 真后台? | 许可/风险 |
|---|---|---|---|---|---|
| 国内游戏脚本事实标准 | **大漠插件后台绑定** | `dm.dll`（7.x，付费） | 显示 `gdi/dx2/dx3` + 鼠标/键盘 `windows/dx` 模式组合 | 部分可以（DX 模式依赖 Hook/注入类技术） | 闭源付费；32 位 COM；不能进开源仓库 |
| 国内常见替代 | **天使插件（TSPlug）** | 4.019 开源 | 与大漠同类的 DX 后台 DLL | 部分可以 | 仓库无明确许可证；VC2008/32 位；已停更 |
| 国内常见替代 | **乐玩插件** | 闭源 | 社区讨论称注入 DLL 实现后台 | 部分可以 | 闭源；许可不明 |
| 国际通用开源（消息级） | **AutoHotkey ControlSend/ControlClick** | AHK v2 | `PostMessage` 到窗口/控件 | 是（仅限吃窗口消息的程序） | GPL-2.0（不能并入闭源产品；可当外部工具） |
| 国际通用开源（系统输入） | **pyautogui / pydirectinput / pynput** | Python | `SendInput` / 扫描码 | **否**（系统级，走前台语义） | pyautogui BSD-3；pydirectinput MIT；pynput LGPL-3（本项目禁用） |
| 驱动级键鼠 | **Interception** | C/C++ 驱动 | 内核过滤驱动注入键鼠 | 否（仍进系统输入流） | **LGPL/商业双许可**，本项目许可政策不允许 |
| 驱动级键鼠（闭源） | **DD Xoft（DD 驱动）** | `dd.dll` | 驱动模拟键鼠 | 否（系统输入流） | 闭源免费；需装驱动/签名；反作弊高风险 |
| 虚拟手柄/摇杆 | **ViGEmBus / vJoy** | 驱动 | 创建虚拟 Xbox/DS4/joystick 设备 | 取决于游戏是否读手柄 | ViGEmBus BSD-3（**已归档/EOL**）；vJoy MIT |
| 硬件级 | **KMBox / Arduino HID / 采集卡** | USB 盒子 | 外部硬件当键鼠，PC 上不装任何注入 | 同 PC 仍需前台；双机/虚拟机场景才"真后台" | 硬件成本；反作弊/ToS 风险 |
| 微软官方 | **SendInput / UIA / WGC / VHF** | Win32/WinRT | 系统输入、无障碍、捕获、虚拟 HID 驱动 | SendInput/UIA 前台语义；WGC 只抓图 | 官方、许可干净 |

**一句话**：国内"后台"生态的头部是大漠插件，它的 DX 后台能力靠的是 DirectX Hook/进程内技术；
不想走注入/驱动，就只能接受"窗口消息级后台 + 前台兼容模式"这个上限。

## 1. 国内生态：大漠 / 天使 / 乐玩

### 1.1 大漠插件（dm.dll）

- 官方站点当前版本 **7.2607**；按机器数量计费（非简单游作者每天每台 7 分钱，每天有 1~2 小时试用），
  是**闭源商业插件**：<https://dm.yunboss.cn/fee_detail.asp>
- 社区资料称 3.1233 是最后一个免费版，之后为付费版（百度百科条目，抓取受验证码限制，仅作旁证）。
- 典型调用（官方/教程一致）：

  ```
  dm.BindWindowEx(hwnd, display, mouse, keypad, public_mode, mode)
  display: normal/gdi/gdi2/dx/dx2/dx3/opengl
  mouse/keypad: normal/windows/windows3/windows4/dx
  ```

  依据：大漠 7.x 帮助文档镜像、以及 CSDN 的 BindWindowEx 教程
  <https://blog.csdn.net/weixin_42557537/article/details/163381150>。
- 关键点：**`display=dx*` 负责从显存/渲染管线拿画面**（后台找图找色的主流方式）；
  **`mouse/keypad=windows*` 是窗口消息模式**（等价于我们的 `post=sync/message`），
  **`dx` 是 DirectX 输入模式**（社区讨论普遍认为涉及进程内 Hook/注入；官方闭源，无法核实）。
- 生态证据：按键精灵、易语言、精易论坛等教程/问答大量以大漠为主；天使插件 README 也直接写
  "我们认为大漠已经很成熟了"（见下）。
- **不能进 GamePilot**：闭源、付费、32 位 COM DLL，且 DX 模式与项目"不做注入/不碰游戏进程"的原则冲突。

### 1.2 天使插件 TSPlug（开源）

- GitHub：<https://github.com/gaojunxin/TSPlug>（111★；最后 push 2024，但代码基线是 2012 年的 4.019）
- README 原文（节选）："天使插件…将天使 4.019 版本代码开源…DX 后台功能源码完全开放，无任何保留部分"；
  编译环境 VC2008 + DXSDK_Feb10，示例 `ts.BindWindow(hwnd,"dx","dx","dx",0)`。
- **仓库没有 LICENSE 文件**（GitHub 也识别不到许可证），只能读思路、不能复用代码。
- 价值：它的 `DXBind.cpp` 可以作为"DX 后台画面 + 输入"实现思路的参考（Hook DirectX/窗口消息）。

### 1.3 乐玩插件

- 闭源商业插件（常与大漠/天使并列出现在 Python/易语言调用教程里：
  <https://blog.csdn.net/sun1613/article/details/108083819>）。
- 精易论坛讨论称其后台能力是"给窗口注入一个 DLL 来实现"（仅供了解，未核实）：
  <https://bbs.ijingyi.com/forum.php?mod=viewthread&action=printable&tid=14874636>
- 许可不明，不能进仓库。

### 1.4 国内结论

- "后台控制"用得最多的就是**大漠这一套：DX 抓图 + 窗口消息/DirectX 输入组合**；
  它不是单一 API，而是**一整套绑定模式矩阵**，需要按游戏逐个试。
- 这类方案的上限很高，但代价是：闭源/付费、32 位、注入/Hook、反作弊风险，
  和 GamePilot"纯外部、可闭源分发、Apache/MIT 依赖"的定位不兼容。

## 2. 国际/开源生态

### 2.1 AutoHotkey（GPL-2.0，13.3k★）

- `ControlSend`/`ControlClick` 用 **PostMessage** 把键鼠消息发给窗口/控件，不抢焦点；
- 官方文档明确：**只对标准/预定义控件最可靠，自定义控件（游戏自绘 UI）可能不工作**：
  <https://www.autohotkey.com/docs/v2/lib/ControlSend.htm>
- 结论：和我们 `post=message/sync` 同一层级；AHK 本身 GPL-2.0，不能并入项目，但可作为外部脚本工具。

### 2.2 Python 输入库

| 库 | 许可 | 机制 | 后台? | 备注 |
|---|---|---|---|---|
| pyautogui（12.7k★） | BSD-3 | SendInput | ❌ | 简单、前台 |
| pydirectinput（586★） | MIT | SendInput + 扫描码 | ❌ | 对 DirectInput 游戏比 pyautogui 好使，仍是前台 |
| pynput（2.1k★） | **LGPL-3** | SendInput | ❌ | 项目许可政策禁止 LGPL |
| keyboard/mouse | MIT | SendInput/钩子 | ❌ | 同上，前台 |

### 2.3 驱动级键鼠：Interception（2k★）

- <https://github.com/oblitum/Interception>
- 内核过滤驱动，能截获/注入键鼠；README 明确写 **LGPL（非商业）+ 商业双许可**，
  商业使用需单独购买授权；最后一次 push 2021。
- 注入仍进系统输入流，**不针对某个后台窗口**；反作弊能看到 `INJECTED` 标志（除非再做处理）。
- **本项目不能引用**（LGPL 在白名单外），也不符合"不装驱动"的产品形态。

### 2.4 驱动级键鼠（闭源）：DD Xoft

- `dd.dll` + 驱动，国内教程很多（"驱动级键鼠模拟"），Python 调用常见但**只支持 32 位 Python**（旧版），
  部分版本需联网验证；闭源、无公开许可。
  <https://zhuanlan.zhihu.com/question/42888871>（回答提到 32 位限制/联网验证）
- 仍走系统输入流（前台语义），优势是绕过部分用户态检测；反作弊风险高。

### 2.5 虚拟手柄：ViGEmBus（BSD-3，4.2k★）/ vJoy（MIT，741★）

- ViGEmBus：内核驱动模拟 Xbox 360/DS4 手柄，**已归档/EOL**：
  <https://github.com/nefarius/ViGEmBus>
- vJoy：MIT，虚拟 joystick 驱动（只模拟摇杆/按钮，不模拟键鼠）：
  <https://github.com/shauleiz/vJoy>
- 适用场景：**游戏支持手柄输入**时，可以让"输入"脱离窗口焦点；但很多游戏失焦后会降低逻辑帧率，
  且键鼠类 UI 仍需要鼠标。

### 2.6 硬件级：KMBox / Arduino HID / 采集卡

- KMBox 官方 wiki 定义：纯硬件 USB 主从控制器，**无需驱动、无需注入 DLL**：
  <https://www.kmbox.top/wiki_doc/kmboxB/site/>
- 它把键鼠指令从另一台机器/板卡发出，目标 PC 看到的是"真键盘鼠标"；
- 注意：**同一台 PC 上前台焦点规则不变**，KMBox 主要用于"双机/虚拟机 + 采集卡"架构；
  对反作弊是另一种对抗（不是许可问题，是 ToS/封号风险）。

## 3. 微软官方 API（许可干净）

| API | 能力 | 关键限制 |
|---|---|---|
| **SendInput** | 系统级合成键鼠 | 前台/输入流语义；受 UIPI 限制（只能注入同级或更低完整性进程）；被安全软件拦截时静默失败 |
| **InjectSyntheticPointerInput** | 合成 **笔/触摸** 指针 | Win10 1809+；只能注入 pen/touch，不解决后台键盘鼠标 |
| **UI Automation** | 标准控件树、Invoke/ValuePattern | 游戏自绘 UI（Unreal/Unity）基本不暴露 UIA |
| **Windows Graphics Capture** | 按窗口抓图、D3D/GPU、被遮挡可抓 | 只解决"看"，不解决"控"；Win10 1903+ |
| **Virtual HID Framework (VHF)** | 写 KMDF 驱动创建虚拟 HID | 内核驱动、需签名、开发量大；系统输入仍走前台语义 |

来源：
- SendInput：<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput>
- InjectSyntheticPointerInput：<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-injectsyntheticpointerinput>
- UI Automation：<https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32>
- WGC：<https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture>
- VHF：<https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/virtual-hid-framework--vhf->

## 4. 与 GamePilot 现状对照

| 能力 | GamePilot 现状 | 大漠 windows 模式 | 大漠 dx 模式 |
|---|---|---|---|
| 抓图 | WGC（官方）+ PrintWindow/BitBlt 回退 | GDI/DX 抓取 | DX Hook/显存 |
| 鼠标键盘 | `SendInput` / `SendMessageTimeout` / `PostMessage` / hybrid | `windows*` = 窗口消息 | `dx` = DirectX 输入（Hook/注入类） |
| 后台 | 消息级可后台；只认真实输入的游戏用 hybrid 临时前台 | 部分游戏可后台 | 大量 DX 游戏可后台 |
| 侵入性 | **零注入、零驱动** | 注入/Hook（闭源） | 注入/Hook（闭源） |
| 许可 | MIT/Apache/BSD 干净 | 商业付费 | 商业付费 |

结论：**我们已经覆盖了"大漠 windows 模式"这一层，且抓图用 WGC 比它的 GDI/DX 抓取更官方；
没有覆盖的是"大漠 dx 模式"那一层——它需要进程内 Hook/注入，属于我们不做的范围。**

## 5. 建议路线（已按此落地）

1. **界面只留两档：前台 / 后台**。前台 = `post=global`（SendInput，最可靠，会激活窗口）；
   后台 = `post=sync`（SendMessage，不抢焦点）。`message`/`hybrid`/`cursor=1` 作为高级 URI 保留，不再堆按钮。
   **推荐默认用「后台」先试，游戏没反应就换「前台」**；只认真实输入的游戏（本机这台 UE 就是）不要指望消息级后台。
2. WGC 抓图 + 20fps 循环保持；抓图与输入解耦。
3. **不建议**为"真后台"引入：大漠/天使/乐玩（闭源/许可）、Interception（LGPL）、DD（闭源驱动）。
   它们会破坏"纯外部、可闭源分发、无驱动"的产品边界，且反作弊风险高。
4. 如果某款游戏必须后台且不吃消息：
   - 先确认它**支持手柄** → 评估 vJoy（MIT）/ ViGEm 替代品，做"虚拟手柄"通道；
   - 否则只能上驱动/硬件：自研签名 VHF 驱动（成本高）或 KMBox + 双机/虚拟机（成本/ToS）；
   - 这三条都要单独评估，不作为默认能力。
5. 反作弊明确的游戏：**只做前台模式**，或直接不支持；不要在注入/驱动上试探。
6. 按键映射：Windows 窗口的「按键」步骤已支持 `a-z` / `0-9` / `f1-f12` / 方向 / 空格 / 回车 / Esc /
   Shift / Ctrl / Alt 等（引擎 `WINDOW_KEYS` 是唯一映射表）。

## 6. 参考链接汇总

- 大漠官方资费/版本：<https://dm.yunboss.cn/fee_detail.asp>
- 大漠 BindWindowEx 教程（社区）：<https://blog.csdn.net/weixin_42557537/article/details/163381150>
- 天使插件 TSPlug（源码）：<https://github.com/gaojunxin/TSPlug>
- 乐玩/天使/大漠 Python 调用：<https://blog.csdn.net/sun1613/article/details/108083819>
- 精易论坛（乐玩注入讨论）：<https://bbs.ijingyi.com/forum.php?mod=viewthread&action=printable&tid=14874636>
- AutoHotkey ControlSend：<https://www.autohotkey.com/docs/v2/lib/ControlSend.htm>
- Interception：<https://github.com/oblitum/Interception>
- ViGEmBus：<https://github.com/nefarius/ViGEmBus>
- vJoy：<https://github.com/shauleiz/vJoy>
- KMBox wiki：<https://www.kmbox.top/wiki_doc/kmboxB/site/>
- 微软 SendInput / UIA / WGC / VHF / InjectSyntheticPointerInput（见 §3）
