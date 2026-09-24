// comunicazioni/index.jsx — editorial (discount-free) campaigns, backed by
// GET/POST/PUT/DELETE /api/marketing/communications (+ /{id}/send via Yourang outbox).
// Ported from prototype desktop-comunicazioni.jsx. The prototype's TYPE taxonomy
// (launch/seasonal/story/announce) has no API field and was dropped; status filter,
// search, cards, composer and WhatsApp preview are kept.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { mediaUrl, Icon, EmptyState, toastApiError } from '@youty/shared';
import { GroupedFilterMenu } from '../../ui/index.js';
import { useDash, useLive } from '../../ctx.jsx';
import ComEditModal from './ComEditModal.jsx';
import SendConfirmModal from './SendConfirmModal.jsx';
import { COM_STATUS_KEYS, audienceSummary, comStatusMeta, comWhenLabel } from './helpers.js';
import { communicationsApi } from '../../api/marketing.js';

const PAGE = 24;

export default function ComunicazioniSection() {
  const { t, lang, clientCategories, hasScope, fireToast } = useDash();
  const canWrite = hasScope('marketing');

  /* ---- list state ---- */
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusF, setStatusF] = useState('all');
  const [q, setQ] = useState('');

  /* ---- modals (local — 'comunicazioni' has no registry modals) ---- */
  const [edit, setEdit] = useState(null);       // null | 'new' | CommunicationOut
  const [sendFor, setSendFor] = useState(null); // null | CommunicationOut

  /* Biglietto della richiesta in corso: cambiando lo stato del filtro mentre
   * «Carica altre» è in volo, la risposta vecchia veniva appesa alla lista
   * nuova. Ogni fetch incrementa il biglietto e scarta la propria risposta se
   * nel frattempo ne è partita un'altra. */
  const reqSeq = useRef(0);
  const fetchList = useCallback(async ({ append = false, offset = 0 } = {}) => {
    const seq = ++reqSeq.current;
    append ? setLoadingMore(true) : setLoading(true);
    try {
      const res = await communicationsApi.list({ status: statusF === 'all' ? '' : statusF, limit: PAGE, offset });
      if (seq !== reqSeq.current) return;
      setCount(res.count || 0);
      setItems((prev) => (append ? [...prev, ...(res.items || [])] : (res.items || [])));
    } catch (err) {
      if (seq !== reqSeq.current) return;
      toastApiError(err, fireToast, t);
    } finally {
      append ? setLoadingMore(false) : setLoading(false);
    }
  }, [statusF, fireToast, t]);

  useEffect(() => { fetchList(); }, [fetchList]);
  useLive(/^communication\./, () => fetchList());

  const refetch = useCallback(() => fetchList(), [fetchList]);

  // La ricerca è lato client (l'endpoint non ha il parametro q): guarda solo
  // le campagne già scaricate. Va detto a video, e «Carica altre» deve restare
  // disponibile anche durante la ricerca — altrimenti una campagna di Natale
  // oltre la prima pagina risultava inesistente, senza alcun indizio.
  const needle = q.trim().toLowerCase();
  const list = needle
    ? items.filter((c) => (c.title || '').toLowerCase().includes(needle) || (c.body || '').toLowerCase().includes(needle))
    : items;
  const more = items.length < count;

  /* ---- mutation callbacks: close modal, refetch ---- */
  const onSaved = () => { setEdit(null); refetch(); };
  const onDeleted = () => { setEdit(null); refetch(); };
  const onSendRequest = (comm) => { setEdit(null); setSendFor(comm); };
  const onSent = () => { setSendFor(null); refetch(); };

  return (
    <div className="dk-page" style={{ maxWidth: 1180 }}>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16, maxWidth: 720 }}>
        {t('Campagne editoriali senza sconto: lancio di nuovi servizi, comunicazioni stagionali, storytelling del brand. Pensate per un posizionamento premium, dove il messaggio conta più della promozione.',
           'Discount-free editorial campaigns: service launches, seasonal notes, brand storytelling. Built for a premium positioning, where the message matters more than the promotion.')}
      </div>

      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 0, width: 'auto' }}>
          <Icon name="search" size={18} color="var(--muted-2)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca una comunicazione…', 'Search a communication…')} />
          {q && (
            <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center', background: 'transparent' }}>
              <Icon name="x" size={15} color="var(--muted-2)" />
            </button>
          )}
        </div>
        <GroupedFilterMenu t={t} groups={[{
          label: t('Stato', 'Status'),
          value: statusF,
          set: setStatusF,
          opts: [['all', t('Tutti', 'All')], ...COM_STATUS_KEYS.map((k) => [k, comStatusMeta(k, t).label])],
        }]} />
        {canWrite && (
          <button className="dk-btn dk-btn--clay" onClick={() => setEdit('new')} style={{ flexShrink: 0 }}>
            <Icon name="plus" size={17} color="#fff" />{t('Nuova comunicazione', 'New communication')}
          </button>
        )}
      </div>

      {/* grid */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {[...Array(6)].map((_, i) => <div key={i} className="skel" style={{ height: 218, borderRadius: 16 }} />)}
        </div>
      ) : list.length ? (
        <React.Fragment>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
            {list.map((c) => (
              <ComCard key={c.id} comm={c} t={t} lang={lang} clientCategories={clientCategories}
                canWrite={canWrite} onOpen={() => setEdit(c)} onSend={() => setSendFor(c)} />
            ))}
          </div>
          {more && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 20 }}>
              {needle && (
                <span className="t-sm" style={{ color: 'var(--muted)' }}>
                  {t(`La ricerca guarda solo le ${items.length} campagne caricate di ${count}.`, `The search only covers the ${items.length} loaded campaigns out of ${count}.`)}
                </span>
              )}
              <button className="dk-btn dk-btn--ghost" disabled={loadingMore} onClick={() => fetchList({ append: true, offset: items.length })}>
                {loadingMore ? t('Caricamento…', 'Loading…') : t('Carica altre', 'Load more') + ` (${items.length}/${count})`}
              </button>
            </div>
          )}
        </React.Fragment>
      ) : (
        <div className="dk-card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '48px 22px' }}>
            <EmptyState icon="message"
              title={needle || statusF !== 'all' ? t('Nessun risultato', 'No results') : t('Nessuna comunicazione', 'No communications')}
              sub={needle && more
                ? t(`Nessuna corrispondenza fra le ${items.length} campagne caricate di ${count}: carica le altre e riprova.`, `No match among the ${items.length} loaded campaigns out of ${count}: load the rest and try again.`)
                : needle || statusF !== 'all'
                  ? t('Prova a cambiare ricerca o filtri.', 'Try changing search or filters.')
                  : t('Crea la prima campagna editoriale del salone.', 'Create the salon’s first editorial campaign.')}
              action={needle && more ? (loadingMore ? t('Caricamento…', 'Loading…') : t('Carica altre', 'Load more')) : undefined}
              onAction={needle && more ? () => fetchList({ append: true, offset: items.length }) : undefined} />
          </div>
        </div>
      )}

      {edit && (
        <ComEditModal comm={edit === 'new' ? null : edit} onClose={() => setEdit(null)}
          onSaved={onSaved} onDeleted={onDeleted} onSend={onSendRequest} />
      )}
      {sendFor && <SendConfirmModal comm={sendFor} onClose={() => setSendFor(null)} onSent={onSent} />}
    </div>
  );
}

