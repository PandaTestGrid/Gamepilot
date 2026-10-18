import { useEffect } from 'react';

export default function usePageMeta(title, description) {
  useEffect(() => {
    document.title = title ? `${title} · GamePilot` : 'GamePilot · 游戏自动化工作台';
    if (!description) return undefined;
    let tag = document.querySelector('meta[name="description"]');
    if (!tag) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'description');
      document.head.appendChild(tag);
    }
    tag.setAttribute('content', description);
    return undefined;
  }, [title, description]);
}
