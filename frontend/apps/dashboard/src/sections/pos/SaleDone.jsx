// SaleDone.jsx — la vendita al banco registrata (CartTab): articoli, totale,
// pagamenti, a chi è accreditata, gift card emesse; da qui una nuova vendita
// o lo storico.
import { Icon } from '@youty/shared';
import { methodLabel, money, opName } from './lib.js';

export default function SaleDone({ done, seller, onNew, onGoHistory, t, lang }) {
  const hasGift = done.lines.some((l) => l.line_type === 'gift_card');
  const methodsUsed = done.payments.map((p) => methodLabel(p.method, t)).join(' + ');
  return (
    <div className="dk-card pop-in" style={{ padding: '44px 36px', textAlign: 'center', maxWidth: 540, margin: '0 auto' }}>
      <div style={{ width: 68, height: 68, borderRadius: 99, background: 'var(--ok-tint)', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}>
        <Icon name="check" size={34} color="var(--ok)" stroke={2.4} />
      </div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500 }}>{t('Vendita completata', 'Sale complete')}</div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>
        {done.lines.reduce((s, l) => s + (l.qty || 1), 0)} {t('articoli', 'items')} · {money(done.total, lang)} · {methodsUsed}
      </div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>
        {seller ? t('Accreditata a', 'Credited to') + ' ' + opName(seller) : ''}
        {done.client_name ? (seller ? ' · ' : '') + done.client_name : (seller ? ' · ' : '') + t('Da banco', 'Walk-in')}
      </div>
      {hasGift && (
        <div className="t-sm" style={{ color: 'var(--ok)', marginTop: 10, fontWeight: 600 }}>
          <Icon name="gift" size={15} color="var(--ok)" style={{ verticalAlign: '-2px', marginRight: 5 }} />
          {t('Gift card emessa', 'Gift card issued')}{done.lines.filter((l) => l.line_type === 'gift_card').map((l) => l.gift_card_code).filter(Boolean).map((c) => ' · ' + c).join('')}
        </div>
      )}
      <button className="dk-btn dk-btn--clay" style={{ marginTop: 24, width: '100%', height: 48 }} onClick={onNew}>
        <Icon name="plus" size={18} color="#fff" />{t('Nuova vendita', 'New sale')}
      </button>
      <button className="dk-btn dk-btn--ghost" style={{ marginTop: 10, width: '100%', height: 44 }} onClick={onGoHistory}>
        <Icon name="clock" size={16} />{t('Vedi storico vendite', 'View sales history')}
      </button>
    </div>
  );
}
