import appShot from '../assets/img/app-shot.jpg';

/**
 * Real GamePilot desktop workspace screenshot.
 * Kept deliberately flat: the UI is dense, so no 3D tilt that would blur it.
 */
export default function AppMockup() {
  return (
    <figure className="app-shot">
      <span className="app-shot-glow" aria-hidden="true" />
      <div className="app-shot-frame">
        <img
          src={appShot}
          alt="GamePilot 桌面工作台实机截图：左侧同时显示安卓手机与模拟器画面，中间是组队、刷新、加入、协议队伍四个状态节点组成的自动化流程，右侧是运行日志、识别物料与设备列表。"
          width="2560"
          height="1351"
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
      </div>
      <figcaption className="app-shot-caption">
        <span>
          <i className="dot live" aria-hidden="true" />
          GamePilot 桌面工作台 · 实机截图
        </span>
        <span>多设备同屏 / 状态图 / 识别器 / 事件流</span>
      </figcaption>
    </figure>
  );
}
