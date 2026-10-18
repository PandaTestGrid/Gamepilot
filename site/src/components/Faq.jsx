import { FAQS } from '../data/faqs';
import BlurText from '../reactbits/BlurText';
import Icon from './Icon';
import Reveal from './Reveal';

export default function Faq({ onDownload }) {
  return (
    <section className="section section-alt" id="faq" aria-labelledby="faq-title">
      <div className="container faq-layout">
        <div className="faq-intro">
          <Reveal as="p" className="eyebrow">
            常见问题
          </Reveal>
          <h2 id="faq-title">
            <BlurText as="span" text="开始之前，" animateBy="chars" delay={24} />
            <br />
            <BlurText
              as="span"
              text="你可能想知道"
              animateBy="chars"
              delay={24}
              startDelay={0.26}
            />
          </h2>
          <Reveal as="p" className="section-lead" delay={0.06}>
            还有别的问题？下载弹窗里可以直接留下邮箱。
          </Reveal>
          <Reveal delay={0.12}>
            <button className="btn btn-ghost" type="button" onClick={onDownload}>
              联系与内测
              <Icon name="arrow" />
            </button>
          </Reveal>
        </div>

        <div className="faq-list">
          {FAQS.map((item, index) => (
            <Reveal
              as="details"
              className="faq-item"
              name="gamepilot-faq"
              key={item.q}
              delay={Math.min(index * 0.04, 0.2)}
              amount={0.05}
            >
              <summary>
                {item.q}
                <span className="faq-plus" aria-hidden="true" />
              </summary>
              <div className="faq-body">
                <p>{item.a}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
