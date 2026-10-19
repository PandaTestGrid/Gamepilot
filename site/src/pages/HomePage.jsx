import Compare from '../components/Compare';
import Cta from '../components/Cta';
import Devices from '../components/Devices';
import Faq from '../components/Faq';
import GameShowcase from '../components/GameShowcase';
import Hero from '../components/Hero';
import Marquee from '../components/Marquee';
import PlayStyles from '../components/PlayStyles';
import TechBand from '../components/TechBand';
import Workflow from '../components/Workflow';
import { useDownload } from '../context/DownloadContext';
import usePageMeta from '../hooks/usePageMeta';

export default function HomePage() {
  const onDownload = useDownload();
  usePageMeta('', 'GamePilot 是一款面向游戏的自动化工作台：框选界面即可识别，拖拽连线即脚本，一台电脑同时驱动安卓、iPhone 与桌面窗口。');

  return (
    <>
      <Hero onDownload={onDownload} />
      <Marquee />
      <GameShowcase />
      <PlayStyles />
      <Workflow />
      <TechBand />
      <Devices />
      <Compare />
      <Faq onDownload={onDownload} />
      <Cta onDownload={onDownload} />
    </>
  );
}
