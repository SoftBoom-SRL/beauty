// cart/CreditBuilder.jsx — sotto il catalogo del banco (CartTab): vendere un
// pacchetto di listino o un trattamento pagato in anticipo. Tutti e due
// diventano sedute DELLA cliente scelta nel carrello: senza cliente il server
// rifiuta la vendita, e qui lo si dice prima.
import { useState } from 'react';
import { Icon } from '@youty/shared';
import PackageForm from '../sell/PackageForm.jsx';
import PrepaidForm from '../sell/PrepaidForm.jsx';

const blankPrepaid = () => ({ serviceId: '', sessions: 1, amt: 0, edited: false });

export default function CreditBuilder({ packages, services, hasClient, onAddPackage, onAddPrepaid, t, lang }) {
  const [mode, setMode] = useState('package');   // 'package' | 'prepaid'
  const [pkgForm, setPkgForm] = useState({ packageId: '' });
  const [prepaidForm, setPrepaidForm] = useState(blankPrepaid);
  const tab = (k, label) => {
    const on = mode === k;
    return (
      <button key={k} onClick={() => setMode(k)} aria-pressed={on}
        style={{ padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: on ? 700 : 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>
        {label}
      </button>
    );
  };
  return (
    <div className="dk-card" style={{ marginTop: 16, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="tag" size={20} color="var(--clay-ink)" />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Pacchetti e trattamenti già pagati', 'Packages and prepaid treatments')}</div>
          <div className="t-sm" style={{ color: hasClient ? 'var(--muted)' : 'var(--warn)', fontWeight: hasClient ? 400 : 600 }}>
            {hasClient
              ? t('Diventano sedute della cliente, da scalare visita per visita', 'They become the client’s sessions, used visit by visit')
              : t('Scegli prima la cliente nel carrello: le sedute sono sue', 'Pick the client in the cart first: the sessions are hers')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {tab('package', t('Pacchetto', 'Package'))}
          {tab('prepaid', t('Già pagato', 'Prepaid'))}
        </div>
      </div>
      {mode === 'package' ? (
        <PackageForm packages={packages} services={services} form={pkgForm} setForm={setPkgForm} t={t} lang={lang}
          onAdd={(pkg) => { onAddPackage(pkg); setPkgForm({ packageId: '' }); }} />
      ) : (
        <PrepaidForm services={services} form={prepaidForm} setForm={setPrepaidForm} t={t} lang={lang}
          onAdd={(service, sessions, amt) => { onAddPrepaid(service, sessions, amt); setPrepaidForm(blankPrepaid()); }} />
      )}
    </div>
  );
}
