// DayGrid — multi-operator day timeline 08:00–20:00.
// Ogni SERVIZIO di una visita è un blocco a sé, nella colonna della sua operatrice,
// all'orario concatenato dallo start della visita, colorato per categoria di servizio.
// Drag di un blocco = sposta QUEL servizio, da solo: un'operatrice in ritardo
// passa un trattamento alla collega senza altri passaggi. Per muovere tutta la
// visita insieme si trascina la spina scura sul bordo sinistro, che è lì a
// mostrare quali blocchi sono la stessa visita. Trascinando il bordo inferiore
// si modifica la durata di QUEL servizio. Le pause restano blocchi
// spostabili/ridimensionabili.
//
// Feedback durante il drag: traccia tratteggiata dell'origine, colonna di
// destinazione evidenziata, badge con orario di arrivo. Niente indicatore al
// passaggio del mouse: chi lavora in salone conosce i propri orari, e la
// striscia sotto il cursore era solo rumore su una griglia già piena.
import React, { useEffect, useRef, useState } from 'react';
import { Avatar, Icon, fmtDur, timeLabel, statusMeta } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import {
  DK_START, DK_END, PXM, COLW, aStartMin, aEndMin, svcLabel, hmToMin, fmtMoney,
  initialsOf, firstName, lastName, opDisplay, itemBlocks, visitSpines, laneLayout, laneCss, explainSlot, GRID_LINE_STYLE, gridMarks,
} from './lib.js';

