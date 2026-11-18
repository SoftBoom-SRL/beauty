// cart/ServiceBuilder.jsx — la riga «Trattamento» sotto il catalogo del banco
// (CartTab): un servizio fatto senza appuntamento, incassato come un prodotto.
// Prima al banco si vendevano solo prodotti, e per incassare un trattamento
// bisognava inventare un appuntamento in agenda (Beauty Boutique, 11/2026).
// La scelta è quella del check-out (LinePicker): cartelle per categoria,
// elenco intero scrivendo nella ricerca.
import { useState } from 'react';
import { Icon } from '@youty/shared';
import LinePicker from '../sell/LinePicker.jsx';
import { svcLabel } from '../lib.js';

export default function ServiceBuilder({ services, categories, onAdd, t, lang }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const close = () => { setOpen(false); setQ(''); };
  const needle = q.trim().toLowerCase();
  const items = (services || []).filter((s) => s.active !== false && (!needle || svcLabel(s, lang).toLowerCase().includes(needle)));
  return (
    <div className="dk-card" style={{ marginTop: 16, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="scissors" size={20} color="var(--clay-ink)" />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Trattamento senza appuntamento', 'Walk-in treatment')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Incassa un servizio senza crearlo in agenda', 'Charge a service without booking it')}</div>
        </div>
        {!open && (
          <button className="dk-btn dk-btn--ghost" style={{ height: 38 }} onClick={() => setOpen(true)}>
            <Icon name="plus" size={15} />{t('Aggiungi', 'Add')}
          </button>
        )}
      </div>
      {open && (
        <LinePicker type="service" q={q} onQ={setQ} onClose={close} items={items} products={null}
          onPick={(s) => { onAdd(s); close(); }} t={t} lang={lang} categories={categories} />
      )}
    </div>
  );
}
