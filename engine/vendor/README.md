# vendor/scrcpy-server

`scrcpy-server` 是 [scrcpy](https://github.com/Genymobile/scrcpy) 的设备端程序
（Apache-2.0），GamePilot 的投屏通道直接和它对话，不需要用户自己装 scrcpy。

- **版本：3.3.4**（协议与 `engine/src/gamepilot/devices/scrcpy.py` 里的 `SCRCPY_VERSION` 必须一致）
- 来源：Homebrew `scrcpy` 3.3.4 的 `share/scrcpy/scrcpy-server`
- 更新方式：换 scrcpy 版本时同步替换本文件并更新 `SCRCPY_VERSION`

查找顺序（`find_server_jar()`）：环境变量 `GAMEPILOT_SCRCPY_SERVER` → 本目录 →
系统安装的 scrcpy（`brew --prefix`/share/scrcpy、/usr/local/share/scrcpy 等）。