export default function DayGrid({
  rows, allRows, date, nowMin, colorOf, itemColor, pending, canWrite, showRevenue,
  picker, setPicker, setOpColor, opPalette, pickMode,
  onHover, onLeave, onOpenAppt, onSlotMenu, onInvalidDrop, onDropOnDate, onDragChange, onSplitItem,
  onMoveAppt, onResizeItem, onMovePause, onResizePause, onDeletePause,
}) {
  const { t, lang, settings, modal } = useDash();
  /* Appuntamento aperto nel pannello di dettaglio: il suo blocco resta cerchiato
   * in agenda, così si vede sempre su cosa si sta intervenendo. */
  const openApptId = modal?.name === 'apptdetail' ? (modal.props?.appointment?.id ?? null) : null;
  const step = settings?.slot_interval_min || 15;   // granularità fasce orarie (Impostazioni)
  const drag = useRef(null);
  const justDragged = useRef(false);                 // sopprime il click che segue un rilascio
  const [, force] = useState(0);
  const scrollRef = useRef(null);

  const hours = []; for (let h = 8; h <= 20; h++) hours.push(h);
  const marks = gridMarks(step);                     // ora piena / mezz'ora / quarti (solo passo 15)
  const gridH = (DK_END - DK_START) * PXM;
  /* `rows` = le colonne da disegnare (le chip delle operatrici spente non ci
   * sono). `dataRows` = TUTTE le righe del giorno: i conti vanno fatti su
   * quelle, perché un appuntamento è elencato una volta sola nella riga
   * dell'operatrice principale mentre i suoi servizi possono essere di altre.
   * Con i soli dati visibili, spegnere una chip nascondeva il lavoro delle
   * colleghe dentro le visite rimaste e faceva dire «Disponibile» a uno slot
   * occupato — ci si prenotava sopra davvero. */
  const dataRows = allRows || rows;
  const ops = rows.map((r) => r.operator);
  const opFirsts = ops.map((o) => firstName(o.name)); // disambiguazione omonimie
  const rowOf = (opId) => dataRows.find((r) => r.operator.id === opId);
  const opName = (opId) => firstName(rowOf(opId)?.operator?.name || '');

  // tutti i blocchi-servizio del giorno (ogni appuntamento compare una volta nel payload)
  const allBlocks = dataRows.flatMap((r) => r.appointments).flatMap((a) => itemBlocks(a));
  const allPauses = dataRows.flatMap((r) => r.pauses);

  useEffect(() => () => document.body.classList.remove('dk-dragging'), []);
  /* Aprendo il dettaglio, il suo blocco viene portato in vista: può stare a
   * un'ora che in quel momento non è sullo schermo, e il contesto serviva
   * proprio lì. */
  useEffect(() => {
    if (!openApptId) return;
    const el = scrollRef.current?.querySelector(`[data-appt="${openApptId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [openApptId]);
  // Esc annulla il drag in corso
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && drag.current) { drag.current = null; document.body.classList.remove('dk-dragging'); force((x) => x + 1); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Operatrice sotto il puntatore, o null se si è usciti dalla griglia.
   * Senza il null (prima si "agganciava" alla colonna di bordo) trascinare
   * fuori per annullare riassegnava l'appuntamento alla prima o all'ultima
   * operatrice, e il rilascio partiva davvero. */
  function colFromX(clientX) {
    const grid = scrollRef.current?.querySelector('.dk-tl-cols');
    if (!grid || !ops.length) return null;
    const r = grid.getBoundingClientRect();
    if (clientX < r.left || clientX >= r.right) return null;
    const colW = r.width / ops.length;
    const idx = Math.max(0, Math.min(ops.length - 1, Math.floor((clientX - r.left) / colW)));
    return ops[idx].id;
  }

  /** Giorno della striscia sotto (x, y), con un margine di tolleranza. */
  function dropDate(x, y) {
    let best = null;
    document.querySelectorAll('[data-daydrop]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const pad = 4;   // le pillole sono piccole: un po' di margine aiuta la mira
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
        best = el.getAttribute('data-daydrop');
      }
    });
    return best;
  }

  function beginDrag(e, d) {
    drag.current = { ...d, cx: e.clientX, cy: e.clientY, pointerId: e.pointerId };
    try { scrollRef.current?.setPointerCapture?.(e.pointerId); } catch { /* non supportato */ }
  }

  // Drag di un blocco-servizio → muove QUEL servizio e basta.
  // Prima muoveva tutta la visita e per spostarne uno solo bisognava prima
  // capire le forbici, poi staccare, poi spostare: tre gesti per la cosa più
  // frequente della giornata (l'operatrice è in ritardo, un trattamento passa
  // alla collega). Ora il singolo servizio è il caso normale e la visita
  // intera si muove dalla spina (`whole`), che è anche il segno di cosa tiene
  // insieme i blocchi.
  function onItemDown(e, block, { whole = false } = {}) {
    if (!canWrite) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Con un servizio solo «staccare» non vuol dire niente: è la visita.
    const detach = !whole && (block.appt.items || []).length > 1;
    beginDrag(e, {
      kind: 'item', apptId: block.apptId, itemId: block.item.id, block, detach,
      startY: e.clientY, orig: block.startMin, origOp: block.opId,
      apptStart: aStartMin(block.appt), ns: block.startMin, nop: block.opId, moved: false,
    });
  }
  // Trascinamento bordo inferiore → durata di QUEL servizio
  function onItemResizeDown(e, block) {
    if (!canWrite) return;
    e.preventDefault(); e.stopPropagation();
    beginDrag(e, {
      kind: 'item', mode: 'resize', apptId: block.apptId, itemId: block.item.id, block,
      startY: e.clientY, orig: block.startMin, origDur: block.activeMin, ndur: block.activeMin, moved: false,
    });
  }
  function onPauseDown(e, pause) {
    if (!canWrite) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    beginDrag(e, {
      kind: 'pause', id: pause.id, obj: pause, startY: e.clientY,
      orig: aStartMin(pause), origOp: pause.operator_id, ns: aStartMin(pause), nop: pause.operator_id, moved: false,
    });
  }
  function onPauseResizeDown(e, pause) {
    if (!canWrite) return;
    e.preventDefault(); e.stopPropagation();
    beginDrag(e, {
      kind: 'pause', mode: 'resize', id: pause.id, obj: pause, startY: e.clientY,
      orig: aStartMin(pause), origDur: pause.duration_min, ndur: pause.duration_min, moved: false,
    });
  }

  /* esito del rilascio, calcolato sui dati in pagina (stesse regole del backend) */
  function validateDrag(d) {
    if (!d || d.mode === 'resize') return null;
    if (d.kind === 'pause') {
      const row = rowOf(d.nop);
      return row ? explainSlot(row, d.ns, d.obj.duration_min, { excludePauseId: d.id, t, rows: dataRows }) : null;
    }
    const appt = d.block.appt;
    const multi = (appt.items || []).length > 1;
    if (d.detach) {
      // Si muove solo questo servizio: validarlo come se si spostasse tutta la
      // visita dava un verdetto su uno spostamento che non sta avvenendo, e lo
      // stacco veniva rifiutato senza che succedesse niente.
      const row = rowOf(d.nop);
      if (!row) return null;
      return explainSlot(row, d.ns, d.block.activeMin || d.block.dur, {
        excludeItemId: d.itemId, sameClientId: appt.client?.id ?? null, nowMin, t, rows: dataRows,
      });
    }
    const delta = d.ns - d.orig;
    let warn = null;
    for (const b of itemBlocks(appt)) {
      const opId = !multi && b.item.id === d.itemId ? d.nop : b.opId;
      const row = rowOf(opId);
      if (!row) continue;
      // `nowMin` anche qui: senza, il badge del drag diceva «Disponibile» su un
      // orario già passato mentre il menu sullo stesso slot lo vietava.
      const r = explainSlot(row, b.startMin + delta, b.activeMin || b.dur, { excludeApptId: appt.id, sameClientId: appt.client?.id ?? null, nowMin, t, rows: dataRows });
      if (!r.ok) return r;
      if (r.code === 'soak') warn = r;
    }
    return warn || { ok: true, code: 'ok', label: t('Disponibile', 'Available'), detail: '' };
  }

  function onMove(e) {
    if (!drag.current) return;
    const d = drag.current;
    d.cx = e.clientX; d.cy = e.clientY;
    if (d.mode === 'resize') {
      const dy = e.clientY - d.startY;
      let nd = Math.round((d.origDur + dy / PXM) / 5) * 5;
      nd = Math.max(5, Math.min(DK_END - d.orig, nd));
      d.ndur = nd; d.moved = d.moved || Math.abs(dy) > 2;
      force((x) => x + 1);
      return;
    }
    const dy = e.clientY - d.startY;
    let ns = Math.round((d.orig + dy / PXM) / step) * step;
    ns = Math.max(DK_START, Math.min(DK_END - step, ns));
    const nop = colFromX(e.clientX) ?? d.origOp;
    d.ns = ns; d.nop = nop;
    const wasMoved = d.moved;
    d.moved = d.moved || Math.abs(dy) > 4 || nop !== d.origOp;
    if (d.moved && !wasMoved) { document.body.classList.add('dk-dragging'); onLeave && onLeave(); onDragChange && onDragChange(true); }
    if (d.moved) d.verdict = validateDrag(d);
    force((x) => x + 1);
  }

  function endDrag() {
    const d = drag.current;
    drag.current = null;
    document.body.classList.remove('dk-dragging');
    onDragChange && onDragChange(false);
    force((x) => x + 1);
    return d;
  }
  function onCancel() { endDrag(); }

  function onUp() {
    const d = endDrag();
    if (!d) return;
    if (d.mode === 'resize') {
      if (d.moved && d.ndur !== d.origDur) {
        if (d.kind === 'item') onResizeItem(d.block.appt, d.block.item, d.ndur);
        else onResizePause(d.obj, d.ndur);
      }
      return;
    }
    if (!d.moved) {
      // click semplice: apre il dettaglio (il click nativo è soppresso per non
      // aprirlo anche dopo un vero trascinamento)
      if (d.kind === 'item') { onLeave && onLeave(); onOpenAppt(d.block.appt); }
      return;
    }
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
    // Rilascio sopra la striscia dei giorni: in vista giorno non esiste un'altra
    // colonna dove portare l'appuntamento, e spostarlo a domani voleva dire
    // aprirlo e passare da «Riprogramma». I giorni in alto fanno da bersaglio.
    // Il bersaglio si cerca confrontando i rettangoli, non con elementFromPoint:
    // quello restituisce ciò che sta in cima nel punto esatto, e basta un
    // pixel di stacco fra una pillola e l'altra per farlo cadere nel vuoto.
    const dayTarget = dropDate(d.cx, d.cy);
    if (dayTarget && onSplitItem && d.kind === 'item' && d.detach) {
      // Le forbici staccano QUEL servizio, anche quando lo si lascia su un
      // altro giorno: il controllo sul bersaglio «giorno» veniva prima di
      // guardare d.detach, e il rilascio sulla pillola spostava l'INTERA
      // visita senza staccare niente (l'avviso diceva pure «Spostato a...»).
      // Orario e operatrice restano quelli di partenza: salendo sulla striscia
      // il cursore esce dalla griglia e non indica né un'ora né una colonna.
      onSplitItem(d.block.appt, d.block.item, d.orig, d.origOp, { dateIso: dayTarget });
      return;
    }
    if (dayTarget && onDropOnDate && d.kind === 'item') {
      // Orario ORIGINALE: salendo sulla striscia il cursore esce dalla griglia e
      // l'ora si schiaccerebbe all'inizio del tabellone. Chi trascina su un
      // giorno sta dicendo «stesso orario, altro giorno».
      onDropOnDate(d.block.appt, dayTarget, d.apptStart);
      return;
    }
    if (d.ns === d.orig && d.nop === d.origOp) return;
    // Intenzione di spostamento, calcolata una volta sola: la usa il ramo valido
    // e viene passata anche al rilascio non valido, così il padre può offrire
    // «Sposta comunque» (POST con force) senza rifare i conti.
    let intent;
    if (d.kind === 'item' && d.detach) {
      intent = { kind: 'split', appt: d.block.appt, item: d.block.item, startMin: d.ns, opId: d.nop };
    } else if (d.kind === 'item') {
      // la visita si sposta così che il servizio trascinato finisca dove lasciato
      const appt = d.block.appt;
      const newApptStart = d.apptStart + (d.ns - d.orig);
      const multi = (appt.items || []).length > 1;
      const opArg = multi ? appt.operator_id : d.nop; // riassegnazione operatrice solo su visita mono-servizio
      intent = { kind: 'appt', appt, newApptStart, opArg };
    } else {
      intent = { kind: 'pause', pause: d.obj, startMin: d.ns, opId: d.nop };
    }
    const verdict = validateDrag(d);
    if (verdict && !verdict.ok) {
      onInvalidDrop && onInvalidDrop(verdict, d, intent); // i primi due argomenti restano quelli di prima
      return; // il blocco torna al suo posto: nessuna chiamata al server
    }
    if (intent.kind === 'split') onSplitItem(intent.appt, intent.item, intent.startMin, intent.opId);
    else if (intent.kind === 'appt') onMoveAppt(intent.appt, intent.newApptStart, intent.opArg);
    else onMovePause(intent.pause, intent.startMin, intent.opId);
  }

  /* posizione: ghost del drag attivo > override ottimistico (pending) > valore server */
  const itemPos = (block) => {
    const d = drag.current;
    const phases = { activeMin: block.activeMin, soakMin: block.soakMin };
    if (d && d.kind === 'item' && d.apptId === block.apptId && d.mode !== 'resize' && d.moved) {
      if (d.detach) {
        // stacco: gli altri servizi della visita restano dove sono
        if (d.itemId !== block.item.id) return { startMin: block.startMin, opId: block.opId, ...phases };
        return { startMin: d.ns, opId: d.nop, ...phases, dragging: true, verdict: d.verdict };
      }
      // sposta tutti i blocchi della stessa visita del delta trascinato
      const startMin = d.itemId === block.item.id ? d.ns : block.startMin + (d.ns - d.orig);
      const opId = d.itemId === block.item.id ? ((block.appt.items || []).length > 1 ? block.opId : d.nop) : block.opId;
      return { startMin, opId, ...phases, dragging: true, verdict: d.verdict };
    }
    if (d && d.kind === 'item' && d.mode === 'resize' && d.apptId === block.apptId) {
      // durante il resize cambia SOLO il tempo attivo; la posa resta
      if (d.itemId === block.item.id) return { startMin: block.startMin, opId: block.opId, activeMin: d.ndur, soakMin: block.soakMin, resizing: true };
      // I servizi di una visita sono concatenati: allungando il primo, quelli
      // dopo slittano. Lasciandoli fermi l'anteprima mostrava una visita che il
      // server non avrebbe mai scritto (e una finta sovrapposizione).
      if (block.startMin > d.orig) return { startMin: block.startMin + (d.ndur - d.origDur), opId: block.opId, ...phases };
      return { startMin: block.startMin, opId: block.opId, ...phases };
    }
    if (pending && pending.kind === 'appt' && pending.id === block.apptId) {
      return { startMin: pending.startMin + (block.startMin - aStartMin(block.appt)), opId: (block.appt.items || []).length > 1 ? block.opId : pending.opId, ...phases };
    }
    return { startMin: block.startMin, opId: block.opId, ...phases };
  };
  const pausePos = (p) => {
    const d = drag.current;
    if (d && d.kind === 'pause' && d.id === p.id && d.mode !== 'resize' && d.moved) return { startMin: d.ns, opId: d.nop, dragging: true, verdict: d.verdict };
    if (d && d.kind === 'pause' && d.id === p.id && d.mode === 'resize') return { startMin: aStartMin(p), opId: p.operator_id, dur: d.ndur, resizing: true };
    if (pending && pending.kind === 'pause' && pending.id === p.id) return { startMin: pending.startMin, opId: pending.opId, dur: pending.dur };
    return { startMin: aStartMin(p), opId: p.operator_id };
  };

  const d = drag.current;
  const dragging = d && d.moved && d.mode !== 'resize';
  // Nessuno slot è vietato: fuori turno, sovrapposizione e fase di posa sono
  // AVVISI, non divieti. Chi sta al banco incastra dove vuole — il rilascio
  // «non valido» finisce in onInvalidDrop, che scrive lo stesso forzando — e il
  // rosso raccontava un blocco che non esiste. Il tono massimo è l'ambra.
  const verdictTone = (v) => (!v ? '' : v.ok && v.code !== 'soak' ? 'ok' : 'warn');

  return (
    <div
      ref={scrollRef} className="scroll" style={{ flex: 1, overflow: 'auto', position: 'relative' }}
      onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
    >
      {/* operator header (sticky top) */}
      <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 9, background: 'var(--paper)', gap: 0, paddingBottom: 8, borderBottom: '1px solid var(--hair)' }}>
        <div style={{ width: 64, flexShrink: 0, position: 'sticky', left: 0, zIndex: 11, background: 'var(--paper)' }} />
        <div style={{ flex: 1, display: 'flex', gap: 6, paddingRight: 4 }}>
          {rows.map((row) => {
            const o = row.operator;
            const cnt = row.appointments.length;
            const rev = row.appointments.reduce((s, a) => s + Number(a.total_price || 0), 0);
            const col = colorOf(o.id);
            const onShift = (row.windows || []).length > 0;
            const isTarget = dragging && d.nop === o.id;
            return (
              <div key={o.id} title={o.name + (onShift ? ' · ' + t('turno', 'shift') + ' ' + (row.windows || []).map(([a, b]) => `${a}–${b}`).join(', ') : ' · ' + t('non in turno', 'not on shift'))} style={{ flex: '1 0 ' + COLW + 'px', padding: '10px 11px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, borderRadius: '0 0 12px 12px', background: col, position: 'relative', outline: isTarget ? '2px solid var(--ink)' : 'none', outlineOffset: -2, transition: 'outline 100ms', opacity: onShift ? 1 : 0.7 }}>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <Avatar initials={initialsOf(o.name)} size={34} color={col} ring />
                  <span title={onShift ? t('In turno', 'On shift') : t('Non in turno', 'Off today')} style={{ position: 'absolute', bottom: -1, right: -1, width: 11, height: 11, borderRadius: 99, background: onShift ? 'var(--ok)' : 'var(--faint)', border: '2px solid #fff' }} />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div title={o.name} style={{ fontWeight: 700, fontSize: 20, whiteSpace: 'nowrap', color: 'var(--ink)', letterSpacing: '-0.015em', lineHeight: 1.05, overflow: 'hidden', textOverflow: 'ellipsis' }}>{opDisplay(firstName(o.name), lastName(o.name), opFirsts)}</div>
                  <div style={{ color: 'var(--ink)', opacity: 0.6, fontSize: 11.5, fontWeight: 500, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {onShift
                      ? `${cnt}${showRevenue ? ' · ' + fmtMoney(rev, lang) : ''}`
                      : t('Non in turno', 'Off today')}
                  </div>
                </div>
                <button onClick={() => setPicker(picker === o.id ? null : o.id)} title={t('Cambia colore', 'Change colour')} style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, cursor: 'pointer', display: 'grid', placeItems: 'center', border: 'none', background: 'rgba(255,255,255,0.55)' }}>
                  <Icon name="palette" size={14} color="var(--ink)" />
                </button>
                {picker === o.id && (
                  <React.Fragment>
                    <div onClick={() => setPicker(null)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
                    <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 6, zIndex: 61, padding: 12, boxShadow: 'var(--sh-pop)', width: 250, boxSizing: 'border-box' }}>
                      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Colore operatrice', 'Stylist colour')}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                        <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: col }}>
                          <input type="color" value={(col && col[0] === '#') ? col : '#C9B8F2'} onChange={(e) => setOpColor(o.id, e.target.value)} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                        </label>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 8px', background: 'var(--surface)' }}>
                          <span style={{ color: 'var(--muted-2)', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 12.5 }}>#</span>
                          <input value={((col && col[0] === '#') ? col : '').replace('#', '').toUpperCase()} maxLength={6} placeholder="C9B8F2" onChange={(e) => { const v = e.target.value.replace(/[^0-9a-fA-F]/g, ''); setOpColor(o.id, '#' + v.padEnd(6, '0').slice(0, 6)); }} style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 12.5, width: 64, letterSpacing: '0.05em' }} />
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 3 }}>
                        {(opPalette || []).map((c) => {
                          const on = (col || '').toLowerCase() === c.toLowerCase();
                          return <button key={c} onClick={() => { setOpColor(o.id, c); setPicker(null); }} title={c} style={{ width: 19, height: 19, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid transparent', outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1 }} />;
                        })}
                      </div>
                    </div>
                  </React.Fragment>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* grid body */}
      <div style={{ display: 'flex', position: 'relative', height: gridH }}>
        {/* hour gutter (sticky left) */}
        <div style={{ width: 64, flexShrink: 0, position: 'sticky', left: 0, zIndex: 7, background: 'var(--paper)' }}>
          {/* etichette in grassetto centrate sulla riga (line-height 14 → -7) + tacca che la prolunga nel gutter */}
          {hours.map((h) => (
            <React.Fragment key={h}>
              <div style={{ position: 'absolute', top: (h * 60 - DK_START) * PXM - 7, right: 10, fontSize: 11, lineHeight: '14px', fontWeight: 700, color: 'var(--muted)' }} className="tabnum">{String(h).padStart(2, '0')}:00</div>
              <div style={{ position: 'absolute', top: (h * 60 - DK_START) * PXM, right: 0, width: 6, ...GRID_LINE_STYLE.hour }} />
              {h < 20 && <div style={{ position: 'absolute', top: (h * 60 + 30 - DK_START) * PXM - 6, right: 10, fontSize: 9.5, lineHeight: '12px', fontWeight: 600, color: 'var(--muted-2)' }} className="tabnum">{String(h).padStart(2, '0')}:30</div>}
            </React.Fragment>
          ))}
        </div>
        {/* columns */}
        <div className="dk-tl-cols" style={{ flex: 1, display: 'flex', position: 'relative', gap: 6, paddingRight: 4 }}>
          {/* righe orarie: z-index 1 = sopra lo sfondo opaco delle colonne (prima le copriva),
              sotto i blocchi (z 2); pointer-events none per non disturbare drag e click */}
          {marks.map(({ m, kind }) => <div key={m} style={{ position: 'absolute', left: 0, right: 0, top: (m - DK_START) * PXM, zIndex: 1, pointerEvents: 'none', ...GRID_LINE_STYLE[kind] }} />)}
          {/* passato (solo oggi): velo leggero — non si prenota indietro nel tempo */}
          {nowMin != null && nowMin > DK_START && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: (Math.min(nowMin, DK_END) - DK_START) * PXM, background: 'rgba(17,24,39,0.035)', pointerEvents: 'none', zIndex: 3, borderRadius: '12px 12px 0 0' }} />
          )}
          {nowMin != null && nowMin >= DK_START && nowMin <= DK_END && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: (nowMin - DK_START) * PXM, height: 2, background: '#F4708A', zIndex: 8, pointerEvents: 'none' }}>
              <span style={{ position: 'absolute', left: -6, top: -5, width: 12, height: 12, borderRadius: 99, background: '#F4708A', boxShadow: '0 0 0 3px rgba(244,112,138,0.2)' }} />
              <span className="tabnum" style={{ position: 'absolute', right: 6, top: -8, fontSize: 10, fontWeight: 800, color: '#F4708A', background: 'var(--paper)', padding: '0 4px', borderRadius: 4 }}>{timeLabel(nowMin)}</span>
            </div>
          )}
          {rows.map((row) => {
            const o = row.operator;
            const closed = closedIntervals(row.windows);
            const isTarget = dragging && d.nop === o.id;
            const tone = isTarget ? verdictTone(d.verdict) : '';
            return (
              <div
                key={o.id}
                className={isTarget ? (tone === 'warn' ? 'dk-col--target-warn' : 'dk-col--target') : ''}
                title={undefined}
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (justDragged.current || drag.current) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const raw = DK_START + (e.clientY - rect.top) / PXM;
                  const snapped = Math.max(DK_START, Math.min(DK_END - step, Math.floor(raw / step) * step));
                  onSlotMenu(o.id, snapped, e.clientX, e.clientY, explainSlot(row, snapped, step, { nowMin, t, rows: dataRows }));
                }}
                style={{ flex: '1 0 ' + COLW + 'px', position: 'relative', minWidth: 0, borderRadius: 12, background: `color-mix(in srgb, ${colorOf(o.id)} 26%, #FFFFFF)`, cursor: canWrite ? (pickMode ? 'pointer' : 'copy') : 'default', transition: 'box-shadow 120ms' }}
              >
                {closed.map(([s, e2], i) => (
                  <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: (s - DK_START) * PXM, height: (e2 - s) * PXM, pointerEvents: 'none', borderRadius: 10, background: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--paper) 70%, transparent) 0 6px, transparent 6px 12px)', zIndex: 1 }}>
                    {(e2 - s) * PXM > 46 && (
                      <span className="dk-closed-label" style={{ top: '50%', transform: 'translateY(-50%)' }}>
                        {(row.windows || []).length ? t('Fuori turno', 'Off shift') : t('Non in turno', 'Off today')}
                      </span>
                    )}
                  </div>
                ))}
                {/* traccia dell'origine durante il drag.
                    Con le forbici si muove UN servizio: la traccia sotto tutti
                    quelli della visita faceva sembrare che partisse tutta,
                    mentre gli altri restano fermi davvero (vedi itemPos). */}
                {dragging && d.kind === 'item' && itemBlocks(d.block.appt).filter((b) => b.opId === o.id && (!d.detach || b.item.id === d.itemId)).map((b) => (
                  <div key={'g' + b.item.id} className="dk-drag-ghost" style={{ top: (b.startMin - DK_START) * PXM + 1.5, height: b.dur * PXM - 3 }} />
                ))}
                {dragging && d.kind === 'pause' && d.origOp === o.id && (
                  <div className="dk-drag-ghost" style={{ top: (d.orig - DK_START) * PXM + 1.5, height: d.obj.duration_min * PXM - 3 }} />
                )}
                {/* Corsie: due appuntamenti sovrapposti (un incastro forzato) devono
                    stare AFFIANCATI. Disegnati a tutta larghezza, il secondo copriva
                    il primo e l'incastro diventava impossibile da leggere. */}
                {(() => {
                  const placed = laneLayout(
                    allBlocks.filter((b) => itemPos(b).opId === o.id).map((b) => ({ b, pos: itemPos(b) })),
                  );
                  return (
                    <React.Fragment>
                      {/* Spina della visita: una barra sul bordo sinistro che copre tutti
                          i servizi dello stesso appuntamento in questa colonna. Sta qui e
                          non dentro le card perché ogni servizio ha il colore della sua
                          categoria — due barre diverse non legano niente — e perché i
                          3 px di stacco fra le card la spezzerebbero. */}
                      {visitSpines(placed).map((sp) => {
                        // La spina è anche la MANIGLIA della visita: premendo qui
                        // si trascinano insieme tutti i servizi, mentre il corpo
                        // di un blocco ne muove uno solo. Serve un blocco di
                        // riferimento per far partire il drag: va bene il primo
                        // della visita in questa colonna.
                        const ref = placed.find(({ b }) => b.apptId === sp.apptId);
                        const tall = (sp.endMin - sp.startMin) * PXM > 46;
                        return (
                          <div key={'sp' + sp.apptId}
                            onPointerDown={ref && canWrite ? (e) => onItemDown(e, ref.b, { whole: true }) : undefined}
                            title={t(`Un'unica visita di ${sp.client}: ${sp.count} servizi · trascina qui per spostarli tutti insieme`, `One visit for ${sp.client}: ${sp.count} services · drag here to move them all together`)}
                            style={{
                              position: 'absolute', ...laneCss(sp.lane, sp.laneCount, 12),
                              top: (sp.startMin - DK_START) * PXM + 1.5,
                              height: (sp.endMin - sp.startMin) * PXM - 3,
                              background: 'rgba(17,24,39,0.55)', borderRadius: '12px 0 0 12px',
                              pointerEvents: dragging || !canWrite ? 'none' : 'auto',
                              cursor: canWrite ? 'grab' : 'default', touchAction: 'none',
                              display: 'grid', placeItems: 'center', gap: 3, alignContent: 'center',
                              zIndex: 4,
                            }}>
                            {tall && [0, 1, 2].map((i) => (
                              <span key={i} style={{ width: 3, height: 3, borderRadius: 99, background: 'rgba(255,255,255,0.75)' }} />
                            ))}
                          </div>
                        );
                      })}
                      {/* service blocks (each in its operator's column) */}
                      {placed.map(({ b, pos, lane, laneCount }) => (
                        <ItemBlock
                          key={'i' + b.item.id} block={b} startMin={pos.startMin} activeMin={pos.activeMin} soakMin={pos.soakMin}
                          lane={lane} laneCount={laneCount}
                          dragging={pos.dragging} tone={pos.dragging ? verdictTone(pos.verdict) : ''} t={t} lang={lang} canWrite={canWrite}
                          highlight={b.apptId === openApptId}
                          color={itemColor ? itemColor(b.item) : colorOf(b.opId)}
                          onDown={(e) => onItemDown(e, b)}
                          onResizeDown={(e) => onItemResizeDown(e, b)}
                          onHover={dragging ? null : onHover} onLeave={onLeave}
                          onSlotMenu={(startMin, x, y) => onSlotMenu(o.id, startMin, x, y, explainSlot(row, startMin, step, { nowMin, t, rows: dataRows }))}
                        />
                      ))}
                    </React.Fragment>
                  );
                })()}
                {/* pauses */}
                {allPauses.filter((p) => pausePos(p).opId === o.id).map((p) => {
                  const pos = pausePos(p);
                  return (
                    <PauseBlock
                      key={'p' + p.id} p={p} startMin={pos.startMin} dur={pos.dur ?? p.duration_min} dragging={pos.dragging} tone={pos.dragging ? verdictTone(pos.verdict) : ''} t={t} lang={lang}
                      canWrite={canWrite}
                      onDown={(e) => onPauseDown(e, p)}
                      onResizeDown={(e) => onPauseResizeDown(e, p)}
                      onRemove={() => onDeletePause(p)}
                    />
                  );
                })}
              </div>
            );
          })}
          {!rows.length && (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessuna operatrice attiva', 'No active staff')}</div>
            </div>
          )}
        </div>
      </div>

      {/* badge che segue il cursore durante il drag: orario di arrivo + esito */}
      {dragging && (() => {
        const v = d.verdict;
        const tone = verdictTone(v);
        // Uno STACCO muove un servizio solo: durata della visita intera,
        // orario d'inizio della visita e nome dell'operatrice di partenza
        // annunciavano tutt'altro rispetto a quel che sarebbe arrivato al
        // server («Anna 13:15-14:45» per un 14:00-14:45 su Giulia).
        const detach = d.kind === 'item' && !!d.detach;
        const durMin = d.kind === 'pause' ? d.obj.duration_min
          : detach ? d.block.dur
            : (d.block.appt.total_duration_min || d.block.dur);
        const start = (d.kind === 'pause' || detach) ? d.ns : d.apptStart + (d.ns - d.orig);
        // la nota «operatrice fissa» non vale per lo stacco: lì la riassegnazione
        // avviene davvero.
        const multi = d.kind === 'item' && !detach && (d.block.appt.items || []).length > 1;
        const who = multi ? opName(d.origOp) : opName(d.nop);
        return (
          <div className={'dk-drag-badge' + (tone === 'warn' ? ' dk-drag-badge--warn' : '')} style={{ top: d.cy + 18, left: d.cx + 18 }}>
            <Icon name={tone === 'warn' ? 'alert' : 'check'} size={14} color="#fff" stroke={2.6} />
            <span className="tabnum">{timeLabel(start)}–{timeLabel(start + durMin)}</span>
            <span>· {who}</span>
            {v && <small>· {v.label}</small>}
            {multi && d.nop !== d.origOp && <small>· {t('visita multi-servizio: operatrice fissa', 'multi-service visit: stylist fixed')}</small>}
          </div>
        );
      })()}
    </div>
  );
}

