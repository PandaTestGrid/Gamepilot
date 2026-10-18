/**
 * 录制草稿浮层的公共外壳与表单控件。
 *
 * 「图像模板」（RecordOverlay）和「文字识别」（OcrRecognizerDialog）是两种识别器，
 * 但录制草稿的交互规则完全一样：锚在框选区旁边、点击不冒泡到画面、Esc 取消、Enter 保存。
 * 外壳只负责这些；两个表单各自写自己的字段。
 */
import { X } from 'lucide-react';
import { type CSSProperties, type ReactNode } from 'react';

const PANEL_W = 264;
const GAP = 8;
const MARGIN = 8;

export interface DraftAnchor {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 浮层摆位：优先放在框选区右侧，放不下就翻到左侧，再钳进视口。
 *
 * `panelH` 只是估算（决定上移多少）；内容超出时 `maxHeight` + 内部滚动兜底，
 * 所以估算偏小也不会把按钮藏掉。
 */
export function draftPopoverStyle(anchor: DraftAnchor | null | undefined, panelH: number): CSSProperties {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  if (!anchor) {
    return { position: 'fixed', right: MARGIN, top: MARGIN };
  }
  let left = anchor.left + anchor.width + GAP;
  if (left + PANEL_W > viewportW - MARGIN) {
    left = anchor.left - PANEL_W - GAP;
  }
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, viewportW - PANEL_W - MARGIN));

  let top = anchor.top;
  if (top + panelH > viewportH - MARGIN) {
    top = anchor.top + anchor.height - panelH;
  }
  top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, viewportH - panelH - MARGIN));
  return { position: 'fixed', left, top, maxHeight: viewportH - 2 * MARGIN, overflowY: 'auto' };
}

/** 两种录制表单共用的浮层骨架（标题栏 + 关闭 + Esc/Enter + 阻止冒泡）。 */
export function DraftOverlayShell({
  testId,
  anchor,
  panelH,
  icon,
  title,
  sizeText,
  onCancel,
  onSubmit,
  children,
}: {
  testId: string;
  anchor?: DraftAnchor | null;
  panelH: number;
  icon: ReactNode;
  title: string;
  sizeText: string;
  onCancel: () => void;
  onSubmit: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={testId}
      data-capture-keep
      className="fixed z-50 w-[264px] rounded-sm border border-line bg-panel p-2.5 text-body shadow-lg"
      style={draftPopoverStyle(anchor, panelH)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onCancel();
        }
        if (event.key === 'Enter') {
          onSubmit();
        }
      }}
      // 这层是 fixed 但仍在画面容器的 React 树里：不拦的话点输入框/保存
      // 会冒泡到画面的 mouse 处理器，把草稿当成"又点了一下"重新框选。
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      role="presentation"
    >
      <div className="mb-2 flex items-center gap-1.5 border-b border-line pb-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-brand/20 text-brand">
          {icon}
        </span>
        <span className="min-w-0 truncate text-panelhead font-medium text-fg">{title}</span>
        <span className="shrink-0 font-mono text-badge text-faint">{sizeText}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          aria-label="关闭"
          className="flex size-5 items-center justify-center rounded-sm text-dim hover:bg-raised hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="mb-2">
      <div className="mb-1 text-badge text-faint">{label}</div>
      {children}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}): ReactNode {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-badge text-dim">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3 shrink-0 accent-[var(--brand)]"
      />
      {label}
    </label>
  );
}

export function Radio({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}): ReactNode {
  return (
    <label className="flex w-16 cursor-pointer items-center gap-1 text-badge text-dim">
      <input type="radio" checked={checked} onChange={onChange} className="size-3 accent-[var(--brand)]" />
      {label}
    </label>
  );
}
