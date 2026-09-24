// WhoCancels — nell'annullamento, chi l'ha chiesto: il salone, o la cliente
// che ha disdetto (al telefono: sotto le ore minime l'app la manda dal
// salone). La cliente ha le regole dell'app — in ritardo la caparra resta al
// salone —, e sotto si dice che cosa succederà alla caparra.
import React from 'react';
import { lateCancel } from '../../lib.js';

export default function WhoCancels({ appt, cancelByClient, setCancelByClient, cancelMinHours, t }) {
  return (
    <React.Fragment>
      <div className="t-meta" style={{ marginBottom: 9 }}>{t('Chi annulla', 'Who is cancelling')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {[[false, t('Il salone', 'The salon')], [true, t('La cliente, che ha disdetto', 'The client, who cancelled')]].map(([k, label]) => {
          const on = cancelByClient === k;
          return <button key={String(k)} type="button" onClick={() => setCancelByClient(k)} style={{ padding: '8px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{label}</button>;
        })}
      </div>
      <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.45, marginBottom: 16 }}>
        {!cancelByClient
          ? t('Il salone non può tenere la visita: la caparra torna alla cliente, senza penali.', 'The salon cannot keep the appointment: the deposit goes back to the client, with no penalty.')
          : lateCancel(appt, cancelMinHours)
            ? t(`Mancano meno di ${cancelMinHours} ore: come dall'app, la caparra resta al salone e la disdetta si segna come tardiva nella scheda della cliente.`, `Less than ${cancelMinHours} hours to go: as in the app, the salon keeps the deposit and the cancellation is marked late on the client's profile.`)
            : t(`Mancano più di ${cancelMinHours} ore: la caparra torna alla cliente, come dall'app.`, `More than ${cancelMinHours} hours to go: the deposit goes back to the client, as in the app.`)}
      </div>
    </React.Fragment>
  );
}