/* closed (off-shift) intervals within the grid, from API windows [["09:00","13:00"],...] */
function closedIntervals(windows) {
  const win = (windows || []).map(([a, b]) => [hmToMin(a), hmToMin(b)]).sort((x, y) => x[0] - y[0]);
  const out = [];
  let cursor = DK_START;
  win.forEach(([s, e]) => {
    if (s > cursor) out.push([cursor, Math.min(s, DK_END)]);
    cursor = Math.max(cursor, e);
  });
  if (cursor < DK_END) out.push([cursor, DK_END]);
  return out.filter(([s, e]) => e > s);
}

const TONE_BORDER = { ok: 'var(--ok)', warn: 'var(--warn)' };

/* ---------- service block (one per AppointmentService) ---------- */
function ItemBlock({ block, startMin, activeMin, soakMin, lane = 0, laneCount = 1, dragging, tone, color, highlight = false, t, lang, canWrite, onDown, onResizeDown, onHover, onLeave, onSlotMenu }) {
  const { item, appt, isFirst, isLast, index } = block;
  const active = activeMin ?? block.activeMin ?? 0;
  const soak = soakMin ?? block.soakMin ?? 0;
  const h = (active + soak) * PXM;
  const compact = h < 50;
  const narrow = laneCount > 1;
  // Visita con più servizi: senza un segno che li lega, in agenda si vedono
  // due riquadri identici a due appuntamenti diversi della stessa cliente, e
  // non si capisce né che sono una cosa sola né che si possono staccare.
  const total = (appt.items || []).length;
  const grouped = total > 1;
  const bg = `color-mix(in srgb, ${color} 82%, #FFFFFF)`;
  const sm = statusMeta(appt.status, t);
  const showStatusDot = appt.status === 'checked_in' || appt.status === 'in_progress';
  const textZ = { position: 'relative', zIndex: 2 };
  return (
    <div
      data-appt={appt.id}
      onPointerDown={(e) => onDown(e)}
      onContextMenu={(e) => {
        // Sopra un appuntamento il clic sinistro apre quello esistente, quindi
        // non c'era modo di dire «qui»: il tasto destro apre il menu dello slot
        // a quell'ora, da cui si incastra una cliente sopra un'altra.
        if (!onSlotMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onSlotMenu(startMin, e.clientX, e.clientY);
      }}
      title={grouped
        ? t(`Visita di ${appt.client?.full_name || ''} · servizio ${index + 1} di ${total}: trascina per spostare solo questo, o trascina la barra scura a sinistra per spostare tutta la visita`,
            `${appt.client?.full_name || ''}'s visit · service ${index + 1} of ${total}: drag to move just this one, or drag the dark bar on the left to move the whole visit`)
        : undefined}
      onMouseEnter={(e) => onHover && onHover(appt, e.currentTarget)} onMouseLeave={() => onLeave && onLeave()}
      style={{
        position: 'absolute', top: (startMin - DK_START) * PXM + 1.5, height: h - 3,
        // Mentre si trascina il blocco torna a tutta larghezza: deve restare
        // leggibile sopra gli altri.
        ...(dragging ? { left: 4, right: 4 } : laneCss(lane, laneCount)),
        background: bg, borderRadius: 12, border: dragging ? `2px solid ${TONE_BORDER[tone] || 'var(--ink)'}` : 'none',
        boxShadow: dragging ? 'var(--sh-pop)' : highlight ? '0 0 0 2.5px var(--ink), 0 6px 18px rgba(17,24,39,0.18)' : '0 1px 3px rgba(17,24,39,0.12)',
        zIndex: highlight && !dragging ? 3 : undefined, padding: compact ? '3px 9px' : '7px 11px', overflow: 'hidden',
        cursor: canWrite ? 'grab' : 'pointer', touchAction: 'none', zIndex: dragging ? 20 : 2, transform: dragging ? 'scale(1.03)' : 'none',
        opacity: appt.status === 'no_show' ? 0.5 : dragging ? 0.92 : 1, transition: dragging ? 'none' : 'box-shadow 150ms',
        display: 'flex', flexDirection: compact ? 'row' : 'column', alignItems: compact ? 'baseline' : 'stretch', gap: compact ? 6 : 0,
      }}
    >
      {/* fase di posa: parte inferiore tratteggiata/più chiara — operatrice NON impegnata */}
      {soak > 0 && (
        <div title={t('Fase di posa', 'Soak phase')} style={{ position: 'absolute', left: 0, right: 0, top: active * PXM, bottom: 0, background: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.62) 0 6px, rgba(255,255,255,0.14) 6px 12px)', borderTop: '1px dashed rgba(17,24,39,0.28)', borderRadius: '0 0 12px 12px', pointerEvents: 'none', display: 'grid', placeItems: 'center', zIndex: 1 }}>
          {soak * PXM > 20 && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--ink-2)', opacity: 0.7 }}>{t('POSA', 'SOAK')}</span>}
        </div>
      )}
      {isFirst && appt.deposit_status === 'paid' && (
        <div title={t('Caparra incassata', 'Deposit collected')} style={{ position: 'absolute', top: 5, right: 5, width: 22, height: 22, borderRadius: 7, background: 'var(--surface)', border: '1.5px solid var(--ok)', display: 'grid', placeItems: 'center', boxShadow: '0 1px 2px rgba(17,24,39,0.12)', zIndex: 3 }}>
          <Icon name="wallet" size={13} color="var(--ok)" stroke={2} />
        </div>
      )}
      <div style={{ ...textZ, fontWeight: 600, fontSize: 12.5, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.25, flex: compact ? 1 : 'none', minWidth: 0, paddingLeft: grouped ? 14 : 0, paddingRight: !compact && isFirst && appt.deposit_status === 'paid' ? 24 : 0 }}>{item.service_name}</div>
      <div style={{ ...textZ, display: 'flex', alignItems: 'center', gap: 5, marginTop: compact ? 0 : 1, flexShrink: 0 }}>
        {showStatusDot && <span title={sm.label} style={{ width: 7, height: 7, borderRadius: 99, background: sm.color, flexShrink: 0 }} />}
        <span className="tabnum" style={{ fontSize: 11, fontWeight: 500, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{timeLabel(startMin)}{dragging ? '–' + timeLabel(startMin + active + soak) : ''}</span>
        {grouped && (
          <span className="tabnum" style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.02em', color: 'var(--ink-2)', background: 'rgba(255,255,255,0.62)', borderRadius: 5, padding: '1px 4px', flexShrink: 0 }}>{index + 1}/{total}</span>
        )}
      </div>
      {!compact && <div style={{ ...textZ, color: 'var(--muted)', fontSize: 11, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{appt.client?.full_name}</div>}
      {canWrite && !dragging && (
        <div className="dk-resize-handle" onPointerDown={onResizeDown} title={t('Trascina per cambiare il tempo attivo', 'Drag to change the active time')} style={{ position: 'absolute', left: 0, right: 0, top: soak > 0 ? active * PXM - 5 : undefined, bottom: soak > 0 ? undefined : 0, height: 9, cursor: 'ns-resize', display: 'grid', placeItems: 'center', touchAction: 'none', zIndex: 3 }}>
          <div style={{ width: 26, height: 3, borderRadius: 99, background: 'rgba(17,24,39,0.35)' }} />
        </div>
      )}
    </div>
  );
}

/* ---------- pause (break) block — hatched, movable, resizable ---------- */
function PauseBlock({ p, startMin, dur, dragging, tone, t, canWrite, onDown, onResizeDown, onRemove }) {
  const bh = dur * PXM;
  const bCompact = bh < 44;
  return (
    <div
      onPointerDown={(e) => onDown(e)}
      style={{
        position: 'absolute', top: (startMin - DK_START) * PXM + 1.5, height: bh - 3,
        ...(dragging ? { left: 4, right: 4 } : laneCss(0, 1)),
        borderRadius: 12, border: dragging ? `2px solid ${TONE_BORDER[tone] || 'var(--ink)'}` : '1.5px dashed var(--pewter-300, #B6B4BB)',
        background: 'repeating-linear-gradient(135deg, rgba(120,120,128,0.13) 0 7px, rgba(120,120,128,0.04) 7px 14px)',
        boxShadow: dragging ? 'var(--sh-pop)' : 'none', padding: bCompact ? '3px 9px' : '7px 11px', overflow: 'hidden',
        cursor: canWrite ? 'grab' : 'default', touchAction: 'none', zIndex: dragging ? 20 : 2,
        display: 'flex', flexDirection: bCompact ? 'row' : 'column', alignItems: bCompact ? 'center' : 'stretch', gap: bCompact ? 6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: bCompact ? 1 : 'none', minWidth: 0 }}>
        <Icon name="clock" size={13} color="var(--pewter-500, #6F6E74)" />
        <span style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--pewter-700, #45444A)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('Pausa', 'Break')}{p.note ? ' · ' + p.note : ''}</span>
      </div>
      <span className="tabnum" style={{ fontSize: 11, fontWeight: 500, color: 'var(--pewter-500, #6F6E74)', flexShrink: 0 }}>{timeLabel(startMin)}–{timeLabel(startMin + dur)}</span>
      {canWrite && !dragging && (
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }} onPointerDown={(e) => e.stopPropagation()} title={t('Rimuovi pausa', 'Remove break')} style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.7)', cursor: 'pointer', display: bCompact ? 'none' : 'grid', placeItems: 'center', zIndex: 4 }}>
          <Icon name="x" size={12} color="var(--pewter-500, #6F6E74)" />
        </button>
      )}
      {canWrite && !dragging && (
        <div className="dk-resize-handle" onPointerDown={onResizeDown} title={t('Ridimensiona', 'Resize')} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 9, cursor: 'ns-resize', display: 'grid', placeItems: 'center', touchAction: 'none' }}>
          <div style={{ width: 26, height: 3, borderRadius: 99, background: 'var(--pewter-500, #6F6E74)' }} />
        </div>
      )}
    </div>
  );
}

