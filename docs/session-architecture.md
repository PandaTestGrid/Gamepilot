# 设备会话模块边界

设备会话采用组合服务，不使用多重继承、动态方法注入或 `__getattr__` 转发。

## 入口与职责

- [session.py](../engine/src/gamepilot/session.py) 是稳定导出入口。RPC、测试及外部调用仍可从 `gamepilot.session` 导入原有类和辅助函数。
- [sessions/device.py](../engine/src/gamepilot/sessions/device.py) 定义 `DeviceSession`：构造共享状态、拥有锁与线程生命周期、保留明确且带类型的原方法委托。
- 服务持有一个带类型的 `DeviceSession` 引用，不复制 graph、runner、帧、锁等可变状态。

| 模块 | 职责 |
| --- | --- |
| [capture.py](../engine/src/gamepilot/sessions/capture.py) | 独立采集、最新帧发布、预览推流和采集耗时统计 |
| [execution.py](../engine/src/gamepilot/sessions/execution.py) | 串行流程执行、runner 管理、子流程、自动触发、运行证据与引擎事件 |
| [input.py](../engine/src/gamepilot/sessions/input.py) | 手动触控、输入互斥、自动输入保护和单动作执行 |
| [recordings.py](../engine/src/gamepilot/sessions/recordings.py) | 独立录屏 worker、SQLite 写入、索引分页和资源清理 |
| [history.py](../engine/src/gamepilot/sessions/history.py) | 有界预览历史、历史帧查询和 JPEG 编码 |
| [materials.py](../engine/src/gamepilot/sessions/materials.py) | 图像模板与 OCR 素材录制 |
| [yolo.py](../engine/src/gamepilot/sessions/yolo.py) | AI 示例读取、录入、更新和试识别 |
| [editing.py](../engine/src/gamepilot/sessions/editing.py) | 会话级图编辑、动作录制、图保存与重载 |
| [graph_ops.py](../engine/src/gamepilot/sessions/graph_ops.py) | 不依赖已连接设备的纯图操作 |
| [models.py](../engine/src/gamepilot/sessions/models.py) | runner 值类型、限制常量与图加载辅助函数 |

## 并发约束

拆分模块不改变线程模型：每设备只有一个采集线程、一个串行执行线程和一个录屏线程。

1. 采集线程只发布最新帧。识别、动作执行和 SQLite 写入不能回到采集路径。
2. 执行和录屏各消费有界最新帧槽位，不能引入无限 FIFO 队列。
3. `DeviceSession` 仍是共享状态的唯一所有者。服务之间通过明确的会话接口协作，不创建第二套 runner、锁或帧状态。
4. `_lifecycle_lock` 串行化流程启动、停止与完成收尾；`_execution_lock` 保证唯一执行 owner；`_input_lock` 保护实际输入事务。状态查询不能等待长动作执行锁。
5. 停止与重启保留 runner 身份检查、协作取消、迟到事件过滤和录屏 generation 校验。
6. 服务通过 `TYPE_CHECKING` 引用 `DeviceSession`，避免运行时循环导入。

## 扩展规则

新增能力应进入对应服务。只有跨服务共享状态初始化、生命周期管理及稳定 API 委托留在 `DeviceSession`。不要为了减少行数将方法动态绑定到类，也不要用 `Any` 隐藏服务依赖。

[模块边界测试](../engine/tests/test_session_modules.py) 固定公开签名、旧导出、服务职责和独立导入能力，并设置文件膨胀护栏；[并发调度测试](../engine/tests/test_session_scheduling.py) 负责验证慢识别、慢动作、停止和立即重启行为。