/* ---- campaign card ---- */
function ComCard({ comm, t, lang, clientCategories, canWrite, onOpen, onSend }) {
  const st = comStatusMeta(comm.status, t);
  const img = comm.image_url ? mediaUrl(comm.image_url) : null;
  return (
    <div className="dk-card dk-hovercard" onClick={onOpen} style={{ padding: 0, overflow: 'hidden', borderLeft: '3px solid ' + st.color }}>
      {/* cover */}
      <div style={{ height: 96, background: img ? `center/cover url(${img})` : st.tint, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', padding: 14, gap: 8 }}>
        {/* Solo sulle bozze: il backend rifiuta l'invio di una campagna gia
            programmata (andrebbe rinviata all'infinito, accodando un invio in
            piu ogni volta). Per cambiarle data si passa da «Modifica», che la
            riporta in bozza e annulla l'invio gia in coda. */}
        {canWrite && comm.status === 'draft' && (
          <button
            title={t('Invia…', 'Send…')}
            onClick={(e) => { e.stopPropagation(); onSend(); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--surface)', border: '1px solid var(--hair)', padding: '4px 10px', borderRadius: 99, cursor: 'pointer' }}>
            <Icon name="send" size={12} color="var(--clay-ink)" />{t('Invia', 'Send')}
          </button>
        )}
        {canWrite && comm.status === 'scheduled' && (
          <span title={t('Per cambiare data apri la campagna e modificala', 'To change the date, open the campaign and edit it')}
            style={{ fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--surface)', border: '1px solid var(--hair)', padding: '4px 10px', borderRadius: 99 }}>
            {t('Modifica per riprogrammare', 'Edit to reschedule')}
          </span>
        )}
        <span style={{ fontSize: 11, fontWeight: 700, color: st.color, background: 'var(--surface)', padding: '4px 10px', borderRadius: 99 }}>{st.label}</span>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 15.5, lineHeight: 1.25 }}>{comm.title || t('(senza titolo)', '(untitled)')}</div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 36 }}>{comm.body}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)', flexWrap: 'wrap' }}>
          <span className="t-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}>
            <Icon name="clients" size={13} color="var(--muted-2)" />{audienceSummary(comm, clientCategories, t)}
          </span>
          {comm.status === 'scheduled' && comm.scheduled_at && (
            <span className="t-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--info)', fontWeight: 600 }}>
              <Icon name="clock" size={13} color="var(--info)" />{comWhenLabel(comm.scheduled_at, lang)}
            </span>
          )}
          {comm.status === 'sent' && comm.sent_at && (
            <span className="t-sm" style={{ marginLeft: 'auto', color: 'var(--muted-2)' }}>{comWhenLabel(comm.sent_at, lang)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
