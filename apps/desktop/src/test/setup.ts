import '@testing-library/jest-dom/vitest';

// jsdom 缺少浏览器布局 API，React Flow 与可拖拽分栏需要它们存在
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}

if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// jsdom 没有实现 blob URL（前端拉帧后用它喂给 <img>），测试环境补一个
if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', {
    writable: true,
    value: () => `blob:gamepilot/${Math.random().toString(36).slice(2)}`,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: () => undefined });
}

// jsdom 有 PointerEvent 但没有指针捕获：画面栏按下时会把指针捕获到自己身上
// （拖出画面也不丢手势），测试里补成空实现，不然 pointerdown 直接抛 TypeError
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Object.defineProperty(Element.prototype, 'setPointerCapture', { writable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', {
    writable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { writable: true, value: () => false });
}
