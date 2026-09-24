// desktop-agenda.jsx — multi-operatrice day timeline + right rail
const { useState: useStateDa, useRef: useRefDa, useEffect: useEffectDa } = React;

const DK_START = 8 * 60, DK_END = 20 * 60;

function DkAgenda() {
  const { t, lang, appts, setAppts, fireToast, openModal, density, opColors, setOpColor, opPalette, svcCats, setTab, setDeepLink, showRevenue } = useDk();
  const [day, setDay] = useStateDa(2);
  const [periodOff, setPeriodOff] = useStateDa(0); // week/month navigation offset
  const MONTHS_IT = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const periodLabel = () => {
    if (calView === 'month') { let m = 10 + periodOff, y = 2025; while (m > 11) { m -= 12; y++; } while (m < 0) { m += 12; y--; } return (lang === 'en' ? MONTHS_EN : MONTHS_IT)[m] + ' ' + y; }
    // week: base week Mon 10 – Sun 16 Nov 2025, shift by 7 days per offset
    const base = new Date(2025, 10, 10); const s = new Date(base); s.setDate(base.getDate() + periodOff * 7); const e = new Date(s); e.setDate(s.getDate() + 6);
    const mo = (lang === 'en' ? MONTHS_EN : MONTHS_IT);
    const sameM = s.getMonth() === e.getMonth();
    return sameM ? `${s.getDate()}–${e.getDate()} ${mo[e.getMonth()]} ${e.getFullYear()}` : `${s.getDate()} ${mo[s.getMonth()].slice(0,3)} – ${e.getDate()} ${mo[e.getMonth()].slice(0,3)} ${e.getFullYear()}`;
  };
  const navPrev = () => { if (calView === 'day') setDay(d => Math.max(0, d - 1)); else setPeriodOff(o => o - 1); };
  const navNext = () => { if (calView === 'day') setDay(d => Math.min(5, d + 1)); else setPeriodOff(o => o + 1); };
  const [colorMode, setColorMode] = useStateDa(() => { try { return localStorage.getItem('dk-agenda-colormode') || 'category'; } catch (e) { return 'category'; } });
  const setColorModeP = (v) => { setColorMode(v); try { localStorage.setItem('dk-agenda-colormode', v); } catch (e) {} };
  const catColor = (catId) => { const c = (svcCats || []).find(x => x.id === catId); return c ? c.color : null; };
  const blockColor = (a) => (catColor((svc((a.serviceIds || [])[0]) || {}).cat) || colorOf(a.opId));
  const [railOpen, setRailOpen] = useStateDa(() => { try { return localStorage.getItem('dk-agenda-rail') !== '0'; } catch (e) { return true; } });
  React.useEffect(() => { try { localStorage.setItem('dk-agenda-rail', railOpen ? '1' : '0'); } catch (e) {} }, [railOpen]);
  const [calView, setCalView] = useStateDa('day'); // day | week | month
  const [jumpOpen, setJumpOpen] = useStateDa(false);
  // current month/year derived from offset (base Nov 2025)
  const curMY = (() => { let m = 10 + (calView === 'month' ? periodOff : 0), y = 2025; if (calView === 'week') { const base = new Date(2025, 10, 10); const s = new Date(base); s.setDate(base.getDate() + periodOff * 7); m = s.getMonth(); y = s.getFullYear(); } while (m > 11) { m -= 12; y++; } while (m < 0) { m += 12; y--; } return { m, y }; })();
  const jumpToMonth = (m, y) => { setCalView('month'); setPeriodOff((y - 2025) * 12 + (m - 10)); setJumpOpen(false); };
  const jumpToDate = (iso) => { if (!iso) return; const d = new Date(iso); setCalView('month'); setPeriodOff((d.getFullYear() - 2025) * 12 + (d.getMonth() - 10)); setJumpOpen(false); };
  const [picker, setPicker] = useStateDa(null); // opId whose colour picker is open
  const [hover, setHover] = useStateDa(null); // { a, x, y, side } appointment hover card
  const onHover = (a, el) => { if (!a) { setHover(null); return; } const r = el.getBoundingClientRect(); const right = r.right + 320 < window.innerWidth; setHover({ a, x: right ? r.right + 10 : r.left - 10, y: Math.min(r.top, window.innerHeight - 240), side: right ? 'right' : 'left' }); };
  const [vis, setVis] = useStateDa(() => { const m = {}; OPS.forEach(o => { m[o.id] = true; }); return m; });
  const PXM = density === 'compatta' ? 1.0 : 1.35;
  const COLW = 158; // min column width before horizontal scroll kicks in
  const visCount = OPS.filter(o => vis[o.id]).length;
  const ops = visCount ? OPS.filter(o => vis[o.id]) : OPS; // columns (never empty)
  const colorOf = (id) => opColors[id] || op(id).color;
  const usedColors = OPS.map(o => colorOf(o.id));
  const toggleVis = (id) => setVis(m => ({ ...m, [id]: !m[id] }));
  const allOn = OPS.every(o => vis[o.id]);
  const setAll = (on) => setVis(() => { const m = {}; OPS.forEach(o => { m[o.id] = on; }); return m; });
  const isToday = day === 2;
  const todays = isToday ? appts : [];
  const drag = useRefDa(null);
  const [, force] = useStateDa(0);
  const [slotMenu, setSlotMenu] = useStateDa(null); // { opId, start, x, y }
  const scrollRef = useRefDa(null);

  const days = [['Lun', 'Mon', 10], ['Mar', 'Tue', 11], ['Mer', 'Wed', 12], ['Gio', 'Thu', 13], ['Ven', 'Fri', 14], ['Sab', 'Sat', 15]];
  const hours = []; for (let h = 8; h <= 20; h++) hours.push(h);
  const quarters = []; for (let m = DK_START; m <= DK_END; m += 15) quarters.push(m);
  const gridH = (DK_END - DK_START) * PXM;

  const revenue = todays.reduce((s, a) => s + apptTotal(a), 0);
  const checkedIn = todays.filter(a => a.status === 'checkin' || a.status === 'corso').length;

  function colFromX(clientX) {
    const grid = scrollRef.current?.querySelector('.dk-tl-cols');
    if (!grid) return null;
    const r = grid.getBoundingClientRect();
    const colW = r.width / ops.length;
    let idx = Math.floor((clientX - r.left) / colW);
    idx = Math.max(0, Math.min(ops.length - 1, idx));
    return ops[idx].id;
  }
  function onDown(e, a) {
    e.preventDefault();
    drag.current = { id: a.id, startY: e.clientY, orig: a.start, origOp: a.opId, ns: a.start, nop: a.opId, moved: false };
  }
  function onMove(e) {
    if (!drag.current) return;
    const d = drag.current;
    if (d.mode === 'resize') {
      const dy = e.clientY - d.startY;
      let nd = Math.round((d.origDur + dy / PXM) / 15) * 15;
      nd = Math.max(15, Math.min(DK_END - d.orig, nd));
      d.ndur = nd; d.moved = Math.abs(dy) > 2;
      force(x => x + 1);
      return;
    }
    const dy = e.clientY - d.startY;
    let ns = Math.round((d.orig + dy / PXM) / 15) * 15;
    ns = Math.max(DK_START, Math.min(DK_END - 30, ns));
    const nop = colFromX(e.clientX) || d.origOp;
    d.ns = ns; d.nop = nop;
    d.moved = Math.abs(dy) > 4 || nop !== d.origOp;
    force(x => x + 1);
  }
  function onUp() {
    const d = drag.current;
    if (d && d.mode === 'resize') {
      if (d.moved && d.ndur !== d.origDur) setAppts(l => l.map(x => x.id === d.id ? { ...x, _dur: d.ndur } : x));
      drag.current = null; force(x => x + 1); return;
    }
    if (d && d.moved && (d.ns !== d.orig || d.nop !== d.origOp)) {
      setAppts(l => l.map(x => x.id === d.id ? { ...x, start: d.ns, opId: d.nop } : x));
      const reassigned = d.nop !== d.origOp;
      fireToast({ msg: reassigned ? t(`Spostato da ${op(d.origOp).name} a ${op(d.nop).name}, ${timeLabel(d.ns)}`, `Moved from ${op(d.origOp).name} to ${op(d.nop).name}, ${timeLabel(d.ns)}`) : t('Spostato alle ' + timeLabel(d.ns), 'Moved to ' + timeLabel(d.ns)), icon: 'calendar', undo: t('Annulla', 'Undo'), undoFn: () => setAppts(l => l.map(x => x.id === d.id ? { ...x, start: d.orig, opId: d.origOp } : x)) });
    }
    drag.current = null; force(x => x + 1);
  }
  function onResizeDown(e, a) {
    e.preventDefault(); e.stopPropagation();
    drag.current = { id: a.id, mode: 'resize', startY: e.clientY, orig: a.start, origDur: apptEnd(a) - a.start, ndur: apptEnd(a) - a.start, moved: false };
  }
  function addBreak(opId, start, dur) {
    const id = 'brk' + Date.now();
    setAppts(l => [...l, { id, opId, start, kind: 'break', _dur: dur || 60, serviceIds: [], clientId: null }]);
    setSlotMenu(null);
    fireToast({ msg: t('Pausa aggiunta · ' + op(opId).name + ' alle ' + timeLabel(start), 'Break added · ' + op(opId).name + ' at ' + timeLabel(start)), icon: 'clock', undo: t('Annulla', 'Undo'), undoFn: () => setAppts(l => l.filter(x => x.id !== id)) });
  }

  // now-line at 10:18
  const nowMin = 10 * 60 + 18;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* timeline column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* sub toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 26px', borderBottom: '1px solid var(--hair)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button className="dk-iconbtn" style={{ width: 38, height: 38 }} onClick={navPrev}><Icon name="chevL" size={18} /></button>
            <button className="dk-iconbtn" style={{ width: 38, height: 38 }} onClick={navNext}><Icon name="chevR" size={18} /></button>
          </div>
          {calView === 'day' ? (
            <React.Fragment>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setJumpOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{(lang === 'en' ? MONTHS_EN : MONTHS_IT)[curMY.m] + ' ' + curMY.y}<Icon name="chevD" size={15} color="var(--muted)" style={{ transform: jumpOpen ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} /></button>
                {jumpOpen && (<React.Fragment>
                  <div onClick={() => setJumpOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 41, padding: 12, width: 260, boxShadow: 'var(--sh-pop)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => jumpToMonth(curMY.m, curMY.y - 1)}><Icon name="chevL" size={14} /></button>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{curMY.y}</span>
                      <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => jumpToMonth(curMY.m, curMY.y + 1)}><Icon name="chevR" size={14} /></button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 12 }}>
                      {(lang === 'en' ? MONTHS_EN : MONTHS_IT).map((mo, mi) => { const on = mi === curMY.m; return (
                        <button key={mi} onClick={() => jumpToMonth(mi, curMY.y)} style={{ padding: '8px 4px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{mo.slice(0, 3)}</button>
                      ); })}
                    </div>
                    <div style={{ borderTop: '1px solid var(--hair)', paddingTop: 10 }}>
                      <div className="t-meta" style={{ marginBottom: 6 }}>{t('Vai a una data', 'Jump to a date')}</div>
                      <input type="date" onChange={e => jumpToDate(e.target.value)} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                </React.Fragment>)}
              </div>
              <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 14, padding: 4 }}>
                {days.map((dd, i) => {
                  const sel = i === day;
                  return (
                    <button key={i} onClick={() => setDay(i)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 13px', borderRadius: 10, cursor: 'pointer', background: sel ? 'var(--ink)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', transition: 'all 150ms' }}>
                      <span style={{ fontSize: 10.5, fontWeight: 600, opacity: sel ? 0.7 : 0.5 }}>{t(dd[0], dd[1])}</span>
                      <span className="t-num" style={{ fontSize: 17, color: sel ? '#fff' : 'var(--ink)' }}>{dd[2]}</span>
                    </button>
                  );
                })}
              </div>
              <button className="dk-btn dk-btn--soft" style={{ height: 40 }} onClick={() => setDay(2)}>{t('Oggi', 'Today')}</button>
            </React.Fragment>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setJumpOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--serif)', fontSize: 21, fontWeight: 500, color: 'var(--ink)' }}>{periodLabel()}<Icon name="chevD" size={16} color="var(--muted)" style={{ transform: jumpOpen ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} /></button>
                {jumpOpen && (<React.Fragment>
                  <div onClick={() => setJumpOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 41, padding: 12, width: 260, boxShadow: 'var(--sh-pop)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => jumpToMonth(curMY.m, curMY.y - 1)}><Icon name="chevL" size={14} /></button>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{curMY.y}</span>
                      <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => jumpToMonth(curMY.m, curMY.y + 1)}><Icon name="chevR" size={14} /></button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 12 }}>
                      {(lang === 'en' ? MONTHS_EN : MONTHS_IT).map((mo, mi) => { const on = mi === curMY.m; return (
                        <button key={mi} onClick={() => jumpToMonth(mi, curMY.y)} style={{ padding: '8px 4px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{mo.slice(0, 3)}</button>
                      ); })}
                    </div>
                    <div style={{ borderTop: '1px solid var(--hair)', paddingTop: 10 }}>
                      <div className="t-meta" style={{ marginBottom: 6 }}>{t('Vai a una data', 'Jump to a date')}</div>
                      <input type="date" onChange={e => jumpToDate(e.target.value)} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                </React.Fragment>)}
              </div>
              {periodOff !== 0 && <button className="dk-btn dk-btn--soft" style={{ height: 36 }} onClick={() => setPeriodOff(0)}>{t('Oggi', 'Today')}</button>}
            </div>
          )}
          <div style={{ flex: 1 }} />
          {/* view selector: Giorno / Settimana / Mese */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4 }}>
            {[['day', 'Giorno', 'Day'], ['week', 'Settimana', 'Week'], ['month', 'Mese', 'Month']].map(([v, it, en]) => {
              const sel = calView === v;
              return <button key={v} onClick={() => { setCalView(v); setPeriodOff(0); }} style={{ padding: '8px 15px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: sel ? 'var(--ink)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', transition: 'all 140ms' }}>{t(it, en)}</button>;
            })}
          </div>
        </div>

        {/* body — day / week / month */}
        {calView === 'week' ? (
          <DkWeek appts={appts} colorOf={colorOf} blockColor={blockColor} openModal={openModal} PXM={PXM} t={t} lang={lang} nowMin={nowMin} onHover={onHover} onLeave={() => setHover(null)} />
        ) : calView === 'month' ? (
          <DkMonth appts={appts} setDay={setDay} setCalView={setCalView} t={t} lang={lang} />
        ) : isToday ? (
          <React.Fragment>
            {/* staff visibility filter — choose which calendars to view */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 26px', borderBottom: '1px solid var(--hair)', overflowX: 'auto' }}>
              <span className="t-meta" style={{ flexShrink: 0 }}>{t('Calendari', 'Calendars')}</span>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'nowrap' }}>
                {OPS.map(o => {
                  const on = vis[o.id];
                  const col = colorOf(o.id);
                  return (
                    <button key={o.id} onClick={() => toggleVis(o.id)} title={o.role[lang]} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 12px 5px 6px', borderRadius: 99, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap', border: '1px solid ' + (on ? 'transparent' : 'var(--hair)'), background: on ? col : 'var(--surface)', transition: 'all 140ms' }}>
                      <Avatar initials={o.initials} size={24} color={col} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: on ? 'var(--ink)' : 'var(--muted)' }}>{o.name}</span>
                      {on && <Icon name="check" size={13} color="var(--ink)" stroke={2.6} />}
                    </button>
                  );
                })}
              </div>
              <div style={{ flex: 1, minWidth: 8 }} />
              <span className="t-sm tabnum" style={{ color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>{visCount}/{OPS.length}</span>
              <button className="dk-btn dk-btn--soft" style={{ height: 32, fontSize: 12.5, flexShrink: 0 }} onClick={() => setAll(!allOn)}>{allOn ? t('Deseleziona', 'Clear') : t('Tutte', 'All')}</button>
            </div>

            {/* timeline — header + grid share one scroll: vertical on body, horizontal across columns */}
            <div ref={scrollRef} className="scroll" style={{ flex: 1, overflow: 'auto', position: 'relative' }} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
              {/* operator header (sticky top) */}
              <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 9, background: 'var(--paper)', gap: 0, paddingBottom: 8, borderBottom: '1px solid var(--hair)' }}>
                <div style={{ width: 64, flexShrink: 0, position: 'sticky', left: 0, zIndex: 11, background: 'var(--paper)' }} />
                <div style={{ flex: 1, display: 'flex', gap: 6, paddingRight: 4 }}>
                  {ops.map(o => {
                    const cnt = todays.filter(a => a.opId === o.id).length;
                    const rev = todays.filter(a => a.opId === o.id).reduce((s, a) => s + apptTotal(a), 0);
                    const col = colorOf(o.id);
                    return (
                      <div key={o.id} title={o.name + ' ' + (o.surname || '')} style={{ flex: '1 0 ' + COLW + 'px', padding: '10px 11px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, borderRadius: '0 0 12px 12px', background: col, position: 'relative' }}>
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                          <Avatar initials={o.initials} size={34} color={col} ring />
                          <span style={{ position: 'absolute', bottom: -1, right: -1, width: 11, height: 11, borderRadius: 99, background: cnt ? 'var(--ok)' : 'var(--faint)', border: '2px solid #fff' }} />
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 700, fontSize: 20, whiteSpace: 'nowrap', color: 'var(--ink)', letterSpacing: '-0.015em', lineHeight: 1.05, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</div>
                          <div style={{ color: 'var(--ink)', opacity: 0.6, fontSize: 11.5, fontWeight: 500, marginTop: 2 }}>{cnt} · {fmtEur(rev, lang)}</div>
                        </div>
                        <button onClick={() => setPicker(picker === o.id ? null : o.id)} title={t('Cambia colore', 'Change colour')} style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, cursor: 'pointer', display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,0.55)' }}>
                          <Icon name="palette" size={14} color="var(--ink)" />
                        </button>
                        {picker === o.id && (
                          <React.Fragment>
                            <div onClick={() => setPicker(null)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
                            <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 6, zIndex: 61, padding: 12, boxShadow: 'var(--sh-pop)', width: 250, boxSizing: 'border-box' }}>
                              <div className="t-meta" style={{ marginBottom: 8 }}>{t('Colore operatrice', 'Stylist colour')}</div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                                <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: col }}>
                                  <input type="color" value={(col && col[0] === '#') ? col : '#C9B8F2'} onChange={e => setOpColor(o.id, e.target.value)} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                                </label>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 8px', background: 'var(--surface)' }}>
                                  <span style={{ color: 'var(--muted-2)', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 12.5 }}>#</span>
                                  <input value={((col && col[0] === '#') ? col : '').replace('#', '').toUpperCase()} maxLength={6} placeholder="C9B8F2" onChange={e => { const v = e.target.value.replace(/[^0-9a-fA-F]/g, ''); setOpColor(o.id, '#' + v.padEnd(6, '0').slice(0, 6)); }} style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 12.5, width: 64, letterSpacing: '0.05em' }} />
                                </span>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                {(window.GD_PALETTE || []).map((row, ri) => (
                                  <div key={ri} style={{ display: 'flex', gap: 3 }}>
                                    {row.map(c => { const on = (col || '').toLowerCase() === c.toLowerCase(); return (
                                      <button key={c} onClick={() => { setOpColor(o.id, c); setPicker(null); }} title={c} style={{ width: 19, height: 19, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid ' + (c.toUpperCase() === '#FFFFFF' ? 'var(--hair)' : 'transparent'), outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1, flexShrink: 0 }} />
                                    ); })}
                                  </div>
                                ))}
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
                  {hours.map(h => (
                    <React.Fragment key={h}>
                      <div style={{ position: 'absolute', top: (h * 60 - DK_START) * PXM - 7, right: 10, fontSize: 11, fontWeight: 600, color: 'var(--muted-2)' }} className="tabnum">{String(h).padStart(2, '0')}:00</div>
                      {h < 20 && <div style={{ position: 'absolute', top: (h * 60 + 30 - DK_START) * PXM - 6, right: 10, fontSize: 9.5, fontWeight: 600, color: 'var(--faint)' }} className="tabnum">{String(h).padStart(2, '0')}:30</div>}
                    </React.Fragment>
                  ))}
                </div>
                {/* columns */}
                <div className="dk-tl-cols" style={{ flex: 1, display: 'flex', position: 'relative', gap: 6, paddingRight: 4 }}>
                  {/* 15-min gridlines (subtle) + hour lines (stronger) */}
                  {quarters.map(m => <div key={m} style={{ position: 'absolute', left: 0, right: 0, top: (m - DK_START) * PXM, height: 1, background: m % 60 === 0 ? 'var(--hair-2)' : 'color-mix(in srgb, var(--hair-2) 45%, transparent)' }} />)}
                  {/* now line — prominent coral */}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: (nowMin - DK_START) * PXM, height: 2, background: '#F4708A', zIndex: 8 }}>
                    <span style={{ position: 'absolute', left: -6, top: -5, width: 12, height: 12, borderRadius: 99, background: '#F4708A', boxShadow: '0 0 0 3px rgba(244,112,138,0.2)' }} />
                  </div>
                  {ops.map(o => (
                    <div key={o.id} title={t('Clicca uno spazio libero', 'Click a free slot')} onClick={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (drag.current && drag.current.moved) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const raw = DK_START + (e.clientY - rect.top) / PXM;
                      const snapped = Math.max(DK_START, Math.min(DK_END - 30, Math.round(raw / 30) * 30));
                      setSlotMenu({ opId: o.id, start: snapped, x: e.clientX, y: e.clientY });
                    }} style={{ flex: '1 0 ' + COLW + 'px', position: 'relative', minWidth: 0, borderRadius: 12, background: `color-mix(in srgb, ${colorOf(o.id)} 26%, #FFFFFF)`, cursor: 'copy' }}>
                      {todays.filter(a => {
                        const d = drag.current;
                        return d && d.id === a.id && d.mode !== 'resize' ? d.nop === o.id : a.opId === o.id;
                      }).map(a => <ApptBlock key={a.id} a={a} PXM={PXM} color={blockColor(a)} drag={drag.current} onDown={onDown} onResizeDown={onResizeDown} onHover={onHover} onLeave={() => setHover(null)} onOpen={() => { if (!drag.current?.moved && a.kind !== 'break') openModal('apptdetail', a.id); }} onRemoveBreak={() => { setAppts(l => l.filter(x => x.id !== a.id)); fireToast({ msg: t('Pausa rimossa', 'Break removed'), icon: 'x' }); }} />)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </React.Fragment>
        ) : (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState icon="calendar" title={t('Giornata leggera', 'Quiet day')} sub={t('Poche prenotazioni. Un buon giorno per le campagne di riattivazione.', 'Few bookings. A good day for win-back campaigns.')} action={t('Torna a oggi', 'Back to today')} onAction={() => setDay(2)} />
          </div>
        )}
      </div>

      {/* right rail — collapsible */}
      {railOpen ? (
      <aside className="dk-rail" style={{ width: 'var(--rail-w)', flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', overflowY: 'auto', padding: '14px 22px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button className="dk-rail-toggle" onClick={() => setRailOpen(false)} title={t('Comprimi pannello', 'Collapse panel')} style={{ width: 30, height: 30 }}><Icon name="chevR" size={16} /></button>
        </div>
        {showRevenue && <DailyCashUp t={t} lang={lang} appts={appts} onOpenPos={() => { setDeepLink && setDeepLink('log-today'); setTab('impostazioni'); }} />}
        <div style={{ marginTop: showRevenue ? 20 : 0, paddingTop: showRevenue ? 20 : 0, borderTop: showRevenue ? '4px solid var(--surface-2)' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <div className="t-meta">{t('Opportunità di oggi', 'Today’s opportunities')}</div>
            <span className="t-sm" style={{ fontWeight: 700, color: 'var(--ok)' }}>~€520</span>
          </div>
          <RailOpp t={t} lang={lang} openModal={openModal} />
        </div>
        {/* Lista d'attesa */}
        <div style={{ marginTop: 20, paddingTop: 20, borderTop: '4px solid var(--surface-2)' }}>
          <WaitListRail t={t} lang={lang} openModal={openModal} />
        </div>
      </aside>
      ) : (
      <aside style={{ width: 52, flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, gap: 4 }}>
        <button className="dk-rail-toggle" onClick={() => setRailOpen(true)} title={t('Espandi pannello', 'Expand panel')} style={{ width: 30, height: 30 }}><Icon name="chevL" size={16} /></button>
        <Icon name="calendar" size={18} color="var(--muted-2)" style={{ marginTop: 10 }} />
      </aside>
      )}
      {hover && <ApptHoverCard hover={hover} t={t} lang={lang} />}
      {slotMenu && (
        <React.Fragment>
          <div onClick={() => setSlotMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 95 }} />
          <div className="dk-card" style={{ position: 'fixed', boxSizing: 'border-box', top: Math.min(slotMenu.y, window.innerHeight - (slotMenu.mode === 'break' ? 300 : 130)), left: Math.min(slotMenu.x, window.innerWidth - 246), zIndex: 96, width: 234, padding: 6, boxShadow: 'var(--sh-pop)', overflow: 'hidden' }}>
            <div className="t-meta" style={{ padding: '6px 10px 4px' }}>{op(slotMenu.opId).name} · {timeLabel(slotMenu.start)}</div>
            {slotMenu.mode === 'break' ? (
              <div style={{ padding: '4px 8px 8px' }}>
                <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', margin: '4px 2px 8px' }}>{t('Durata pausa', 'Break duration')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
                  {[15, 30, 45, 60, 90, 120].map(d => { const on = (slotMenu.dur || 60) === d; return (
                    <button key={d} onClick={() => setSlotMenu(m => ({ ...m, dur: d }))} style={{ padding: '8px 0', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{d < 60 ? d + ' min' : (d / 60) + (d === 60 ? ' h' : ' h')}</button>
                  ); })}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '0 2px' }}>
                  <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Personalizzata', 'Custom')}</span>
                  <input type="number" min={5} step={5} value={slotMenu.dur || 60} onChange={e => setSlotMenu(m => ({ ...m, dur: Math.max(5, parseInt(e.target.value) || 5) }))} style={{ width: 64, textAlign: 'right', border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono, monospace)', outline: 'none' }} />
                  <span className="t-sm" style={{ color: 'var(--muted-2)' }}>min</span>
                </div>
                <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10, padding: '0 2px' }}>{timeLabel(slotMenu.start)}–{timeLabel(slotMenu.start + (slotMenu.dur || 60))}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="dk-btn dk-btn--ghost" style={{ flex: 1, minWidth: 0, height: 36, padding: '0 6px', boxSizing: 'border-box' }} onClick={() => setSlotMenu(m => ({ ...m, mode: null }))}>{t('Indietro', 'Back')}</button>
                  <button className="dk-btn dk-btn--clay" style={{ flex: 1, minWidth: 0, height: 36, padding: '0 6px', boxSizing: 'border-box' }} onClick={() => addBreak(slotMenu.opId, slotMenu.start, slotMenu.dur || 60)}><Icon name="check" size={15} color="#fff" />{t('Aggiungi', 'Add')}</button>
                </div>
              </div>
            ) : (
            <React.Fragment>
            <button className="dk-row" onClick={() => { const m = slotMenu; setSlotMenu(null); openModal('newappt', { prefill: { opId: m.opId, start: m.start } }); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left' }}><div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="plus" size={15} color="var(--clay-ink)" /></div><span style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Nuovo appuntamento', 'New appointment')}</span></button>
            <button className="dk-row" onClick={() => setSlotMenu(m => ({ ...m, mode: 'break', dur: 60 }))} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left' }}><div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="clock" size={15} color="var(--muted)" /></div><span style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Aggiungi pausa', 'Add break')}</span></button>
            </React.Fragment>
            )}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

function Kpi({ label, value }) {
  return (
    <div style={{ background: '#FFFFFF', border: '1px solid var(--hair)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '8px 16px', minWidth: 116, textAlign: 'right' }}>
      <div className="t-meta" style={{ fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div className="t-num" style={{ fontSize: 20, color: 'var(--ink)', lineHeight: 1.1 }}>{value}</div>
    </div>
  );
}

/* ---------- Appointment hover card ---------- */
function ApptHoverCard({ hover, t, lang }) {
  const { a, x, y, side } = hover;
  const c = client(a.clientId), o = op(a.opId);
  const svcLabel = a.serviceIds.map(s => svcName(svc(s), lang)).join(' + ');
  const note = a.note ? (a.note[lang] || a.note.it || a.note) : null;
  return (
    <div style={{ position: 'fixed', top: y, left: side === 'right' ? x : undefined, right: side === 'left' ? (window.innerWidth - x) : undefined, zIndex: 90, width: 300, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 14, boxShadow: 'var(--sh-pop)', padding: 16, pointerEvents: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Avatar initials={c.initials} size={38} color={o.color} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{o.name}</div>
        </div>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: o.color, flexShrink: 0 }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}><Icon name="scissors" size={15} color="var(--muted-2)" style={{ marginTop: 1, flexShrink: 0 }} /><span style={{ fontSize: 13.5, fontWeight: 600 }}>{svcLabel}</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Icon name="clock" size={15} color="var(--muted-2)" style={{ flexShrink: 0 }} /><span className="tabnum" style={{ fontSize: 13.5 }}>{timeLabel(a.start)}–{timeLabel(apptEnd(a))}</span><span className="t-sm" style={{ color: 'var(--muted-2)' }}>· {fmtDur(apptEnd(a) - a.start, lang)}</span></div>
        {c.phone && <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Icon name="phone" size={15} color="var(--muted-2)" style={{ flexShrink: 0 }} /><span className="tabnum" style={{ fontSize: 13.5 }}>{c.phone}</span>{c.wa && <span style={{ fontSize: 10, fontWeight: 700, color: '#2E7D44', background: '#E7F3EA', padding: '1px 6px', borderRadius: 99 }}>WA</span>}</div>}
        {note && <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 2, padding: '9px 11px', background: 'var(--warn-tint)', borderRadius: 10 }}><Icon name="info" size={15} color="var(--warn)" style={{ marginTop: 1, flexShrink: 0 }} /><span className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.4 }}>{note}</span></div>}
      </div>
    </div>
  );
}

function ApptBlock({ a, PXM, color, drag, onDown, onResizeDown, onOpen, onHover, onLeave, onRemoveBreak }) {
  const { lang } = useDk();
  const isDrag = drag && drag.id === a.id;
  const isResize = isDrag && drag.mode === 'resize';
  // ---- BREAK block (no client/service/deposit logic) ----
  if (a.kind === 'break') {
    const bStart = isDrag && !isResize ? drag.ns : a.start;
    const bDur = isResize ? drag.ndur : (apptEnd(a) - a.start);
    const bh = bDur * PXM;
    const bCompact = bh < 44;
    return (
      <div onPointerDown={e => onDown(e, a)}
        style={{
          position: 'absolute', top: (bStart - DK_START) * PXM + 1.5, height: bh - 3, left: 4, right: 4,
          borderRadius: 12, border: '1.5px dashed var(--pewter-300, #B6B4BB)',
          background: 'repeating-linear-gradient(135deg, rgba(120,120,128,0.13) 0 7px, rgba(120,120,128,0.04) 7px 14px)',
          boxShadow: isDrag ? 'var(--sh-pop)' : 'none', padding: bCompact ? '3px 9px' : '7px 11px', overflow: 'hidden',
          cursor: 'grab', touchAction: 'none', zIndex: isDrag ? 20 : 2,
          display: 'flex', flexDirection: bCompact ? 'row' : 'column', alignItems: bCompact ? 'center' : 'stretch', gap: bCompact ? 6 : 1,
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: bCompact ? 1 : 'none', minWidth: 0 }}>
          <Icon name="clock" size={13} color="var(--pewter-500, #6F6E74)" />
          <span style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--pewter-700, #45444A)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lang === 'en' ? 'Break' : 'Pausa'}</span>
        </div>
        <span className="tabnum" style={{ fontSize: 11, fontWeight: 500, color: 'var(--pewter-500, #6F6E74)', flexShrink: 0 }}>{timeLabel(bStart)}–{timeLabel(bStart + bDur)}</span>
        <button onClick={e => { e.stopPropagation(); onRemoveBreak && onRemoveBreak(); }} onPointerDown={e => e.stopPropagation()} title={lang === 'en' ? 'Remove break' : 'Rimuovi pausa'} style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.7)', cursor: 'pointer', display: bCompact ? 'none' : 'grid', placeItems: 'center', zIndex: 4 }}><Icon name="x" size={12} color="var(--pewter-500, #6F6E74)" /></button>
        {/* resize handle */}
        <div onPointerDown={e => onResizeDown && onResizeDown(e, a)} title={lang === 'en' ? 'Resize' : 'Ridimensiona'} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 12, cursor: 'ns-resize', display: 'grid', placeItems: 'center', touchAction: 'none' }}><div style={{ width: 26, height: 3, borderRadius: 99, background: 'var(--pewter-300, #B6B4BB)' }} /></div>
      </div>
    );
  }
  const o = op(a.opId), c = client(a.clientId);
  const start = isDrag ? drag.ns : a.start;
  const dur = apptEnd(a) - a.start;
  const h = dur * PXM;
  const compact = h < 50;
  // block uses the operator's pastel colour (a touch more saturated), dark text
  const base = color || o.color;
  const bg = `color-mix(in srgb, ${base} 82%, #FFFFFF)`;
  const fg = 'var(--ink)';
  const subFg = 'var(--muted)';
  const timeFg = 'var(--ink-2)';
  return (
    <div onPointerDown={e => onDown(e, a)} onClick={onOpen} onMouseEnter={e => onHover && onHover(a, e.currentTarget)} onMouseLeave={() => onLeave && onLeave()}
      style={{
        position: 'absolute', top: (start - DK_START) * PXM + 1.5, height: h - 3, left: 4, right: 4,
        background: bg, borderRadius: 12, border: 'none',
        boxShadow: isDrag ? 'var(--sh-pop)' : '0 1px 3px rgba(17,24,39,0.12)', padding: compact ? '3px 9px' : '8px 11px', overflow: 'hidden',
        cursor: 'grab', touchAction: 'none', zIndex: isDrag ? 20 : 2, transform: isDrag ? 'scale(1.02)' : 'none',
        opacity: a.status === 'noshow' ? 0.5 : 1, transition: isDrag ? 'none' : 'box-shadow 150ms',
        display: 'flex', flexDirection: compact ? 'row' : 'column', alignItems: compact ? 'baseline' : 'stretch', gap: compact ? 6 : 0,
      }}>
      {a.deposit === 'paid' && <div title={lang === 'en' ? 'Deposit collected' : 'Caparra incassata'} style={{ position: 'absolute', top: 5, right: 5, width: 22, height: 22, borderRadius: 7, background: 'var(--surface)', border: '1.5px solid var(--ok)', display: 'grid', placeItems: 'center', boxShadow: '0 1px 2px rgba(17,24,39,0.12)', zIndex: 3 }}><Icon name="wallet" size={13} color="var(--ok)" stroke={2} /></div>}
      <div style={{ fontWeight: 600, fontSize: 12.5, color: fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.25, flex: compact ? 1 : 'none', minWidth: 0, paddingRight: !compact && a.deposit === 'paid' ? 24 : 0 }}>{c.name}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: compact ? 0 : 1, flexShrink: 0, paddingRight: compact && a.deposit === 'paid' ? 22 : 0 }}>
        <span className="tabnum" style={{ fontSize: 11, fontWeight: 500, color: timeFg, whiteSpace: 'nowrap' }}>{timeLabel(start)}</span>
      </div>
      {!compact && <div style={{ color: subFg, fontSize: 11, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.serviceIds.map(s => svcName(svc(s), lang)).join(' + ')}</div>}
      {!compact && h > 76 && (
        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center' }}>
          <div style={{ width: 22, height: 22, borderRadius: 99, background: 'rgba(255,255,255,0.65)', display: 'grid', placeItems: 'center', fontSize: 9.5, fontWeight: 700, color: 'var(--ink)' }}>{c.initials}</div>
        </div>
      )}
    </div>
  );
}

function DailyCashUp({ t, lang, appts, onOpenPos }) {
  const done = appts.filter(a => a.kind !== 'break' && (a.status === 'checkin' || a.status === 'corso'));
  const rows = done.map(a => ({ a, total: apptTotal(a), c: client(a.clientId) }));
  const grossDone = rows.reduce((s, r) => s + r.total, 0);
  // standalone Point of Sale takings today (counter sales, not tied to a service)
  const posToday = (window.POS_SALES_SEED || []).filter(s => (s.date || '').slice(0, 10) === '2026-06-24').reduce((a, s) => a + (window.posSaleTotal ? window.posSaleTotal(s) : 0), 0);
  const collected = grossDone + posToday;
  const cash = Math.round(collected * 0.42);
  const card = collected - cash;
  const deposits = appts.filter(a => a.deposit === 'paid').reduce((s, a) => s + Math.round(apptTotal(a) * 0.3), 0);
  const expected = appts.filter(a => a.kind !== 'break').reduce((s, a) => s + apptTotal(a), 0) + posToday;
  const txns = rows.length + (window.POS_SALES_SEED || []).filter(s => (s.date || '').slice(0, 10) === '2026-06-24').length;
  const pct = expected ? Math.min(100, Math.round(collected / expected * 100)) : 0;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="wallet" size={16} color="var(--clay-ink)" />
        <div className="t-meta" style={{ flex: 1 }}>{t('Riepilogo di cassa · oggi', 'Cash-up · today')}</div>
        <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>{txns} {t('transazioni', 'txns')}</span>
      </div>
      {/* collected total → opens the activity log filtered to today */}
      <button onClick={onOpenPos} title={t('Apri il registro attività di oggi', 'Open today’s activity log')} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--ink)', borderRadius: 16, padding: '16px 18px', marginBottom: 12, border: 'none', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <span className="t-meta" style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>{t('Vendite totali · oggi', 'Total sales · today')}</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.85)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>{t('Registro', 'Log')}<Icon name="chevR" size={13} color="rgba(255,255,255,0.85)" /></span>
        </div>
        <div className="t-num" style={{ fontSize: 28, fontWeight: 800, color: '#fff' }}>{fmtEur(collected, lang)}</div>
        <div style={{ height: 5, borderRadius: 99, background: 'rgba(255,255,255,0.2)', overflow: 'hidden', margin: '10px 0 4px' }}><div style={{ height: '100%', width: pct + '%', background: '#fff', borderRadius: 99 }} /></div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>{pct}% {t('dell\u2019atteso', 'of expected')} · {fmtEur(expected, lang)}</div>
      </button>
    </div>
  );
}

