// BookingFoot — il piede del drawer: che cosa c'è e che cosa manca (cliente,
// servizi, orario: un clic porta al passo), «Annulla» e il pulsante che crea
// la prenotazione, e dice che cosa manca finché non si può.
import React from 'react';
import { Icon, fmtDur, minutesOfDay, timeLabel } from '@youty/shared';
import { firstName, fmtMoney } from '../../lib.js';

export default function BookingFoot({
  client, items, totalDur, totalPrice, selStart, dateLabel, clientRef, svcRef, timeRef, missing, ready, saving, create, onClose, t, lang,
}) {
  return (
    <React.Fragment>
      {/* checklist: cosa manca per poter creare */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10, fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
        {[
          { ok: !!client, label: client ? firstName(client.full_name) : t('Cliente', 'Client'), ref: clientRef },
          { ok: items.length > 0, label: items.length ? t(`${items.length} serviz${items.length === 1 ? 'io' : 'i'} · ${fmtDur(totalDur, lang)}`, `${items.length} service${items.length === 1 ? '' : 's'} · ${fmtDur(totalDur, lang)}`) : t('Servizio', 'Service'), ref: svcRef },
          { ok: !!selStart, label: selStart ? timeLabel(minutesOfDay(selStart)) + ' · ' + dateLabel : t('Orario', 'Time'), ref: timeRef },
        ].map((c, i) => (
          <button key={i} type="button" onClick={() => c.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 99, border: 'none', cursor: 'pointer', background: c.ok ? 'var(--ok-tint)' : 'var(--surface)', color: c.ok ? 'var(--ok)' : 'var(--muted)', boxShadow: c.ok ? 'none' : 'inset 0 0 0 1px var(--hair)' }}>
            <Icon name={c.ok ? 'check' : 'clock'} size={12} stroke={2.6} color={c.ok ? 'var(--ok)' : 'var(--muted-2)'} />{c.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" aria-disabled={!ready} onClick={create} style={{ flex: 1 }} title={missing.length ? t('Manca: ', 'Missing: ') + missing.map((m) => m.label).join(', ') : ''}>
          <Icon name="plus" size={17} color="#fff" />
          {saving ? t('Creazione…', 'Creating…') : missing.length ? t('Manca ', 'Missing ') + missing.map((m) => m.label).join(' · ') : t('Crea prenotazione', 'Create booking') + ' · ' + fmtMoney(totalPrice, lang)}
        </button>
      </div>
    </React.Fragment>
  );
}
