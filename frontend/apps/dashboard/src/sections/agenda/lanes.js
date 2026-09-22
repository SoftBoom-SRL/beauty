// lanes.js — geometria delle corsie in agenda: dove finisce ogni blocco quando
// due appuntamenti si sovrappongono, e dove passa la spina di una visita
// multi-servizio. Sono funzioni pure, SENZA import: così si possono provare con
// `node --test` senza tirarsi dietro React e il resto della dashboard
// (vedi apps/dashboard/test/lanes.test.js).

/** Corsie per i blocchi sovrapposti di una colonna.
 *
 *  Prende [{b, pos}] e restituisce gli stessi elementi con `lane` e `laneCount`.
 *  Due appuntamenti sulla stessa operatrice alla stessa ora — l'incastro che lo
 *  staff forza a mano — venivano disegnati entrambi a tutta larghezza: il
 *  secondo copriva il primo, e dell'appuntamento sotto restava visibile solo il
 *  nome della cliente che spuntava. I servizi della STESSA visita restano
 *  sempre nella stessa corsia, altrimenti una visita lunga si spezzerebbe fra
 *  due colonne diverse.
 */
export function laneLayout(placed) {
  const span = ({ b, pos }) => {
    const startMin = pos.startMin;
    const endMin = startMin + (pos.activeMin ?? b.activeMin ?? 0) + (pos.soakMin ?? b.soakMin ?? 0);
    return { startMin, endMin };
  };
  // Estensione di ogni visita nella colonna: la corsia si assegna per visita.
  const visits = new Map();
  for (const item of placed) {
    const { startMin, endMin } = span(item);
    const cur = visits.get(item.b.apptId);
    if (cur) {
      cur.startMin = Math.min(cur.startMin, startMin);
      cur.endMin = Math.max(cur.endMin, endMin);
    } else {
      visits.set(item.b.apptId, { apptId: item.b.apptId, startMin, endMin });
    }
  }
  const sorted = [...visits.values()].sort((x, y) => x.startMin - y.startMin || y.endMin - x.endMin);
  const lanes = new Map();   // apptId → corsia
  const counts = new Map();  // apptId → quante corsie nel suo gruppo
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    for (const v of cluster) {
      let l = laneEnds.findIndex((e) => e <= v.startMin);
      if (l === -1) { l = laneEnds.length; laneEnds.push(v.endMin); } else laneEnds[l] = v.endMin;
      lanes.set(v.apptId, l);
    }
    const n = Math.max(1, laneEnds.length);
    for (const v of cluster) counts.set(v.apptId, n);
    cluster = [];
  };
  for (const v of sorted) {
    if (cluster.length && v.startMin >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(v);
    clusterEnd = Math.max(clusterEnd, v.endMin);
  }
  flush();
  return placed.map((item) => ({
    ...item,
    lane: lanes.get(item.b.apptId) || 0,
    laneCount: counts.get(item.b.apptId) || 1,
  }));
}

/** Corridoio libero sul lato destro della colonna.
 *
 *  Valeva 22 px, per lasciare dove cliccare accanto a un appuntamento. Ma i
 *  blocchi restavano schiacciati a sinistra con una fascia vuota sempre
 *  presente, e la colonna sembrava mal disegnata. Ora i blocchi riempiono la
 *  colonna: per prenotare sopra un appuntamento c'è il tasto destro sul blocco,
 *  che apre il menu dello slot a quell'ora.
 */
export const COL_GUTTER = 0;

/** left/width di una corsia dentro la colonna (4 px di margine, 3 px fra corsie). */
export function laneCss(lane = 0, laneCount = 1, fixedWidth = null) {
  const right = 4 + COL_GUTTER;
  if (laneCount <= 1) {
    return fixedWidth ? { left: 4, width: fixedWidth } : { left: 4, right };
  }
  const slot = `((100% - ${4 + right}px) / ${laneCount})`;
  const left = `calc(4px + ${lane} * ${slot})`;
  return fixedWidth ? { left, width: fixedWidth } : { left, width: `calc(${slot} - 3px)` };
}

/** Spine delle visite multi-servizio in una colonna.
 *
 *  Prende i blocchi già posizionati di UNA operatrice e restituisce, per ogni
 *  appuntamento con più di un servizio, l'intervallo coperto lì dentro. Serve a
 *  disegnare una barra sola: in agenda due servizi della stessa cliente erano
 *  due riquadri identici a due appuntamenti distinti, e non si capiva né che
 *  fossero una cosa sola né che si potessero staccare.
 */
export function visitSpines(placed) {
  const byAppt = new Map();
  for (const placedItem of placed) {
    const { b, pos } = placedItem;
    if (((b.appt.items || []).length) < 2) continue;
    const start = pos.startMin;
    const end = start + (pos.activeMin ?? b.activeMin ?? 0) + (pos.soakMin ?? b.soakMin ?? 0);
    const cur = byAppt.get(b.apptId);
    if (cur) {
      cur.startMin = Math.min(cur.startMin, start);
      cur.endMin = Math.max(cur.endMin, end);
      cur.count += 1;
    } else {
      byAppt.set(b.apptId, {
        apptId: b.apptId, startMin: start, endMin: end, count: 1,
        client: b.appt.client?.full_name || '',
        lane: placedItem.lane || 0, laneCount: placedItem.laneCount || 1,
      });
    }
  }
  // Una barra ha senso solo se in questa colonna ci sono almeno due servizi
  // della stessa visita: con uno solo non c'è niente da legare.
  return [...byAppt.values()].filter((sp) => sp.count > 1);
}

/** Bande di un blocco settimana, una per servizio della visita.
 *
 *  In vista settimana una visita è UN riquadro: due o tre servizi dentro non si
 *  vedevano, e un contatore da solo non basta a farli leggere. Qui si ricavano
 *  le fasce in percentuale sull'altezza del blocco, così il riquadro si può
 *  dividere come nella vista giorno.
 *
 *  Ritorna [] quando i servizi sono meno di due: non c'è niente da dividere.
 */
export function serviceBands(appt) {
  const items = (appt?.items || []).filter(Boolean);
  if (items.length < 2) return [];
  const spans = items.map((it) => Math.max(1, (it.duration_min || 0) + (it.soak_min || 0)));
  const total = spans.reduce((s, x) => s + x, 0);
  const bands = [];
  let acc = 0;
  items.forEach((it, i) => {
    const from = (acc / total) * 100;
    acc += spans[i];
    bands.push({
      name: it.service_name || '',
      service_id: it.service_id ?? null,   // per tingere la fascia col colore della categoria
      opId: it.operator_id ?? null,
      fromPct: from,
      toPct: (acc / total) * 100,
      minutes: spans[i],
    });
  });
  return bands;
}
