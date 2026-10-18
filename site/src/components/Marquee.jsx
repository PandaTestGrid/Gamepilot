const TECH = [
  'Tauri 2',
  'React 19',
  'Python 3.11',
  'scrcpy',
  'OpenCV',
  'pymobiledevice3',
  'JSON-RPC',
  'React Flow'
];

export default function Marquee() {
  return (
    <div className="marquee" aria-label="技术栈">
      <div className="marquee-track">
        {[...TECH, ...TECH].map((tech, index) => (
          <span className="marquee-item" key={`${tech}-${index}`}>
            <span>{tech}</span>
            <span className="sep">◆</span>
          </span>
        ))}
      </div>
    </div>
  );
}
