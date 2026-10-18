import {
  CalendarClock,
  Clock,
  GitBranch,
  Repeat,
  Square,
  Hand,
  HandMetal,
  Keyboard,
  MousePointerClick,
  MoveHorizontal,
  PhoneCall,
  CornerDownLeft,
  ScanEye,
  Split,
  Timer,
  Type,
  type LucideProps,
} from 'lucide-react';
import { type ReactNode } from 'react';

/** 画布/模块栏用：按步骤类型渲染 Lucide 图标 */
export function FlowStepIcon({ type, ...props }: { type: string } & LucideProps): ReactNode {
  switch (type) {
    case 'manual':
      return <HandMetal {...props} />;
    case 'schedule':
      return <CalendarClock {...props} />;
    case 'interval':
      return <Timer {...props} />;
    case 'click':
      return <MousePointerClick {...props} />;
    case 'hold':
      return <Hand {...props} />;
    case 'swipe':
      return <MoveHorizontal {...props} />;
    case 'key':
      return <Keyboard {...props} />;
    case 'text':
    case 'setvar':
      return <Type {...props} />;
    case 'wait':
      return <ScanEye {...props} />;
    case 'delay':
      return <Clock {...props} />;
    case 'cond':
      return <GitBranch {...props} />;
    case 'else':
      return <Split {...props} />;
    case 'condend':
      return <CornerDownLeft {...props} />;
    case 'loop':
      return <Repeat {...props} />;
    case 'loopend':
      return <CornerDownLeft {...props} />;
    case 'loopbreak':
      return <Square {...props} />;
    case 'call':
      return <PhoneCall {...props} />;
    default:
      return <MousePointerClick {...props} />;
  }
}
