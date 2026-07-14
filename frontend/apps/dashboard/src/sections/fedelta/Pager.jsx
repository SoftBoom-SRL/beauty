import React from 'react';
import { Icon } from '@youty/shared';

/** Simple prev/next pager for {items,count} Ninja pagination envelopes. Hides itself when
 * everything fits on one page. */
export default function Pager({ count, limit, offset, setOffset, t }) {
  if (!count || count <= limit) return null;
  const from = offset + 1;
  const to = Math.min(count, offset + limit);
  const atStart = offset === 0;
  const atEnd = offset + limit >= count;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
      <span className="t-sm" style={{ color: 'var(--muted)' }}>{from}–{to} {t('di', 'of')} {count}</span>
      <button className="dk-iconbtn" disabled={atStart} onClick={() => setOffset(Math.max(0, offset - limit))}
        style={{ opacity: atStart ? 0.4 : 1, cursor: atStart ? 'default' : 'pointer', width: 34, height: 34 }}>
        <Icon name="chevL" size={15} />
      </button>
      <button className="dk-iconbtn" disabled={atEnd} onClick={() => setOffset(offset + limit)}
        style={{ opacity: atEnd ? 0.4 : 1, cursor: atEnd ? 'default' : 'pointer', width: 34, height: 34 }}>
        <Icon name="chevR" size={15} />
      </button>
    </div>
  );
}
