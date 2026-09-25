// Waitlist.jsx — the client's active waitlist requests + leave + join CTA.
// Data: GET /api/agenda/client/waitlist, DELETE /api/agenda/client/waitlist/{id}.
import React from 'react';
import { Icon, toastApiError } from '@youty/shared';
import { useApp } from '../ctx.jsx';
import { getWaitlist, leaveWaitlist } from '../api/client.js';
import { useApiData } from '../hooks/useApiData.js';
import { ClientSubHead } from '../components/ClientSubHead.jsx';
import { Meta } from '../components/Meta.jsx';
import { prefLabel } from '../lib/waitlist.js';
import { fmtDayMed } from '../lib/dates.js';

export default function Waitlist() {
  const { t, lang, brand, setView, fireToast } = useApp();
  // Con la guardia di useApiData: letta a mano, se la cliente tornava indietro
  // prima della risposta e la chiamata falliva, il toast «Errore di rete»
  // compariva sulla schermata dove si trovava intanto (voce 33).
  const { data: list, error, setData: setList } = useApiData(getWaitlist, [], { onError: (e) => toastApiError(e, fireToast, t) });
  // Insieme di id: con un solo id «in rimozione» il primo tocco bloccava in
  // silenzio TUTTE le altre righe — che restavano attive all'aspetto ma non
  // rispondevano più finché la prima richiesta non tornava.
  const [removing, setRemoving] = React.useState(() => new Set());

  const mark = (id, on) => setRemoving((s) => {
    const next = new Set(s);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const remove = async (id) => {
    if (removing.has(id)) return;
    mark(id, true);
    try {
      await leaveWaitlist(id);
      setList((l) => (l || []).filter((w) => w.id !== id));
      fireToast({ msg: t('Richiesta rimossa', 'Request removed'), icon: 'check' });
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally {
      mark(id, false);
    }
  };

  const loading = !list && !error;
  const entries = list || [];

  return (
    <div style={{ paddingBottom: 30 }}>
      <ClientSubHead brand={brand} title={t('Lista d’attesa', 'Waiting list')} onBack={() => setView('profilo')} />
      <div style={{ padding: '8px 22px' }}>
        <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 18 }}>
          {t('Nessuno slot libero quando ti serve? Mettiti in lista: ti avvisiamo su WhatsApp appena si libera un posto.',
            'No free slot when you need it? Join the list: we’ll message you on WhatsApp the moment one opens up.')}
        </div>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            <div className="skel" style={{ height: 110, borderRadius: 'var(--r-md)' }} />
            <div className="skel" style={{ height: 110, borderRadius: 'var(--r-md)' }} />
          </div>
        ) : entries.length > 0 && (
          <React.Fragment>
            <div className="t-meta" style={{ marginBottom: 12 }}>{t('Le tue richieste', 'Your requests')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }} className="stagger">
              {entries.map((w) => (
                <div key={w.id} className="card" style={{ padding: 15, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{w.service_name}</div>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: w.status === 'contacted' ? 'var(--ok-tint)' : 'var(--brand-tint)', color: w.status === 'contacted' ? 'var(--ok)' : 'var(--brand-ink)', flexShrink: 0 }}>
                      {w.status === 'contacted' ? t('Contattata', 'Contacted') : t('In lista', 'Waiting')}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                    <Meta icon="user" text={w.operator_name || t('Qualsiasi operatrice', 'Any stylist')} />
                    <Meta icon="clock" text={prefLabel(w, t, lang)} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
                    <span className="t-sm" style={{ color: 'var(--muted-2)' }}>
                      {t('In lista dal', 'On the list since')} {fmtDayMed(w.created_at, lang)}
                    </span>
                    <button className="press" onClick={() => remove(w.id)} disabled={removing.has(w.id)}
                      style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)', opacity: removing.has(w.id) ? 0.5 : 1 }}>
                      {removing.has(w.id) ? t('Rimozione…', 'Removing…') : t('Rimuovi', 'Remove')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </React.Fragment>
        )}

        <button className="btn btn--brand btn--block press" onClick={() => setView('waitlist-new')}>
          <Icon name="plus" size={17} color="var(--brand-on)" />{t('Aggiungiti alla lista', 'Join the list')}
        </button>
      </div>
    </div>
  );
}