/* ---------- appointment hover card ---------- */
export function ApptHoverCard({ hover, t, lang, operators, colorOf, hints = 'day' }) {
  const { a, x, y, side } = hover;
  const o = operators.find((op) => op.id === a.operator_id);
  const opName = o ? o.first_name + ' ' + o.last_name : ((a.items || [])[0]?.operator_name || '');
  const col = colorOf(a.operator_id);
  const startMin = aStartMin(a), endMin = aEndMin(a);
  return (
    <div style={{ position: 'fixed', top: y, left: side === 'right' ? x : undefined, right: side === 'left' ? (window.innerWidth - x) : undefined, zIndex: 90, width: 300, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 14, boxShadow: 'var(--sh-pop)', padding: 16, pointerEvents: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Avatar initials={initialsOf(a.client?.full_name)} size={38} color={col} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{a.client?.full_name}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{opName}</div>
        </div>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: col, flexShrink: 0 }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <Icon name="scissors" size={15} color="var(--muted-2)" style={{ marginTop: 1, flexShrink: 0 }} />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{svcLabel(a)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Icon name="clock" size={15} color="var(--muted-2)" style={{ flexShrink: 0 }} />
          <span className="tabnum" style={{ fontSize: 13.5 }}>{timeLabel(startMin)}–{timeLabel(endMin)}</span>
          <span className="t-sm" style={{ color: 'var(--muted-2)' }}>· {fmtDur(endMin - startMin, lang)}</span>
        </div>
        {a.client?.phone && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon name="phone" size={15} color="var(--muted-2)" style={{ flexShrink: 0 }} />
            <span className="tabnum" style={{ fontSize: 13.5 }}>{a.client.phone}</span>
          </div>
        )}
        {a.note && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 2, padding: '9px 11px', background: 'var(--warn-tint)', borderRadius: 10 }}>
            <Icon name="info" size={15} color="var(--warn)" style={{ marginTop: 1, flexShrink: 0 }} />
            <span className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.4 }}>{a.note}</span>
          </div>
        )}
        {/* In settimana non si ridimensiona: prometterlo sarebbe una bugia. */}
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2, fontSize: 11.5 }}>
          {hints === 'week'
            ? t('Clic: dettaglio · Trascina: sposta, anche su un altro giorno', 'Click: details · Drag: move, to another day too')
            : t('Clic: dettaglio · Trascina: sposta questo servizio · Barra a sinistra: tutta la visita', 'Click: details · Drag: move this service · Left bar: the whole visit')}
        </div>
      </div>
    </div>
  );
}
