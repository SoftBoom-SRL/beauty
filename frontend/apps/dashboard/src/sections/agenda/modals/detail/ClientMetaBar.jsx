// ClientMetaBar — in cima al dettaglio: la cliente con lo stato della visita,
// «Forzato», i trattamenti già pagati (regalo, pagato in anticipo, pacchetto
// con le sedute), le categorie e lo storico (se c'è), il telefono e il
// bottone per aprirne la scheda.
import { Avatar, Icon } from '@youty/shared';
import { fmtMoney, initialsOf, inkOn } from '../../lib.js';
import { creditIcon, creditLabel, creditTitle } from '../../../fedelta/credits.js';

export default function ClientMetaBar({ appt, sm, clientDetail, t, lang, openClient }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
      <Avatar initials={initialsOf(appt.client?.full_name)} size={40} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: sm.color, background: sm.tint, padding: '3px 9px', borderRadius: 99 }}>{sm.label}</span>
          {appt.forced && <span title={t('Inserito o spostato forzando le regole (fuori turno o sovrapposizione)', 'Inserted or moved overriding the rules (off shift or overlap)')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name="alert" size={11} color="var(--warn)" />{t('Forzato', 'Forced')}</span>}
          {(appt.gifts || []).map((g) => (
            <span key={g.gift_card_id ?? g.code} title={creditTitle(g, t, lang)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name={creditIcon(g)} size={11} color="var(--clay-ink)" />{creditLabel(g, t)}</span>
          ))}
          {(clientDetail?.categories || []).slice(0, 2).map((c) => (
            // il colore pieno dell'etichetta: su una scura il testo bianco
            <span key={c.id} style={{ fontSize: 11, fontWeight: 700, color: inkOn(c.color).sub, background: c.color || 'var(--surface-2)', padding: '3px 9px', borderRadius: 99 }}>{c.name}</span>
          ))}
          {/* Lo storico si scrive solo se c'è: «visite · €0» era una riga che
              non diceva niente, e sulla scheda di una cliente nuova sembrava
              un errore. */}
          {clientDetail?.visits > 0 && <span className="t-sm" style={{ color: 'var(--muted)' }}>{clientDetail.visits} {t('visite', 'visits')} · {fmtMoney(clientDetail.total_spent, lang)}</span>}
        </div>
        {appt.client?.phone && <a href={'tel:' + appt.client.phone} className="tabnum" style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)', textDecoration: 'none' }}>{appt.client.phone}</a>}
      </div>
      <div style={{ flex: 1 }} />
      <button className="dk-btn dk-btn--soft" style={{ height: 38, fontSize: 13, padding: '0 14px' }} onClick={openClient}>{t('Apri scheda cliente', 'Open client')}</button>
    </div>
  );
}
