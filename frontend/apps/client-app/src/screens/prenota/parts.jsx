// parts.jsx — i pezzi della prenotazione che servono a più passi.
import { Icon, fmtDur, fmtEur } from '@youty/shared';
import { catIcon, svcLangName } from '../../lib/catalog.js';
import { STEP_INFO } from './steps.js';

/** La barra dei tre passi (servizio, giorno e ora, conferma). */
export function StepBar({ i, t }) {
  return (
    <div style={{ padding: '10px 22px 20px' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
        {[0, 1, 2].map((n) => (
          <div key={n} style={{ flex: 1, height: 4, borderRadius: 99, background: n <= i ? 'var(--brand)' : 'var(--hair)', transition: 'background 220ms' }} />
        ))}
      </div>
      <div className="t-meta" style={{ color: 'var(--brand-ink)' }}>{t('Passo', 'Step')} {i + 1} {t('di', 'of')} 3 · {t(STEP_INFO[i][0], STEP_INFO[i][1])}</div>
    </div>
  );
}

/* recap chip on later steps. Fuori dal render: definito lì dentro era un
 * componente nuovo a ogni render, rifatto da capo ogni volta. */
export function SummaryChip({ svcs, dur, price, lang }) {
  const s = svcs[0];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--brand-tint)', marginBottom: 18 }}>
      <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--paper-0)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Icon name={catIcon(s?.catName)} size={19} color="var(--brand-ink)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--brand-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {svcs.map((sv) => svcLangName(sv, lang)).join(' + ')}
        </div>
        <div className="t-sm" style={{ color: 'var(--brand-ink)', opacity: 0.72 }}>{fmtDur(dur)} · {fmtEur(price, lang)}</div>
      </div>
    </div>
  );
}

/* «Numero già registrato»: o la scheda c'è ed è attiva (il codice chiesto
 * poco fa è arrivato davvero, basta inserirlo) o è disattivata e da qui non
 * si entra. Non potendo distinguere, si dicono entrambe le cose. La
 * prenotazione scelta resta dov'è: qui si spiega solo come sbloccarsi. */
export function BlockedNotice({ t, brand }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 15, borderRadius: 'var(--r-md)', background: 'var(--danger-tint)', border: '1.5px solid var(--danger)' }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <Icon name="alert" size={18} color="var(--danger)" />
        <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink-2)', flex: 1 }}>
          {t('Questo numero è già in anagrafica: se hai ricevuto il codice, inseriscilo qui sotto. Se non ti arriva nulla la scheda potrebbe non essere attiva: contatta il salone per riattivarla — la prenotazione che hai scelto resta qui.',
            'This number is already on file: if you got the code, enter it below. If nothing arrives your profile may not be active: contact the salon to reactivate it — the booking you picked stays here.')}
        </div>
      </div>
      {brand.phone && (
        <a href={`tel:${brand.phone}`} className="btn btn--brand press" style={{ textDecoration: 'none' }}>
          <Icon name="phone" size={16} color="var(--brand-on)" />{t('Chiama il salone', 'Call the salon')}
        </a>
      )}
    </div>
  );
}
