import Icon from './Icon';

function pagesOf(page, total) {
  const pages = [];
  const start = Math.max(1, Math.min(page - 2, total - 4));
  const end = Math.min(total, start + 4);
  for (let i = start; i <= end; i += 1) pages.push(i);
  return pages;
}

export default function Pagination({ page, total, onChange }) {
  if (total <= 1) return null;
  const pages = pagesOf(page, total);

  return (
    <nav className="pagination" aria-label="游戏列表分页">
      <button
        type="button"
        className="page-btn page-arrow"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label="上一页"
      >
        <Icon name="chevron" />
      </button>
      {pages[0] > 1 ? <span className="page-gap">…</span> : null}
      {pages.map((item) => (
        <button
          key={item}
          type="button"
          className={`page-btn${item === page ? ' is-current' : ''}`}
          onClick={() => onChange(item)}
          aria-current={item === page ? 'page' : undefined}
        >
          {item}
        </button>
      ))}
      {pages[pages.length - 1] < total ? <span className="page-gap">…</span> : null}
      <button
        type="button"
        className="page-btn page-arrow is-next"
        onClick={() => onChange(page + 1)}
        disabled={page >= total}
        aria-label="下一页"
      >
        <Icon name="chevron" />
      </button>
    </nav>
  );
}
