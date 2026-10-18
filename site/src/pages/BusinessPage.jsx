import { useState } from 'react';
import Icon from '../components/Icon';
import PageHead from '../components/PageHead';
import Reveal from '../components/Reveal';
import usePageMeta from '../hooks/usePageMeta';

const TYPES = ['游戏内容合作', '工具/渠道分发', '工作室定制自动化', '媒体与社区', '其他'];

const OFFERS = [
  {
    icon: 'layers',
    title: '游戏内容合作',
    desc: '为新游、版本更新或活动做可交互的自动化演示，把「能不能挂」直接展示出来。',
    tags: ['场景演示', '版本活动', '内容共创']
  },
  {
    icon: 'target',
    title: '工作室定制',
    desc: '按你的设备矩阵、识别习惯与运行流程定制工作区模板、恢复策略与批量控制。',
    tags: ['多开矩阵', '流程模板', '私有部署']
  },
  {
    icon: 'monitor',
    title: '渠道与分发',
    desc: '面向模拟器、云游戏与设备厂商的联合方案，让自动化能力直接进入你的产品链路。',
    tags: ['渠道预装', '联合方案', '技术支持']
  }
];

export default function BusinessPage() {
  const [type, setType] = useState(TYPES[0]);
  const [done, setDone] = useState(false);
  usePageMeta('商务合作', 'GamePilot 的游戏内容合作、工作室定制与渠道分发合作。');

  const submit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!data.get('name') || !data.get('contact') || !data.get('message')) return;
    setDone(true);
    form.reset();
    setType(TYPES[0]);
  };

  return (
    <div className="page-container">
      <div className="container">
        <PageHead
          eyebrow="BUSINESS · 商务合作"
          title="把自动化，接到你的游戏里"
          lead="我们和游戏团队、工作室、模拟器与设备厂商一起，把「看懂画面、稳定跑图」做成可展示、可交付的能力。"
        />

        <div className="biz-offers">
          {OFFERS.map((offer, index) => (
            <Reveal className="biz-offer" key={offer.title} delay={index * 0.06}>
              <span className="biz-icon">
                <Icon name={offer.icon} />
              </span>
              <h2>{offer.title}</h2>
              <p>{offer.desc}</p>
              <div className="biz-tags">
                {offer.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </Reveal>
          ))}
        </div>

        <div className="biz-layout">
          <section className="biz-form-card" aria-labelledby="biz-form-title">
            <div className="biz-form-head">
              <h2 id="biz-form-title">说说你的需求</h2>
              <p>表单为前端演示，不会上传或发送任何数据。正式合作前，我们会先确认使用场景与合规边界。</p>
            </div>

            {done ? (
              <div className="biz-success" role="status">
                <span className="biz-success-icon">
                  <Icon name="check" />
                </span>
                <h3>已记录在本地</h3>
                <p>这是演示表单，没有发送到服务器。接入后端后，这里会替换成真实的商务邮箱与工单系统。</p>
                <button className="btn btn-ghost" type="button" onClick={() => setDone(false)}>
                  再填一次
                </button>
              </div>
            ) : (
              <form className="biz-form" onSubmit={submit}>
                <div className="field-row">
                  <label>
                    <span>称呼 / 团队</span>
                    <input name="name" type="text" placeholder="怎么称呼你" required />
                  </label>
                  <label>
                    <span>联系方式</span>
                    <input name="contact" type="text" placeholder="邮箱 / 微信 / 电话" required />
                  </label>
                </div>
                <label>
                  <span>合作类型</span>
                  <select name="type" value={type} onChange={(event) => setType(event.target.value)}>
                    {TYPES.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>需求描述</span>
                  <textarea
                    name="message"
                    rows="5"
                    placeholder="游戏 / 设备规模 / 希望解决哪一段流程 / 期望时间"
                    required
                  />
                </label>
                <button className="btn btn-primary" type="submit">
                  <Icon name="mail" />
                  提交需求
                </button>
                <p className="form-note">
                  提交即表示你理解：GamePilot 不提供绕过风控、改内存或注入类能力。
                </p>
              </form>
            )}
          </section>

          <aside className="biz-side">
            <div className="side-card">
              <h3>合作流程</h3>
              <ol className="biz-steps">
                <li>
                  <span>01</span>
                  需求对齐：场景、设备、合规边界
                </li>
                <li>
                  <span>02</span>
                  一周内做出现场 Demo
                </li>
                <li>
                  <span>03</span>
                  确定模板、交付与支持方式
                </li>
              </ol>
            </div>
            <div className="side-card side-card-muted">
              <h3>我们在意的事</h3>
              <p>
                真实设备输入、本地运行、失败可解释。任何合作都不会要求读取游戏进程或修改客户端。
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
