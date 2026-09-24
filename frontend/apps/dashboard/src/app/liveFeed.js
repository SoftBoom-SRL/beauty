// app/liveFeed.js — il feed live della dashboard: stream SSE dal server, con un
// polling di riserva. Lo usa DashboardProvider (ctx.jsx), che lo espone come
// `live`; le sezioni ci si agganciano con `useLive(prefissi, fn)`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activityApi } from '../api/core.js';
import { createSeen } from '../liveSeen.js';

/* ---- dati sempre aggiornati ----------------------------------------------------
 * Polling leggero di GET /api/core/activity/feed (ogni LIVE_POLL_MS mentre la
 * scheda è visibile, subito al ritorno in primo piano). Funziona con gunicorn
 * sync in Docker senza connessioni persistenti. NON è un sistema di notifiche:
 * quando un'altra postazione cambia qualcosa, le viste che mostrano quel dato
 * si ricaricano in silenzio, così sullo schermo c'è sempre lo stato reale.
 * Le sezioni si agganciano con `useLive(prefissi, fn)`; i cataloghi base del
 * contesto (operatrici, servizi, categorie, impostazioni) si aggiornano da sé
 * (useLiveCatalogs in useCatalogs.js). */
const LIVE_POLL_MS = 3000;          // polling di riserva quando lo stream non è connesso
const LIVE_POLL_STREAM_MS = 30000;  // con lo stream attivo: solo un controllo di coerenza
const LIVE_KEEP = 40;

/** → { events, unread, markRead, subscribe, version, streamOk }, un oggetto nuovo
 *  a ogni consegna (`subscribe` resta lo stesso). */
export function useLiveFeed(session) {
  const cursor = useRef(0);
  const booted = useRef(false);   // dopo il primo giro `after` viaggia sempre, anche se 0
  const listeners = useRef(new Set());
  const [events, setEvents] = useState([]);   // più recenti prima
  const [unread, setUnread] = useState(0);
  const [version, setVersion] = useState(0);  // cambia quando arrivano eventi di altri
  const [streamOk, setStreamOk] = useState(false);
  const streamOkRef = useRef(false);
  const seen = useRef(null);
  if (!seen.current) seen.current = createSeen();
  const myId = session?.user?.id;

  /* consegna comune (stream o polling): aggiorna cursore, lista, ascoltatori.
   * Stream e polling possono riconsegnare eventi già arrivati (finestra di
   * sicurezza del server, contratto C20): si scartano per id PRIMA di lista,
   * contatore e ascoltatori, altrimenti la campanella li mostrava due volte, i
   * non letti crescevano da soli e ogni vista si ricaricava due volte. */
  const deliver = useCallback((incoming, newCursor) => {
    cursor.current = Math.max(cursor.current, Number(newCursor) || 0);
    const list = seen.current.fresh(incoming);
    if (!list.length) return;
    setEvents((l) => [...list.slice().reverse(), ...l].slice(0, LIVE_KEEP));
    const foreign = list.filter((e) => e.actor_id !== myId);
    if (foreign.length) { setUnread((n) => n + foreign.length); setVersion((v) => v + 1); }
    listeners.current.forEach((fn) => { try { fn({ events: list, foreign }); } catch { /* listener error */ } });
  }, [myId]);

  /* ---- push dal server: Server-Sent Events ----
   * Una connessione HTTP aperta; il server spinge gli eventi appena scritti
   * (latenza ~1 s, qualunque worker li abbia prodotti). Se cade si riapre con
   * un ticket nuovo; nel frattempo il polling di riserva accelera. */
  useEffect(() => {
    let es = null, alive = true, retry = 3000, timer = null;
    // Un po' di scarto casuale sul ritentativo: quando il server rifiuta gli
    // stream perché ha raggiunto il tetto di connessioni, tutte le postazioni
    // riproverebbero nello stesso istante e lo riempirebbero di nuovo insieme.
    const wait = () => retry + Math.floor(Math.random() * 1500);
    const connect = async () => {
      if (!alive || document.visibilityState !== 'visible') { timer = setTimeout(connect, 2000); return; }
      try {
        const { ticket } = await activityApi.streamTicket();
        if (!alive) return;
        const url = activityApi.streamUrl(ticket, cursor.current || 0);
        es = new EventSource(url);
        es.addEventListener('ready', (ev) => {
          retry = 3000; streamOkRef.current = true; setStreamOk(true); booted.current = true;
          try { const d = JSON.parse(ev.data); cursor.current = Math.max(cursor.current, Number(d.cursor) || 0); } catch { /* ignore */ }
        });
        es.addEventListener('events', (ev) => {
          try { const d = JSON.parse(ev.data); deliver(d.events || [], d.cursor); } catch { /* ignore */ }
        });
        es.addEventListener('bye', () => { es.close(); es = null; if (alive) connect(); }); // riciclo lato server: riapro subito
        es.onerror = () => {
          streamOkRef.current = false; setStreamOk(false);
          es?.close(); es = null;
          if (alive) { timer = setTimeout(connect, wait()); retry = Math.min(retry * 2, 30000); }
        };
      } catch {
        streamOkRef.current = false; setStreamOk(false);
        if (alive) { timer = setTimeout(connect, wait()); retry = Math.min(retry * 2, 30000); }
      }
    };
    connect();
    return () => { alive = false; clearTimeout(timer); es?.close(); streamOkRef.current = false; };
  }, [myId, deliver]);

  const subscribe = useCallback((fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn); }, []);
  const markRead = useCallback(() => setUnread(0), []);

  useEffect(() => {
    let alive = true, timer = null, inflight = false;
    const tick = async () => {
      if (!alive || inflight || document.visibilityState !== 'visible') return;
      inflight = true;
      try {
        const res = await activityApi.feed(booted.current ? { after: cursor.current } : {});
        if (!alive) return;
        const bootstrap = !booted.current;
        booted.current = true;
        const list = bootstrap ? [] : (res.events || []);
        deliver(list, res.cursor);
      } catch { /* silenzioso: riprova al prossimo giro */ } finally { inflight = false; }
    };
    const loop = () => { timer = setTimeout(async () => { await tick(); if (alive) loop(); }, streamOkRef.current ? LIVE_POLL_STREAM_MS : LIVE_POLL_MS); };
    tick(); loop();
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      alive = false; clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [myId, deliver]);

  return useMemo(() => ({ events, unread, markRead, subscribe, version, streamOk }), [events, unread, markRead, subscribe, version, streamOk]);
}