function MiniMonth({ t, day }) {
  const cells = []; for (let i = 0; i < 35; i++) { const d = i - 2; cells.push(d >= 1 && d <= 30 ? d : null); }
  const busy = { 10: 'mid', 12: 'high', 13: 'mid', 14: 'mid', 15: 'high', 18: 'low', 20: 'mid', 21: 'high', 25: 'mid' };
  const cols = { high: 'var(--clay)', mid: 'var(--warn)', low: 'var(--ok)' };
  return (
    <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Novembre 2025', 'November 2025')}</div>
        <div style={{ display: 'flex', gap: 2 }}><button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }}><Icon name="chevL" size={14} /></button><button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }}><Icon name="chevR" size={14} /></button></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3 }}>
        {[t('L', 'M'), t('M', 'T'), t('M', 'W'), t('G', 'T'), t('V', 'F'), t('S', 'S'), t('D', 'S')].map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--muted-2)', paddingBottom: 4 }}>{d}</div>)}
        {cells.map((c, i) => (
          <div key={i} style={{ aspectRatio: '1', borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, background: c === day ? 'var(--ink)' : 'transparent', color: c === day ? '#fff' : 'var(--ink-2)', cursor: c ? 'pointer' : 'default' }}>
            {c}{c && busy[c] && <span style={{ width: 4, height: 4, borderRadius: 99, background: c === day ? '#fff' : cols[busy[c]], marginTop: 1 }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function RailOpp({ t, lang, openModal }) {
  const opps = [
    { icon: 'gap', kind: t('Buco in agenda', 'Schedule gap'), title: t('Buco 15:00–15:45', 'Gap 15:00–15:45'), sub: t('3 clienti vicine da avvisare', '3 nearby clients to alert'), gain: '~€55' },
    { icon: 'revive', kind: t('Riattivazione', 'Win-back'), title: t('4 VIP dormienti', '4 dormant VIPs'), sub: t('Non tornano da 60+ giorni', 'Away for 60+ days'), gain: '~€140' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {opps.map((o, i) => (
        <button key={i} className="dk-card dk-hovercard" onClick={() => openModal('opportunity')} style={{ textAlign: 'left', padding: '10px 12px', border: '1px solid var(--hair)', boxShadow: 'none' }}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <div style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={o.icon} size={13} color="var(--clay-ink)" /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.title}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.sub}</div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '2px 7px', borderRadius: 99, flexShrink: 0 }}>{o.gain}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

/* ---------- Week view (7-day overview) ---------- */
const DK_WEEK = [['Lun', 'Mon', 10], ['Mar', 'Tue', 11], ['Mer', 'Wed', 12], ['Gio', 'Thu', 13], ['Ven', 'Fri', 14], ['Sab', 'Sat', 15], ['Dom', 'Sun', 16]];
// today = Wed (index 2). Other days get a deterministic demo subset for overview.
function weekDayAppts(idx, appts) {
  if (idx === 2) return appts.filter(a => a.kind !== 'break');
  if (idx === 6) return []; // closed Sunday
  const seed = (idx + 1) * 3;
  return appts.filter((_, i) => (i * 7 + seed) % 10 < 4).map(a => ({ ...a }));
}
// pack overlapping appointments into side-by-side lanes within a day column
function weekLayout(list) {
  const sorted = list.map(a => ({ ...a })).sort((a, b) => a.start - b.start || apptEnd(b) - apptEnd(a));
  const out = []; let cluster = [], clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    cluster.forEach(a => { let l = laneEnds.findIndex(e => e <= a.start); if (l === -1) { l = laneEnds.length; laneEnds.push(apptEnd(a)); } else laneEnds[l] = apptEnd(a); a._lane = l; });
    const lc = Math.max(1, laneEnds.length);
    cluster.forEach(a => { a._laneCount = lc; out.push(a); });
    cluster = [];
  };
  sorted.forEach(a => { if (cluster.length && a.start >= clusterEnd) { flush(); clusterEnd = -1; } cluster.push(a); clusterEnd = Math.max(clusterEnd, apptEnd(a)); });
  flush();
  return out;
}
function DkWeek({ appts, colorOf, blockColor, openModal, PXM, t, lang, nowMin, onHover, onLeave }) {
  const hours = []; for (let h = 8; h <= 20; h++) hours.push(h);
  const [opTip, setOpTip] = React.useState(null); // { name, x, y }
  const gridH = (DK_END - DK_START) * PXM;
  // per-day operator set (only operators with appointments that day), keeps day-view column logic
  const dayData = DK_WEEK.map((d, i) => {
    const list = weekDayAppts(i, appts);
    const dayOps = OPS.filter(o => list.some(a => a.opId === o.id));
    return { list, dayOps };
  });
  return (
    <div className="scroll" style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
      {/* sticky header: day + per-operator sub-columns */}
      <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 9, background: 'var(--paper)', borderBottom: '1px solid var(--hair)', width: 'max-content', minWidth: '100%' }}>
        <div style={{ width: 46, flexShrink: 0, position: 'sticky', left: 0, background: 'var(--paper)', zIndex: 10 }} />
        {DK_WEEK.map((d, i) => {
          const today = i === 2; const { list, dayOps } = dayData[i]; const rev = list.reduce((s, a) => s + apptTotal(a), 0);
          const dayW = Math.max(120, dayOps.length * 48);
          const dayBg = today ? '#D6E4F7' : 'transparent';
          return (
            <div key={i} style={{ flex: '0 0 ' + dayW + 'px', minWidth: 0, borderLeft: '1px solid var(--clay)', background: dayBg }}>
              {/* day label */}
              <div style={{ textAlign: 'center', padding: '8px 4px 7px' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: today ? 'var(--clay-ink)' : 'var(--muted)' }}>{t(d[0], d[1])}</span>
                  <span className="t-num" style={{ fontSize: 14, color: today ? '#fff' : 'var(--ink)', background: today ? 'var(--clay)' : 'transparent', width: 24, height: 24, borderRadius: 99, display: 'grid', placeItems: 'center' }}>{d[2]}</span>
                </div>
                <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 10, marginTop: 2 }}>{list.length ? `${list.length} · ${fmtEur(rev, lang)}` : t('Chiuso', 'Closed')}</div>
              </div>
              {/* operator sub-column headers — full surname */}
              {dayOps.length > 0 && (
                <div style={{ display: 'flex', borderTop: '1px solid var(--hair-2)' }}>
                  {dayOps.map(o => (
                    <div key={o.id} title={o.name + ' ' + (o.surname || '')} onMouseEnter={e => { const r = e.currentTarget.getBoundingClientRect(); setOpTip({ name: o.name + ' ' + (o.surname || ''), x: r.left + r.width / 2, y: r.bottom + 6 }); }} onMouseLeave={() => setOpTip(null)} style={{ flex: 1, minWidth: 0, padding: '5px 2px', textAlign: 'center', borderLeft: '1px solid var(--hair-2)', cursor: 'default', background: `color-mix(in srgb, ${colorOf(o.id)} 30%, var(--paper))` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 2px' }}>{o.surname || o.name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* grid */}
      <div style={{ display: 'flex', height: gridH, position: 'relative', width: 'max-content', minWidth: '100%' }}>
        <div style={{ width: 46, flexShrink: 0, position: 'sticky', left: 0, zIndex: 7, background: 'var(--paper)' }}>
          {hours.map(h => <div key={h} style={{ position: 'absolute', top: (h * 60 - DK_START) * PXM - 7, right: 7, fontSize: 10, fontWeight: 600, color: 'var(--muted-2)' }} className="tabnum">{String(h).padStart(2, '0')}</div>)}
        </div>
        {DK_WEEK.map((d, i) => {
          const today = i === 2; const { list, dayOps } = dayData[i];
          const dayW = Math.max(120, dayOps.length * 48);
          const dayBg = today ? '#D6E4F7' : 'transparent';
          return (
            <div key={i} style={{ flex: '0 0 ' + dayW + 'px', minWidth: 0, position: 'relative', borderLeft: '1px solid var(--clay)', background: dayBg, display: 'flex' }}>
              {/* hour gridlines across the whole day */}
              {hours.map(h => <div key={h} style={{ position: 'absolute', left: 0, right: 0, top: (h * 60 - DK_START) * PXM, height: 1, background: 'var(--hair-2)', zIndex: 0 }} />)}
              {today && <div style={{ position: 'absolute', left: 0, right: 0, top: (nowMin - DK_START) * PXM, height: 2, background: '#F4708A', zIndex: 6 }} />}
              {dayOps.length === 0 ? null : dayOps.map(o => {
                const opList = list.filter(a => a.opId === o.id);
                return (
                  <div key={o.id} style={{ flex: 1, minWidth: 0, position: 'relative', borderLeft: '1px solid var(--hair-2)' }}>
                    {weekLayout(opList).map(a => {
                      const dur = apptEnd(a) - a.start; const c = client(a.clientId); const h = dur * PXM;
                      const lc = a._laneCount || 1, lane = a._lane || 0;
                      const parts = c.name.split(' '); const first = parts[0]; const last = parts.slice(1).join(' ');
                      return (
                        <div key={a.id} onClick={() => { if (!a._ghost) openModal('apptdetail', a.id); }} onMouseEnter={e => !a._ghost && onHover && onHover(a, e.currentTarget)} onMouseLeave={() => onLeave && onLeave()} title={`${c.name} · ${timeLabel(a.start)} · ${o.name}`}
                          style={{ position: 'absolute', top: (a.start - DK_START) * PXM + 1, height: h - 2, left: `calc(${(lane / lc) * 100}% + 1px)`, width: `calc(${100 / lc}% - 2px)`, borderRadius: 6, background: `color-mix(in srgb, ${(blockColor ? blockColor(a) : colorOf(o.id))} 82%, #FFFFFF)`, padding: '3px 5px', overflow: 'hidden', cursor: a._ghost ? 'default' : 'pointer', opacity: a._ghost ? 0.5 : 1, boxShadow: '0 1px 2px rgba(17,24,39,0.1)', zIndex: 2 }}>
                          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2 }}>{first}</div>
                          {last && h > 30 && lc < 3 && <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2 }}>{last}</div>}
                          {h > 44 && <div className="tabnum" style={{ fontSize: 9.5, color: 'var(--ink-2)', marginTop: 1 }}>{timeLabel(a.start)}</div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {opTip && <div style={{ position: 'fixed', top: opTip.y, left: opTip.x, transform: 'translateX(-50%)', zIndex: 90, background: 'var(--ink)', color: '#fff', fontSize: 12.5, fontWeight: 600, padding: '6px 11px', borderRadius: 8, whiteSpace: 'nowrap', pointerEvents: 'none', boxShadow: 'var(--sh-pop)' }}>{opTip.name}</div>}
    </div>
  );
}

/* ---------- Month view ---------- */
function DkMonth({ appts, setDay, setCalView, t, lang }) {
  const firstDow = 5, daysInMonth = 30, today = 12; // Nov 2025 starts Saturday
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const countFor = (d) => d === today ? appts.length : (d && d % 7 !== 0 ? ((d * 7 + 3) % 9) : 0);
  const revFor = (d) => d === today ? appts.reduce((s, a) => s + apptTotal(a), 0) : countFor(d) * 48;
  const dow = [t('Lun', 'Mon'), t('Mar', 'Tue'), t('Mer', 'Wed'), t('Gio', 'Thu'), t('Ven', 'Fri'), t('Sab', 'Sat'), t('Dom', 'Sun')];
  const load = (n) => n === 0 ? 'var(--faint)' : n >= 6 ? 'var(--clay)' : n >= 3 ? 'var(--warn)' : 'var(--ok)';
  return (
    <div className="scroll" style={{ flex: 1, overflow: 'auto', padding: '18px 26px 26px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
        {dow.map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted-2)', textTransform: 'uppercase', paddingBottom: 4 }}>{d}</div>)}
        {cells.map((d, i) => {
          const n = d ? countFor(d) : 0; const isToday = d === today;
          return (
            <button key={i} disabled={!d} onClick={() => { if (d) { if (d === today) setDay(2); setCalView('day'); } }}
              style={{ minHeight: 96, borderRadius: 14, border: '1px solid ' + (isToday ? 'var(--ink)' : 'var(--hair)'), background: d ? (isToday ? 'var(--ink)' : 'var(--surface)') : 'transparent', padding: '9px 11px', textAlign: 'left', cursor: d ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', boxShadow: isToday ? 'var(--sh-sm)' : 'none' }}>
              {d && (
                <React.Fragment>
                  <span className="t-num" style={{ fontSize: 15, color: isToday ? '#fff' : 'var(--ink)' }}>{d}</span>
                  {n > 0 ? (
                    <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: 99, background: isToday ? '#fff' : load(n), flexShrink: 0 }} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: isToday ? '#fff' : 'var(--ink-2)' }}>{n} {t('appunt.', 'appts')}</span>
                      </div>
                      <span className="t-sm" style={{ fontSize: 11, color: isToday ? 'rgba(255,255,255,0.7)' : 'var(--muted-2)' }}>{fmtEur(revFor(d), lang)}</span>
                    </div>
                  ) : (
                    d % 7 === 0 && <span style={{ marginTop: 'auto', fontSize: 10.5, fontWeight: 600, color: 'var(--faint)' }}>{t('Chiuso', 'Closed')}</span>
                  )}
                </React.Fragment>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Waiting list rail (right panel summary) ---- */
function WaitListRail({ t, lang, openModal }) {
  const { waitList } = useDk();
  if (!waitList || waitList.length === 0) return (
    <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hair)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="t-meta">{t('Lista d\'attesa', 'Waiting list')}</div>
      </div>
      <button className="dk-btn dk-btn--ghost" style={{ width: '100%', fontSize: 13, borderStyle: 'dashed' }} onClick={() => openModal('waitlist')}>
        <Icon name="plus" size={15} />{t('Aggiungi cliente', 'Add client')}
      </button>
    </div>
  );
  const top = waitList.slice(0, 3);
  return (
    <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--hair)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="t-meta">{t('Lista d\'attesa', 'Waiting list')}</div>
        <button className="dk-btn dk-btn--ghost" style={{ height: 28, fontSize: 12, padding: '0 10px' }} onClick={() => openModal('waitlist')}>{t('Gestisci', 'Manage')}</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {top.map(w => {
          const c = client(w.clientId);
          const svcs = w.serviceIds.map(id => svcName(svc(id), lang)).join(', ') || t('Qualsiasi', 'Any');
          return (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Avatar initials={c.initials} size={30} color={c.color || 'var(--clay)'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{svcs}</div>
              </div>
            </div>
          );
        })}
        {waitList.length > 3 && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2 }}>+{waitList.length - 3} {t('altri', 'more')}</div>}
      </div>
    </div>
  );
}

Object.assign(window, { DkAgenda });
