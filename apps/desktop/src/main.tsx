import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import '@/index.css';
import { StartupApp } from '@/layout/StartupApp';
import { readLaunchQuery } from '@/lib/windows';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点（index.html 被改动过？）');
}

// 冷启动占位仅用于浏览器解析 HTML 到 React 首次渲染之间。首帧提交后先让
// AppStartupScreen 接管同一画面，再移除 HTML 占位，避免两段品牌画面之间闪白。
const root = createRoot(container);
root.render(
  <StrictMode>
    {readLaunchQuery().launch === 'splash' ? <StartupApp /> : <App />}
  </StrictMode>,
);

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(() => document.getElementById('cold-start-splash')?.remove());
});
