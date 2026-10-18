import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

const BUILDS = {
  macos: {
    name: 'GamePilot for macOS',
    meta: 'v0.1.0 内测 · Apple Silicon / Intel · 约 150 MB'
  },
  windows: {
    name: 'GamePilot for Windows',
    meta: 'v0.1.0 内测 · Windows 10 / 11 · x64 · 约 150 MB'
  }
};

export default function DownloadDialog({ open, onClose }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const [os, setOs] = useState('macos');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      window.__lenis?.stop();
      const timer = window.setTimeout(() => inputRef.current?.focus(), 120);
      return () => window.clearTimeout(timer);
    }
    if (!open && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setDone(false);
    setError('');
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => {
      window.__lenis?.start();
      onClose();
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  const handleSubmit = (event) => {
    event.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('请输入有效的邮箱地址，例如 you@example.com');
      setDone(false);
      return;
    }
    setError('');
    setDone(true);
    setEmail('');
  };

  const build = BUILDS[os];

  return (
    <dialog
      className="download-modal"
      id="download-dialog"
      ref={dialogRef}
      aria-labelledby="dl-title"
      onPointerDown={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-head">
          <div>
            <span className="eyebrow">内测申请</span>
            <h2 id="dl-title">下载 GamePilot</h2>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>

        <div className="os-toggle" role="group" aria-label="选择平台">
          <button
            className={`os-option${os === 'macos' ? ' is-active' : ''}`}
            type="button"
            aria-pressed={os === 'macos'}
            onClick={() => setOs('macos')}
          >
            <Icon name="monitor" />
            macOS
          </button>
          <button
            className={`os-option${os === 'windows' ? ' is-active' : ''}`}
            type="button"
            aria-pressed={os === 'windows'}
            onClick={() => setOs('windows')}
          >
            <Icon name="monitor" />
            Windows
          </button>
        </div>

        <div className="build-card">
          <span className="build-icon">
            <Icon name="download" />
          </span>
          <div>
            <strong>{build.name}</strong>
            <span>{build.meta}</span>
          </div>
          <span className="build-tag">筹备中</span>
        </div>

        <form className="download-form" onSubmit={handleSubmit} noValidate>
          <label htmlFor="email">留下邮箱，内测包准备好时通知你</label>
          <div className="input-row">
            <input
              ref={inputRef}
              type="email"
              id="email"
              name="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (error) setError('');
              }}
              aria-describedby="form-note"
              aria-invalid={error ? 'true' : undefined}
            />
            <button className="btn btn-primary" type="submit">
              申请内测
            </button>
          </div>
          <p className="form-note" id="form-note">
            这是前端演示站点：提交只在本页生效，不会上传或发送邮件。
          </p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {done ? (
            <p className="form-success" role="status">
              已记录，感谢关注！内测包发布时会第一时间通知你。
            </p>
          ) : null}
        </form>

        <ul className="modal-points">
          <li>
            <Icon name="check" />
            无需安装 Python，安装包自带引擎
          </li>
          <li>
            <Icon name="check" />
            全程本地，不上传画面与脚本
          </li>
          <li>
            <Icon name="check" />
            支持 macOS 与 Windows 桌面端
          </li>
        </ul>
      </div>
    </dialog>
  );
}
