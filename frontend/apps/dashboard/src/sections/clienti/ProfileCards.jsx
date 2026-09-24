// ProfileCards.jsx — i riquadri della scheda cliente sotto le etichette
// (ClientProfile): i numeri (visite, valore totale, scontrino medio,
// affidabilità), l'anagrafica e la lingua preferita.
import { Icon, fmtEur, fmtEurOrZero } from '@youty/shared';
import { ProfStat, RelRing } from './components.jsx';
import { relMeta, formatBirthday, dateLabel } from './helpers.js';
import { genderLabel } from '../../ui/GenderPicker.jsx';

/* KPIs (visits / total_spent / avg ticket from ClientDetailOut) */
export function ProfileKpis({ c, t, lang }) {
  const score = c.reliability ?? 100;
  const rel = relMeta(score, t);
  const visits = c.visits || 0;
  const totalSpent = Number(c.total_spent || 0);
  // Il backend azzera visite e speso a chi non ha il permesso «vendite». Senza
  // distinguere i due casi, una cliente storica sembrava alla prima visita e
  // rischiava di vedersi chiedere la caparra da chi non poteva saperlo.
  const statsHidden = !!c.stats_hidden;
  const hiddenNote = t('Richiede il permesso vendite', 'Requires the sales permission');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, marginBottom: 14 }}>
      <ProfStat label={t('Visite', 'Visits')} value={statsHidden ? '—' : visits} hint={statsHidden ? hiddenNote : null} />
      <ProfStat label={t('Valore totale', 'Lifetime value')}
        value={statsHidden ? '—' : fmtEurOrZero(totalSpent, lang)}
        hint={statsHidden ? hiddenNote : null} />
      {/* niente Math.round: con 2 visite e 95,00 € lo scontrino medio è
          47,50 €, non 48 € — e il «Valore totale» qui accanto dice 95,00 € */}
      <ProfStat label={t('Scontrino medio', 'Avg ticket')}
        value={statsHidden ? '—' : (totalSpent ? fmtEur(totalSpent / Math.max(1, visits), lang) : '€0')}
        hint={statsHidden ? hiddenNote : null} />
      <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('Affidabilità', 'Reliability')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <RelRing score={score} color={rel.color} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: rel.color }}>{rel.label}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Punteggio', 'Score')} {score}/100</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* anagrafica: tutto ciò che si può modificare, con il percorso per farlo */
export function ProfileDetails({ c, canWrite, openEdit, t, lang }) {
  return (
    <div className="dk-card" style={{ padding: '14px 16px', marginBottom: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div className="t-meta">{t('Anagrafica', 'Personal details')}</div>
        <div style={{ flex: 1 }} />
        {canWrite && <button onClick={openEdit} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}><Icon name="edit" size={13} color="var(--clay-ink)" />{t('Modifica', 'Edit')}</button>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px 18px' }}>
        {[
          [t('Telefono', 'Phone'), c.phone, 'phone'],
          ['Email', c.email, 'mail'],
          [t('Genere', 'Gender'), genderLabel(c.gender, t), 'user'],
          [t('Compleanno', 'Birthday'), c.birthday ? formatBirthday(c.birthday, lang) + (c.age != null ? ` · ${c.age} ${t('anni', 'y.o.')}` : ` · ${t('anno non indicato', 'no year')}`) : '', 'cake'],
          [t('Come ci ha conosciuto', 'How they found us'), c.origin, 'sparkle'],
          [t('Cliente dal', 'Client since'), c.since ? dateLabel(c.since, lang) : '', 'calendar'],
        ].map(([label, value, icon]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 5 }}><Icon name={icon} size={11} color="var(--muted-2)" />{label}</div>
            {value
              ? <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className={icon === 'phone' ? 'tabnum' : ''}>{value}</div>
              : canWrite
                ? <button onClick={openEdit} style={{ fontSize: 13, fontWeight: 600, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, marginTop: 2 }}>+ {t('aggiungi', 'add')}</button>
                : <div style={{ fontSize: 14, color: 'var(--muted-2)', marginTop: 2 }}>—</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* preferred language — drives automatic WhatsApp messages */
export function LanguageCard({ c, canWrite, updateClient, t }) {
  return (
    <div className="dk-card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', marginBottom: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="whatsapp" size={18} color="#3F9D58" /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Lingua preferita', 'Preferred language')}</div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{t('Tutte le comunicazioni WhatsApp automatiche (conferme, promemoria, post-visita, marketing) usano questa lingua.', 'All automatic WhatsApp messages (confirmations, reminders, post-visit, marketing) use this language.')}</div>
      </div>
      <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', borderRadius: 10, padding: 4, flexShrink: 0 }}>
        {[['it', 'Italiano'], ['en', 'English']].map(([k, l]) => {
          const on = (c.lang || 'it') === k;
          return (
            <button key={k} disabled={!canWrite}
              onClick={() => !on && updateClient({ lang: k }, { msg: k === 'en' ? t('Comunicazioni WhatsApp in inglese', 'WhatsApp messages set to English') : t('Comunicazioni WhatsApp in italiano', 'WhatsApp messages set to Italian'), icon: 'whatsapp' })}
              style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: canWrite ? 'pointer' : 'default', border: 'none', background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--ink)' : 'var(--muted)', boxShadow: on ? 'var(--sh-card)' : 'none' }}>{l}</button>
          );
        })}
      </div>
    </div>
  );
}
