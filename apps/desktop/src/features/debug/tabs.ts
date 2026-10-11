/**
 * 底部调试抽屉的 Tab 元数据：**一处定义，抽屉与底栏共用**。
 * 加一个 Tab（比如以后的「帧序列」「性能」）= 这里加一行 + DebugDrawer 里加一个分支。
 */
import type { DockTab } from '@/types';

export interface DockTabSpec {
  readonly id: DockTab;
  readonly label: string;
  /** 悬停说明：一句话讲清这个 Tab 用来回答什么问题 */
  readonly hint: string;
}

export const DOCK_TABS: readonly DockTabSpec[] = [
  { id: 'events', label: '事件流', hint: '状态机每一步：进节点 / 命中边 / 执行动作 / 失败与中断' },
  { id: 'logs', label: '日志', hint: '引擎与界面的原始日志（排查"引擎说了什么"）' },
  { id: 'console', label: '控制台', hint: '手发一条 RPC 看返回值（排查是哪一层坏了）' },
  { id: 'timeline', label: '时间轴', hint: '最近 60s 的帧与识别结果（M4 接真实环形缓冲）' },
];
