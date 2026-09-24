// screen-cliente.jsx — white-label client web app (The Parlour) + Brand editor
const { useState: useStateClt } = React;

const SALON = { name: 'The Parlour', city: 'Firenze', addr: 'Via de’ Tornabuoni 12', hours: { it: 'Mar–Sab · 9–19', en: 'Tue–Sat · 9–19' }, ig: '@theparlour.firenze' };

function brandVars(brand) {
  return { '--brand': brand.color, '--brand-ink': brand.ink, '--brand-tint': brand.tint, '--brand-on': onColor(brand.color) };
}
const headFont = (brand) => brand.type === 'serif' ? 'var(--serif)' : 'var(--sans)';

/* cover with monogram (default professional theme, no photo needed) */
function Cover({ brand, h = 200 }) {
  return (
    <div style={{ height: h, background: brand.color, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ position: 'absolute', inset: 0, opacity: 0.13, background: 'radial-gradient(circle at 78% 22%, ' + onColor(brand.color) + ' 0 1.5px, transparent 1.6px) 0 0/22px 22px' }} />
      <div style={{ position: 'absolute', top: 16, right: 18, fontFamily: 'var(--serif)', fontSize: 46, color: onColor(brand.color), opacity: 0.18, fontStyle: 'italic' }}>P</div>
      <div style={{ position: 'relative', padding: '0 22px 20px' }}>
        <div style={{ width: 56, height: 56, borderRadius: 99, background: onColor(brand.color), display: 'grid', placeItems: 'center', overflow: 'hidden', marginBottom: 12, boxShadow: '0 4px 14px rgba(0,0,0,0.18)' }}>
          {brand.logo ? <img src={brand.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontFamily: 'var(--serif)', fontSize: 26, fontStyle: 'italic', color: brand.color, lineHeight: 1 }}>P</span>}
        </div>
        <div style={{ fontFamily: headFont(brand), fontSize: 30, fontWeight: brand.type === 'serif' ? 500 : 800, color: onColor(brand.color), letterSpacing: brand.type === 'serif' ? '0' : '-0.02em', lineHeight: 1 }}>{SALON.name}</div>
        <div style={{ color: onColor(brand.color), opacity: 0.72, fontSize: 13, fontWeight: 600, marginTop: 6, letterSpacing: '0.04em' }}>{SALON.addr} · {SALON.city}</div>
      </div>
    </div>
  );
}

/* ---------- The client app ---------- */
function ClientApp() {
  const { t, lang, brand, setLang, shot } = useApp();
  const [view, setView] = useStateClt('home');
  const [slot, setSlot] = useStateClt(null);
  const [hasAppt, setHasAppt] = useStateClt(true);   // false → empty hero state
  React.useEffect(() => {
    if (shot === 'client-app.wallet') setView('wallet');
    else if (shot === 'client-app.reschedule') setView('sposta');
  }, []);
  const B = CLIENT_BOOKING, W = CLIENT_WALLET;
  const vars = brandVars(brand);
  const NAV_VIEWS = ['home', 'prenotazioni', 'wallet', 'profilo', 'waitlist'];
  const showNav = NAV_VIEWS.includes(view);
  const NavBar = () => {
    const items = [
      { key: 'home', icon: 'home', label: t('Home', 'Home') },
      { key: 'prenotazioni', icon: 'calendar', label: t('Prenotazioni', 'Bookings') },
      { key: 'prenota', icon: 'plus', label: t('Prenota', 'Book'), center: true },
      { key: 'wallet', icon: 'wallet', label: t('Portafoglio', 'Wallet') },
      { key: 'profilo', icon: 'user', label: t('Profilo', 'Profile') },
    ];
    return (
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 60, paddingBottom: 'var(--safe-bottom)', background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(16px)', borderTop: '1px solid var(--hair)', ...vars }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', padding: '8px 8px 6px' }}>
          {items.map(it => {
            const on = view === it.key || (it.key === 'profilo' && view === 'waitlist');
            if (it.center) return (
              <div key={it.key} style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
                <button className="press" onClick={() => setView('prenota')} style={{ width: 54, height: 54, marginTop: -22, borderRadius: 18, background: 'var(--brand)', boxShadow: '0 8px 20px color-mix(in srgb, var(--brand) 45%, transparent)', display: 'grid', placeItems: 'center' }}>
                  <Icon name="plus" size={26} color="var(--brand-on)" stroke={2.4} />
                </button>
              </div>
            );
            return (
              <button key={it.key} className="press" onClick={() => setView(it.key)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '4px 0' }}>
                <Icon name={it.icon} size={22} color={on ? 'var(--brand-ink)' : 'var(--muted-2)'} stroke={on ? 2 : 1.7} />
                <span style={{ fontSize: 10.5, fontWeight: on ? 700 : 600, color: on ? 'var(--brand-ink)' : 'var(--muted-2)' }}>{it.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };
  const wrap = (children) => (
    <React.Fragment>
      <div style={{ height: '100%', overflowY: 'auto', background: 'var(--paper-0)', ...vars }} className="scroll">
        {showNav ? <div style={{ paddingBottom: 'calc(var(--safe-bottom) + 70px)' }}>{children}</div> : children}
      </div>
      {showNav && <NavBar />}
    </React.Fragment>
  );

  // top utility bar (lang switch — visible per brief)
  const Utility = () => (
    <div style={{ position: 'absolute', top: 'calc(var(--safe-top) - 8px)', right: 14, zIndex: 30 }}>
      <button className="press" onClick={() => setLang(lang === 'it' ? 'en' : 'it')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 99, background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(8px)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', boxShadow: 'var(--sh-sm)' }}>
        <Icon name="globe" size={14} />{lang.toUpperCase()}
      </button>
    </div>
  );

  if (view === 'success') return wrap(
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 30, textAlign: 'center' }}>
      <div className="pop-in" style={{ width: 86, height: 86, borderRadius: 99, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', marginBottom: 20 }}><Icon name="check" size={44} color="var(--brand)" stroke={2.2} /></div>
      <div style={{ fontFamily: headFont(brand), fontSize: 26, fontWeight: brand.type === 'serif' ? 500 : 800 }}>{t('Fatto!', 'All set!')}</div>
      <div className="t-body" style={{ color: 'var(--muted)', marginTop: 8, maxWidth: 270 }}>{t('Ti abbiamo inviato la conferma su WhatsApp. A presto da The Parlour 💫', 'We’ve sent your confirmation on WhatsApp. See you soon at The Parlour 💫')}</div>
      <button className="btn btn--brand press" style={{ marginTop: 26 }} onClick={() => setView('home')}>{t('Torna alla prenotazione', 'Back to booking')}</button>
    </div>
  );

  if (view === 'login') return <ClientLogin brand={brand} onDone={() => setView('home')} wrap={wrap} />;
  if (view === 'prenota') return <ClientBooking brand={brand} t={t} lang={lang} wrap={wrap} onBack={() => setView('home')} onDone={() => setView('success')} />;
  if (view === 'expired') return wrap(<ClientEdge brand={brand} icon="clock" title={t('Link scaduto', 'Link expired')} sub={t('Per la tua sicurezza il link dura poche ore. Te ne inviamo subito uno nuovo.', 'For your security the link lasts a few hours. We’ll send a fresh one right away.')} cta={t('Richiedi nuovo link', 'Request new link')} onCta={() => setView('login')} />);
  if (view === 'empty') return wrap(<ClientEdge brand={brand} icon="calendar" title={t('Nessuna prenotazione', 'No bookings')} sub={t('Non hai appuntamenti in programma. Prenota il tuo prossimo momento da The Parlour.', 'You have no upcoming appointments. Book your next moment at The Parlour.')} cta={t('Prenota ora', 'Book now')} onCta={() => setView('prenota')} />);

  if (view === 'sposta') return wrap(
    <div style={{ paddingBottom: 30 }}>
      <ClientSubHead brand={brand} title={t('Sposta appuntamento', 'Reschedule')} onBack={() => setView('home')} />
      <div style={{ padding: '8px 22px' }}>
        <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 18 }}>{t('Scegli un nuovo orario. Mostriamo solo gli slot davvero disponibili.', 'Pick a new time. We only show slots that are actually free.')}</div>
        {CLIENT_SLOTS.map(d => (
          <div key={d.day.it} style={{ marginBottom: 18 }}>
            <div className="t-meta" style={{ marginBottom: 10 }}>{d.day[lang]}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {d.times.map(tm => { const id = d.day.it + tm; const on = slot === id; return (
                <button key={tm} className="press" onClick={() => setSlot(id)} style={{ padding: '13px 20px', borderRadius: 14, fontWeight: 700, fontSize: 15, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)' }}>{tm}</button>
              ); })}
            </div>
          </div>
        ))}
      </div>
      <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(var(--safe-bottom) + 14px)', background: 'linear-gradient(transparent, var(--paper-0) 24%)' }}>
        <button className="btn btn--brand btn--block press" disabled={!slot} style={{ opacity: slot ? 1 : 0.4 }} onClick={() => setView('success')}>{t('Conferma nuovo orario', 'Confirm new time')}</button>
      </div>
    </div>
  );

  if (view === 'annulla') return wrap(
    <div style={{ paddingBottom: 30 }}>
      <ClientSubHead brand={brand} title={t('Annulla appuntamento', 'Cancel')} onBack={() => setView('home')} />
      <div style={{ padding: '8px 22px' }}>
        <div style={{ display: 'flex', gap: 12, padding: 16, background: 'var(--danger-tint)', borderRadius: 'var(--r-md)', marginBottom: 20 }}>
          <Icon name="alert" size={22} color="var(--danger)" />
          <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--ink-2)' }}>{t('Annullando perderai il deposito di €20 (non rimborsabile entro 24h). Sei sicura?', 'Cancelling forfeits your €20 deposit (non-refundable within 24h). Are you sure?')}</div>
        </div>
        <div className="card" style={{ padding: 16, marginBottom: 24, boxShadow: 'none', border: '1px solid var(--hair)' }}>
          <BookingSummary B={B} brand={brand} lang={lang} t={t} />
        </div>
        <button className="btn btn--block press" style={{ background: 'var(--danger)', color: '#fff' }} onClick={() => setView('success')}>{t('Sì, annulla', 'Yes, cancel')}</button>
        <button className="btn btn--ghost btn--block press" style={{ marginTop: 10 }} onClick={() => setView('home')}>{t('No, mantieni', 'No, keep it')}</button>
      </div>
    </div>
  );

  if (view === 'wallet') {
    const activeProg = (window.LOYALTY_PROGRAMS || []).filter(p => p.active);
    const couponTag = (c) => c.kind === 'gift' ? t('Omaggio', 'Gift') : t('Sconto', 'Discount');
    return wrap(
      <div style={{ paddingBottom: 30 }}>
        <ClientSubHead brand={brand} title={t('Portafoglio', 'Wallet')} onBack={() => setView('home')} />
        <div style={{ padding: '8px 22px' }}>

          {/* ---- GIFT CARD ---- saldo prepagato ---- */}
          {(() => {
            const cards = window.CLIENT_GIFTCARDS || [];
            const totBal = cards.reduce((s, g) => s + g.balance, 0);
            return (
              <React.Fragment>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                  <div className="t-meta">{t('Gift card', 'Gift cards')}</div>
                  <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>{cards.length}</span>
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>{t('Saldo prepagato spendibile in salone.', 'Prepaid balance to spend in the salon.')}</div>
                {cards.length ? (
                  <React.Fragment>
                    <div style={{ borderRadius: 'var(--r-lg, 20px)', padding: '16px 18px', background: 'var(--brand)', color: 'var(--brand-on)', marginBottom: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.82, letterSpacing: '0.04em' }}>{t('Saldo totale', 'Total balance')}</div>
                      <div className="t-num" style={{ fontSize: 30, fontWeight: 800, marginTop: 2 }}>{fmtEur(totBal, lang)}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
                      {cards.map(g => { const used = Math.round((1 - g.balance / g.value) * 100); return (
                        <div key={g.id} className="card" style={{ padding: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: used > 0 ? 10 : 0 }}>
                            <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="gift" size={19} color="var(--brand-ink)" /></div>
                            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 14.5 }}>{fmtEur(g.balance, lang)} <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>/ {fmtEur(g.value, lang)}</span></div><div className="t-sm" style={{ color: 'var(--muted)' }}>{g.from[lang]} · {g.expiry[lang]}</div></div>
                            <span className="tabnum" style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', background: 'var(--paper-2)', padding: '4px 8px', borderRadius: 8, flexShrink: 0 }}>{g.code}</span>
                          </div>
                          {used > 0 && <ProgressBar value={used} color="var(--brand)" />}
                        </div>
                      ); })}
                    </div>
                  </React.Fragment>
                ) : (
                  <div style={{ padding: '18px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--hair)', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5, marginBottom: 14 }}>{t('Nessuna gift card attiva.', 'No active gift cards.')}</div>
                )}
                <button className="press" onClick={() => fireToast({ msg: t('Apriamo l’acquisto gift card…', 'Opening gift card purchase…'), icon: 'gift' })} style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '11px', borderRadius: 'var(--r-pill)', background: 'var(--brand-tint)', color: 'var(--brand-ink)', fontWeight: 700, fontSize: 14, marginBottom: 28 }}><Icon name="gift" size={16} color="var(--brand-ink)" />{t('Acquista o regala una gift card', 'Buy or gift a gift card')}</button>
              </React.Fragment>
            );
          })()}

          {/* ---- COUPON ---- distinti: sconti/omaggi una tantum ---- */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
            <div className="t-meta">{t('I tuoi coupon', 'Your coupons')}</div>
            <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>{W.coupons.length}</span>
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>{t('Sconti e omaggi da usare una volta.', 'Discounts and gifts to use once.')}</div>
          {W.coupons.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
              {W.coupons.map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 'var(--r-md)', border: '1.5px dashed var(--brand)', background: 'var(--paper-0)' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={c.kind === 'gift' ? 'gift' : 'coupon'} size={20} color="var(--brand-ink)" /></div>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 14.5 }}>{c.title[lang]}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{c.sub[lang]}</div></div>
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 99, background: 'var(--brand-tint)', color: 'var(--brand-ink)' }}>{couponTag(c)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '18px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--hair)', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5, marginBottom: 28 }}>{t('Nessun coupon attivo al momento.', 'No active coupons right now.')}</div>
          )}

          {/* ---- FEDELTÀ ---- distinti: accumulo continuo verso un premio ---- */}
          {activeProg.length > 0 && (
            <React.Fragment>
              <div className="t-meta" style={{ marginBottom: 4 }}>{t('Programmi fedeltà', 'Loyalty programs')}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>{t('Accumuli a ogni visita e sblocchi un premio.', 'Build up each visit and unlock a reward.')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activeProg.map(p => {
                  const prog = window.clientLoyalty('c1'); const val = prog[p.id] || 0; const done = Math.min(100, Math.round(val / p.threshold * 100)); const reached = val >= p.threshold;
                  return (
                    <div key={p.id} className="card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={p.type === 'points' ? 'star' : 'check'} size={17} color="var(--brand-ink)" /></div>
                        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 14 }}>{p.name[lang]}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{p.reward[lang]}</div></div>
                        <div className="t-num" style={{ fontSize: 15 }}>{val}<span style={{ color: 'var(--muted-2)', fontSize: 12 }}>/{p.threshold}</span></div>
                      </div>
                      <ProgressBar value={done} color="var(--brand)" />
                      {reached && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, fontSize: 12, fontWeight: 700, color: 'var(--ok)' }}><Icon name="check" size={13} color="var(--ok)" stroke={2.4} />{t('Premio raggiunto!', 'Reward unlocked!')}</div>}
                    </div>
                  );
                })}
              </div>
            </React.Fragment>
          )}
        </div>
      </div>
    );
  }

  // GIFT CARD — saldo prepagato della cliente + acquisto/regalo
  if (view === 'giftcard') {
    const cards = window.CLIENT_GIFTCARDS || [];
    const totBal = cards.reduce((s, g) => s + g.balance, 0);
    return wrap(
      <div style={{ paddingBottom: 30 }}>
        <ClientSubHead brand={brand} title={t('Gift card', 'Gift cards')} onBack={() => setView('home')} />
        <div style={{ padding: '8px 22px' }}>
          {/* saldo totale */}
          <div style={{ borderRadius: 'var(--r-lg, 20px)', padding: '20px 22px', background: 'var(--brand)', color: 'var(--brand-on)', marginBottom: 20 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, opacity: 0.82, letterSpacing: '0.04em' }}>{t('Saldo gift card', 'Gift card balance')}</div>
            <div className="t-num" style={{ fontSize: 38, fontWeight: 800, marginTop: 4 }}>{fmtEur(totBal, lang)}</div>
            <div style={{ fontSize: 12.5, opacity: 0.82, marginTop: 2 }}>{cards.length} {t('carte attive', 'active cards')} · {t('spendibili in salone', 'spend in salon')}</div>
          </div>

          {/* le tue carte */}
          <div className="t-meta" style={{ marginBottom: 12 }}>{t('Le tue carte', 'Your cards')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 26 }}>
            {cards.map(g => {
              const used = Math.round((1 - g.balance / g.value) * 100);
              return (
                <div key={g.id} className="card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                    <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="gift" size={21} color="var(--brand-ink)" /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{fmtEur(g.balance, lang)} <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>/ {fmtEur(g.value, lang)}</span></div>
                      <div className="t-sm" style={{ color: 'var(--muted)' }}>{g.from[lang]}</div>
                    </div>
                    <span className="tabnum" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--paper-2)', padding: '4px 9px', borderRadius: 8, letterSpacing: '0.04em' }}>{g.code}</span>
                  </div>
                  {used > 0 && <ProgressBar value={used} color="var(--brand)" />}
                  <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{g.expiry[lang]}</div>
                </div>
              );
            })}
            {!cards.length && <div style={{ padding: '18px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--hair)', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>{t('Nessuna gift card attiva.', 'No active gift cards.')}</div>}
          </div>

          {/* acquista / regala */}
          <div className="t-meta" style={{ marginBottom: 12 }}>{t('Regala o ricarica', 'Gift or top up')}</div>
          <button className="btn btn--brand btn--block press" style={{ marginBottom: 10 }} onClick={() => fireToast({ msg: t('Apriamo l’acquisto gift card…', 'Opening gift card purchase…'), icon: 'gift' })}><Icon name="gift" size={17} color="var(--brand-on)" />{t('Acquista una gift card', 'Buy a gift card')}</button>
          <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center' }}>{t('Scegli l’importo e inviala via WhatsApp o email.', 'Choose an amount and send it by WhatsApp or email.')}</div>
        </div>
      </div>
    );
  }

  // PROFILO — dati cliente + accesso a lista d'attesa, lingua, consensi
  if (view === 'profilo') {
    const c = window.client ? window.client('c1') : null;
    const name = (c && c.name) || 'Sofia Ricci';
    const initials = (c && c.initials) || 'SR';
    const phone = (c && (c.phoneWa || c.phone)) || '+39 348 221 0094';
    const email = (c && c.email) || 'sofia.ricci@email.it';
    const wl = (window.CLIENT_WAITLIST || []).length;
    const prog = window.clientLoyalty ? window.clientLoyalty('c1') : {};
    const points = Object.values(prog).reduce((s, v) => s + (v || 0), 0);
    const Row = ({ icon, title, sub, onClick, danger }) => (
      <button className="press" onClick={onClick} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13, padding: '14px 15px', borderRadius: 'var(--r-md)', background: 'var(--paper-0)', border: '1px solid var(--hair)', marginBottom: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: danger ? 'var(--danger-tint)' : 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={icon} size={20} color={danger ? 'var(--danger)' : 'var(--brand-ink)'} /></div>
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 14.5, color: danger ? 'var(--danger)' : 'var(--ink)' }}>{title}</div>{sub && <div className="t-sm" style={{ color: 'var(--muted)' }}>{sub}</div>}</div>
        {!danger && <Icon name="chevR" size={18} color="var(--muted-2)" />}
      </button>
    );
    return wrap(
      <div>
        <ClientSubHead brand={brand} title={t('Profilo', 'Profile')} onBack={() => setView('home')} />
        <div style={{ padding: '4px 22px' }}>
          {/* identity card */}
          <div className="card" style={{ padding: 20, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 15 }}>
            <div style={{ width: 60, height: 60, borderRadius: 99, background: 'var(--brand)', color: 'var(--brand-on)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 22, flexShrink: 0 }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: headFont(brand), fontSize: 22, fontWeight: brand.type === 'serif' ? 500 : 800, lineHeight: 1.1 }}>{name}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Cliente di', 'Client of')} {SALON.name}</div>
            </div>
          </div>

          {/* contact details */}
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('I tuoi dati', 'Your details')}</div>
          <div className="card" style={{ padding: 4, marginBottom: 20, boxShadow: 'none', border: '1px solid var(--hair)' }}>
            {[['phone', t('Telefono', 'Phone'), phone], ['mail', 'Email', email], ['star', t('Punti fedeltà', 'Loyalty points'), points + ' pt']].map(([ic, l, v], i) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                <Icon name={ic} size={18} color="var(--brand)" />
                <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{l}</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{v}</span>
              </div>
            ))}
          </div>

          {/* actions */}
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Gestione', 'Manage')}</div>
          <button className="press" onClick={() => setView('waitlist')} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14, padding: '16px 16px', borderRadius: 'var(--r-md)', background: 'var(--brand)', color: 'var(--brand-on)', marginBottom: 10, boxShadow: 'var(--sh-card)' }}>
            <div style={{ width: 44, height: 44, borderRadius: 13, background: 'rgba(255,255,255,0.18)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="clock" size={22} color="var(--brand-on)" /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{t('Lista d’attesa', 'Waiting list')}</div>
              <div style={{ fontSize: 13, opacity: 0.85, marginTop: 2 }}>{wl > 0 ? wl + ' ' + t('richieste attive · ti avvisiamo su WhatsApp', 'active requests · we’ll ping you on WhatsApp') : t('Nessuno slot libero? Mettiti in lista', 'No free slot? Join the list')}</div>
            </div>
            <Icon name="chevR" size={20} color="var(--brand-on)" />
          </button>

          {/* preferences */}
          <div className="t-meta" style={{ margin: '18px 0 10px' }}>{t('Preferenze', 'Preferences')}</div>
          <div className="card" style={{ padding: 4, marginBottom: 20, boxShadow: 'none', border: '1px solid var(--hair)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px' }}>
              <Icon name="globe" size={18} color="var(--brand)" />
              <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Lingua', 'Language')}</span>
              <div style={{ display: 'flex', gap: 4, background: 'var(--paper-2)', borderRadius: 99, padding: 3 }}>
                {['it', 'en'].map(l => <button key={l} className="press" onClick={() => setLang(l)} style={{ padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 700, background: lang === l ? 'var(--brand)' : 'transparent', color: lang === l ? 'var(--brand-on)' : 'var(--muted)' }}>{l.toUpperCase()}</button>)}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px', borderTop: '1px solid var(--hair)' }}>
              <Icon name="whatsapp" size={18} color="#3F9D58" />
              <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Promemoria WhatsApp', 'WhatsApp reminders')}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '3px 10px', borderRadius: 99 }}>{t('Attivi', 'On')}</span>
            </div>
          </div>

          <button className="press" onClick={() => setView('login')} style={{ width: '100%', textAlign: 'center', padding: '13px', borderRadius: 'var(--r-pill)', color: 'var(--muted)', fontWeight: 600, fontSize: 14 }}>{t('Esci', 'Log out')}</button>
        </div>
      </div>
    );
  }

  // LISTA D'ATTESA — richieste attive + iscrizione
  if (view === 'waitlist') {
    const list = window.CLIENT_WAITLIST || [];
    return wrap(
      <div style={{ paddingBottom: 30 }}>
        <ClientSubHead brand={brand} title={t('Lista d’attesa', 'Waiting list')} onBack={() => setView('home')} />
        <div style={{ padding: '8px 22px' }}>
          <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 18 }}>{t('Nessuno slot libero quando ti serve? Mettiti in lista: ti avvisiamo su WhatsApp appena si libera un posto.', 'No free slot when you need it? Join the list: we’ll message you on WhatsApp the moment one opens up.')}</div>

          {/* richieste attive */}
          {list.length > 0 && (
            <React.Fragment>
              <div className="t-meta" style={{ marginBottom: 12 }}>{t('Le tue richieste', 'Your requests')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                {list.map(w => (
                  <div key={w.id} className="card" style={{ padding: 15, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{w.service[lang]}</div>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: 'var(--brand-tint)', color: 'var(--brand-ink)', flexShrink: 0 }}>{t('In lista', 'Waiting')}</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                      <Meta icon="user" text={w.op[lang]} />
                      <Meta icon="clock" text={w.pref[lang]} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
                      <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('In lista', 'On the list')} {w.since[lang]}</span>
                      <button className="press" onClick={() => fireToast({ msg: t('Richiesta rimossa', 'Request removed'), icon: 'check' })} style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>{t('Rimuovi', 'Remove')}</button>
                    </div>
                  </div>
                ))}
              </div>
            </React.Fragment>
          )}

          <button className="btn btn--brand btn--block press" onClick={() => setView('waitlist-new')}><Icon name="plus" size={17} color="var(--brand-on)" />{t('Aggiungiti alla lista', 'Join the list')}</button>
        </div>
      </div>
    );
  }

  if (view === 'waitlist-new') return <ClientWaitlistForm brand={brand} t={t} lang={lang} wrap={wrap} onBack={() => setView('waitlist')} onDone={() => setView('success')} />;

  // PACCHETTI & OFFERTE — presentazione; prenotabili solo telefonicamente
  if (view === 'pacchetti') {
    const pkgs = (window.PACKAGES || []).filter(p => p.active);
    return wrap(
      <div style={{ paddingBottom: 30 }}>
        <ClientSubHead brand={brand} title={t('Pacchetti & offerte', 'Packages & offers')} onBack={() => setView('home')} />
        <div style={{ padding: '4px 22px' }}>
          {/* nota: solo telefonicamente */}
          <div style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '13px 15px', borderRadius: 'var(--r-md)', background: 'var(--brand-tint)', marginBottom: 20 }}>
            <Icon name="phone" size={19} color="var(--brand-ink)" />
            <div style={{ fontSize: 13.5, lineHeight: 1.45, color: 'var(--brand-ink)', fontWeight: 600 }}>{t('I pacchetti si prenotano chiamando il salone.', 'Packages are booked by calling the salon.')}</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {pkgs.map(p => {
              const orig = window.pkgOriginal(p);
              const off = orig ? Math.round((1 - p.price / orig) * 100) : 0;
              const services = p.serviceIds.map(id => window.svc(id) ? svcName(window.svc(id), lang) : '').filter(Boolean);
              return (
                <div key={p.id} className="card" style={{ padding: 18, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 4 }}>
                    <div style={{ fontFamily: headFont(brand), fontSize: 19, fontWeight: brand.type === 'serif' ? 500 : 700, lineHeight: 1.15, flex: 1, minWidth: 0 }}>{p.name[lang]}</div>
                    {off > 0 && <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 800, color: 'var(--brand-on)', background: 'var(--brand)', padding: '4px 10px', borderRadius: 99 }}>-{off}%</span>}
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--brand-ink)', background: 'var(--brand-tint)', padding: '3px 10px', borderRadius: 99 }}><Icon name="sparkle" size={12} color="var(--brand-ink)" />{p.occasion[lang]}</span>

                  <div className="t-sm" style={{ color: 'var(--muted)', margin: '13px 0', lineHeight: 1.5 }}>{p.desc[lang]}</div>

                  {/* servizi inclusi */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '13px 0', borderTop: '1px solid var(--hair)', borderBottom: '1px solid var(--hair)' }}>
                    {services.map((nm, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <Icon name="check" size={15} color="var(--brand)" stroke={2.4} />
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)' }}>{nm}</span>
                      </div>
                    ))}
                  </div>

                  {/* prezzo + deposito */}
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', margin: '14px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
                      <span className="t-num" style={{ fontSize: 26, color: 'var(--brand-ink)' }}>{fmtEur(p.price, lang)}</span>
                      {off > 0 && <span className="t-sm" style={{ color: 'var(--muted-2)', textDecoration: 'line-through' }}>{fmtEur(orig, lang)}</span>}
                    </div>
                    <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Acconto', 'Deposit')} {fmtEur(Math.round(p.price * p.depositPct / 100), lang)}</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
                    <Icon name="calendar" size={14} color="var(--muted-2)" />
                    <span className="t-sm" style={{ color: 'var(--muted)' }}>{p.period[lang]}</span>
                  </div>

                  <a href="tel:+390552100094" style={{ textDecoration: 'none' }}>
                    <div className="btn btn--brand btn--block press"><Icon name="phone" size={17} color="var(--brand-on)" />{t('Chiama per prenotare', 'Call to book')}</div>
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // LE TUE PRENOTAZIONI — future + storico
  if (view === 'prenotazioni') {
    const H = window.CLIENT_HISTORY || { upcoming: [], past: [] };
    const upcoming = [{ ...B, status: 'confermato' }, ...H.upcoming];
    const statusChip = (st) => {
      const map = {
        confermato: { l: t('Confermato', 'Confirmed'), bg: 'var(--ok-tint)', c: 'var(--ok)' },
        completato: { l: t('Completato', 'Completed'), bg: 'var(--paper-2)', c: 'var(--muted)' },
        annullato: { l: t('Annullato', 'Cancelled'), bg: 'var(--danger-tint)', c: 'var(--danger)' },
      };
      const m = map[st] || map.completato;
      return <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: m.bg, color: m.c, flexShrink: 0 }}>{m.l}</span>;
    };
    const Row = (bk, i, dim) => (
      <div key={i} className="card" style={{ padding: 15, marginBottom: 10, boxShadow: 'none', border: '1px solid var(--hair)', opacity: dim ? 0.72 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 15, flex: 1, lineHeight: 1.25 }}>{bk.service[lang]}</div>
          {statusChip(bk.status)}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
          <Meta icon="calendar" text={bk.date[lang]} />
          <Meta icon="clock" text={bk.time + ' · ' + fmtDur(bk.dur, lang)} />
          <Meta icon="user" text={bk.op} />
        </div>
      </div>
    );
    return wrap(
      <div style={{ paddingBottom: 30 }}>
        <ClientSubHead brand={brand} title={t('Le tue prenotazioni', 'Your bookings')} onBack={() => setView('home')} />
        <div style={{ padding: '8px 22px' }}>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('In programma', 'Upcoming')}</div>
          {upcoming.length ? upcoming.map((bk, i) => Row(bk, i, false))
            : <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '8px 0 16px' }}>{t('Nessun appuntamento in programma.', 'No upcoming appointments.')}</div>}
          <div className="t-meta" style={{ margin: '20px 0 10px' }}>{t('Storico', 'History')}</div>
          {H.past.map((bk, i) => Row(bk, 'p' + i, true))}
        </div>
      </div>
    );
  }

  // HOME — magic-link landing, directly on the booking
  const RowLink = ({ icon, title, sub, onClick, tint }) => (
    <button className="press" onClick={onClick} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderRadius: 'var(--r-md)', background: tint ? 'var(--brand-tint)' : 'var(--paper-0)', border: tint ? 'none' : '1px solid var(--hair)', marginBottom: 12 }}>
      <Icon name={icon} size={22} color="var(--brand-ink)" />
      <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--brand-ink)' }}>{title}</div>{sub && <div className="t-sm" style={{ color: 'var(--brand-ink)', opacity: 0.7 }}>{sub}</div>}</div>
      <Icon name="chevR" size={18} color="var(--brand-ink)" />
    </button>
  );
  const SalonFooter = () => (
    <div style={{ marginTop: 22, paddingTop: 22, borderTop: '1px solid var(--hair)', textAlign: 'center' }}>
      <div style={{ fontFamily: headFont(brand), fontSize: 20, fontWeight: brand.type === 'serif' ? 500 : 800 }}>{SALON.name}</div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>{SALON.addr}, {SALON.city}</div>
      <div className="t-sm" style={{ color: 'var(--muted)' }}>{SALON.hours[lang]}</div>
      <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 12 }}>
        {['mapPin', 'phone', 'whatsapp'].map(ic => <div key={ic} style={{ width: 40, height: 40, borderRadius: 99, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center' }}><Icon name={ic} size={18} color="var(--brand-ink)" /></div>)}
      </div>
      {/* demo states */}
      <div style={{ marginTop: 24, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        <span className="t-sm" style={{ color: 'var(--faint)', width: '100%' }}>{t('— stati demo —', '— demo states —')}</span>
        {[[() => setHasAppt(h => !h), hasAppt ? t('Senza appuntamento', 'No appointment') : t('Con appuntamento', 'With appointment')], [() => setView('expired'), t('Link scaduto', 'Expired')], [() => setView('login'), t('Accesso', 'Login')]].map(([fn, l], i) => (
          <button key={i} className="press" onClick={fn} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', background: 'var(--paper-2)', padding: '6px 12px', borderRadius: 99 }}>{l}</button>
        ))}
      </div>
    </div>
  );

  return wrap(
    <div style={{ paddingBottom: 40, position: 'relative' }}>
      <Utility />
      <Cover brand={brand} />
      <div style={{ padding: '20px 22px 0' }}>
        {hasAppt ? (
          <React.Fragment>
            <div className="t-meta" style={{ color: 'var(--brand-ink)', marginBottom: 12 }}>{t('Il tuo prossimo appuntamento', 'Your next appointment')}</div>
            <div className="card" style={{ padding: 18, marginBottom: 18 }}>
              {/* status chips — la conferma è lo scopo della schermata */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 99, background: 'var(--ok-tint)', color: 'var(--ok)', fontWeight: 700, fontSize: 12.5 }}><Icon name="check" size={14} color="var(--ok)" stroke={2.6} />{t('Confermato', 'Confirmed')}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 99, background: 'var(--brand-tint)', color: 'var(--brand-ink)', fontWeight: 700, fontSize: 12.5 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--brand-ink)' }} />{t('Deposito €' + B.deposit + ' versato', '€' + B.deposit + ' deposit paid')}</span>
              </div>
              {/* relative time — in evidenza */}
              <div style={{ fontFamily: headFont(brand), fontSize: 30, fontWeight: brand.type === 'serif' ? 500 : 800, color: 'var(--brand-ink)', lineHeight: 1, marginBottom: 14 }}>{B.rel[lang]}</div>
              {/* details */}
              <div style={{ fontFamily: 'var(--sans)', fontSize: 17, fontWeight: 700, lineHeight: 1.2 }}>{B.service[lang]}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 12 }}>
                <Meta icon="calendar" text={B.date[lang]} />
                <Meta icon="clock" text={B.time + ' · ' + fmtDur(B.dur, lang)} />
                <Meta icon="user" text={B.op} />
              </div>
              {/* card primary action — Sposta, secondary outline */}
              <button className="press" onClick={() => setView('sposta')} style={{ width: '100%', minHeight: 50, marginTop: 18, borderRadius: 'var(--r-pill)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'transparent', border: '1.5px solid var(--brand)', color: 'var(--brand-ink)', fontWeight: 700, fontSize: 15 }}><Icon name="calendar" size={17} color="var(--brand-ink)" />{t('Sposta appuntamento', 'Reschedule')}</button>
              {/* quick icon actions */}
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                {[['calendar', t('Aggiungi al calendario', 'Add to calendar')], ['mapPin', t('Indicazioni', 'Directions')]].map(([ic, l]) => (
                  <button key={ic} className="press" onClick={() => {}} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 8px', borderRadius: 'var(--r-md)', background: 'var(--paper-2)', color: 'var(--ink-2)' }}>
                    <Icon name={ic} size={20} color="var(--brand-ink)" />
                    <span style={{ fontSize: 11.5, fontWeight: 600, textAlign: 'center', lineHeight: 1.2 }}>{l}</span>
                  </button>
                ))}
              </div>
              {/* cancel — discreet text link + policy note */}
              <div style={{ textAlign: 'center', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--hair)' }}>
                <button className="press" onClick={() => setView('annulla')} style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textDecoration: 'underline', textUnderlineOffset: 3 }}>{t('Annulla appuntamento', 'Cancel appointment')}</button>
                <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>{t('Annullando entro 24h il deposito è rimborsabile.', 'Cancel within 24h and the deposit is refundable.')}</div>
              </div>
            </div>
          </React.Fragment>
        ) : (
          /* STATO VUOTO — invito a prenotare */
          <div className="card" style={{ padding: 24, marginBottom: 18, textAlign: 'center' }}>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}><Icon name="calendar" size={30} color="var(--brand-ink)" /></div>
            <div style={{ fontFamily: headFont(brand), fontSize: 22, fontWeight: brand.type === 'serif' ? 500 : 800, color: 'var(--brand-ink)', lineHeight: 1.15 }}>{t('Prenota il tuo prossimo appuntamento', 'Book your next appointment')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 8, maxWidth: 260, marginInline: 'auto' }}>{t('Non hai appuntamenti in programma da The Parlour.', 'You have no upcoming appointments at The Parlour.')}</div>
          </div>
        )}

        {/* UNICA CTA primaria piena */}
        <button className="btn btn--brand btn--block press" style={{ marginBottom: 18, height: 54 }} onClick={() => setView('prenota')}><Icon name="plus" size={18} color="var(--brand-on)" />{t('Prenota un appuntamento', 'Book an appointment')}</button>

        {/* navigazione */}
        <SalonFooter />
      </div>
    </div>
  );
}

function BookingSummary({ B, brand, lang, t, big }) {
  return (
    <React.Fragment>
      <div style={{ fontFamily: big ? headFont(brand) : 'var(--sans)', fontSize: big ? 22 : 17, fontWeight: big && brand.type === 'serif' ? 500 : 700, lineHeight: 1.2 }}>{B.service[lang]}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 12 }}>
        <Meta icon="calendar" text={B.date[lang]} />
        <Meta icon="clock" text={B.time + ' · ' + fmtDur(B.dur, lang)} />
        <Meta icon="user" text={B.op} />
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, padding: '5px 12px', borderRadius: 99, background: 'var(--ok-tint)', color: 'var(--ok)', fontWeight: 700, fontSize: 12.5 }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--ok)' }} />{t('Deposito €' + B.deposit + ' versato', '€' + B.deposit + ' deposit paid')}
      </div>
    </React.Fragment>
  );
}
function Meta({ icon, text }) { return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}><Icon name={icon} size={15} color="var(--brand)" />{text}</span>; }

function ClientSubHead({ brand, title, onBack }) {
  return (
    <div style={{ paddingTop: 'var(--safe-top)', padding: '0 16px', ...brandVars(brand) }}>
      <div style={{ paddingTop: 'var(--safe-top)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10 }}>
        <button className="press" onClick={onBack} style={{ width: 42, height: 42, marginLeft: -8, borderRadius: 99, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="chevL" size={24} /></button>
        <div style={{ flex: 1, minWidth: 0, fontFamily: headFont(brand), fontSize: 21, fontWeight: brand.type === 'serif' ? 500 : 700, lineHeight: 1.15 }}>{title}</div>
      </div>
    </div>
  );
}

function ClientEdge({ brand, icon, title, sub, cta, onCta }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 30, textAlign: 'center', ...brandVars(brand) }}>
      <div style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', marginBottom: 18 }}><Icon name={icon} size={34} color="var(--brand-ink)" /></div>
      <div style={{ fontFamily: headFont(brand), fontSize: 24, fontWeight: brand.type === 'serif' ? 500 : 800 }}>{title}</div>
      <div className="t-body" style={{ color: 'var(--muted)', marginTop: 10, maxWidth: 280 }}>{sub}</div>
      <button className="btn btn--brand press" style={{ marginTop: 24 }} onClick={onCta}>{cta}</button>
    </div>
  );
}

function ClientLogin({ brand, onDone, wrap }) {
  const { t } = useApp();
  const [step, setStep] = useStateClt(0);
  const [num, setNum] = useStateClt('');
  return wrap(
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 30, ...brandVars(brand) }}>
      <div style={{ fontFamily: headFont(brand), fontSize: 28, fontWeight: brand.type === 'serif' ? 500 : 800, textAlign: 'center' }}>{SALON.name}</div>
      {step === 0 ? (
        <div className="fade-in" style={{ marginTop: 30 }}>
          <div className="t-body" style={{ textAlign: 'center', color: 'var(--muted)', marginBottom: 24 }}>{t('Inserisci il tuo numero. Niente password, mai.', 'Enter your number. No password, ever.')}</div>
          <input value={num} onChange={e => setNum(e.target.value)} placeholder="+39 ___ ___ ____" inputMode="tel" style={{ width: '100%', textAlign: 'center', fontSize: 20, fontWeight: 600, padding: '16px', border: '1.5px solid var(--hair)', borderRadius: 'var(--r-md)', outline: 'none', background: 'var(--paper-0)' }} />
          <button className="btn btn--brand btn--block press" style={{ marginTop: 16 }} onClick={() => setStep(1)}>{t('Inviami il link', 'Send me the link')}</button>
        </div>
      ) : (
        <div className="fade-in" style={{ marginTop: 30, textAlign: 'center' }}>
          <div style={{ width: 76, height: 76, borderRadius: 99, background: '#E7F3EA', display: 'grid', placeItems: 'center', margin: '0 auto 20px' }}><Icon name="whatsapp" size={36} color="#3F9D58" /></div>
          <div style={{ fontFamily: headFont(brand), fontSize: 20, fontWeight: brand.type === 'serif' ? 500 : 700 }}>{t('Ti abbiamo inviato un link', 'We sent you a link')}</div>
          <div className="t-body" style={{ color: 'var(--muted)', marginTop: 8 }}>{t('Controlla WhatsApp e tocca il link per entrare.', 'Check WhatsApp and tap the link to get in.')}</div>
          <button className="btn btn--brand btn--block press" style={{ marginTop: 24 }} onClick={onDone}><Icon name="whatsapp" size={18} color="var(--brand-on)" />{t('Apri il link (demo)', 'Open the link (demo)')}</button>
        </div>
      )}
    </div>
  );
}

/* ================= BRAND / ASPETTO editor (staff) ================= */
function BrandEditor({ onBack }) {
  const { t, lang, brand, setParlourAccent, setClientType, fireToast } = useApp();
  const accents = ['#7C4A57', '#3E5C4B', '#1F1F21', '#B5862F', '#5E748C'];
  const aaPass = true; // curated palette guarantees AA on white text
  return (
    <div className="scroll" style={{ height: '100%', overflowY: 'auto', background: 'var(--paper)' }}>
      <SubHeader title={t('Brand / Aspetto', 'Brand / Appearance')} onBack={onBack} sub={t('App cliente · The Parlour', 'Client app · The Parlour')}
        right={<button className="press" onClick={() => { onBack(); fireToast({ msg: t('Aspetto salvato', 'Appearance saved'), icon: 'check' }); }} style={{ padding: '9px 16px', borderRadius: 99, background: 'var(--ink)', color: '#fff', fontWeight: 700, fontSize: 13 }}>{t('Salva', 'Save')}</button>} />
      <div style={{ padding: '4px 20px 120px' }}>
        {/* live preview */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Anteprima dal vivo', 'Live preview')}</div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, overflowX: 'auto', paddingBottom: 6 }} className="scroll">
          <PreviewPhone brand={brand} lang={lang} t={t} />
          <PreviewMsg brand={brand} t={t} />
        </div>

        {/* logo */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Logo', 'Logo')}</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
          {[t('Chiaro', 'Light'), t('Scuro', 'Dark')].map((l, i) => (
            <div key={l} style={{ flex: 1, height: 84, borderRadius: 'var(--r-md)', background: i ? 'var(--ink)' : 'var(--surface)', border: '1.5px dashed ' + (i ? 'rgba(255,255,255,0.2)' : 'var(--line-strong)'), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Icon name="plus" size={20} color={i ? '#fff' : 'var(--muted)'} />
              <span style={{ fontSize: 11.5, fontWeight: 600, color: i ? 'rgba(255,255,255,0.6)' : 'var(--muted)' }}>{l}</span>
            </div>
          ))}
        </div>

        {/* color */}
        <div className="t-meta" style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('Colore brand', 'Brand colour')}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '3px 8px', borderRadius: 99 }}><Icon name="check" size={11} stroke={2.6} color="var(--ok)" />{t('Contrasto AA garantito', 'AA contrast guaranteed')}</span>
        </div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
          {accents.map(c => { const on = brand.color === c; return (
            <button key={c} className="press" onClick={() => setParlourAccent(c)} style={{ width: 46, height: 46, borderRadius: 99, background: c, border: '3px solid ' + (on ? 'var(--ink)' : 'transparent'), boxShadow: on ? '0 0 0 2px var(--paper)' : 'var(--sh-sm)', display: 'grid', placeItems: 'center' }}>{on && <Icon name="check" size={20} color={onColor(c)} stroke={2.6} />}</button>
          ); })}
        </div>

        {/* type */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Tipografia (abbinamenti curati)', 'Typography (curated pairings)')}</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
          {[['serif', t('Editoriale', 'Editorial'), 'var(--serif)', 500], ['grotesk', t('Pulita', 'Clean'), 'var(--sans)', 800]].map(([k, l, f, w]) => {
            const on = brand.type === k;
            return (
              <button key={k} className="press" onClick={() => setClientType(k)} style={{ flex: 1, padding: '16px 14px', borderRadius: 'var(--r-md)', border: '1.5px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', textAlign: 'left' }}>
                <div style={{ fontFamily: f, fontSize: 22, fontWeight: w, color: 'var(--ink)' }}>Aa</div>
                <div className="t-sm" style={{ fontWeight: 600, marginTop: 6, color: on ? 'var(--clay-ink)' : 'var(--muted)' }}>{l}</div>
              </button>
            );
          })}
        </div>

        {/* dati / dominio */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Dati salone', 'Salon details')}</div>
        <div className="card" style={{ padding: 6, marginBottom: 16 }}>
          {[['mapPin', SALON.addr + ', ' + SALON.city], ['globe', 'prenota.theparlour.it'], ['phone', '+39 055 21 00 94'], ['heart', SALON.ig]].map(([ic, v], i) => (
            <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 12px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
              <Icon name={ic} size={18} color="var(--muted)" />
              <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{v}</span>
              <Icon name="edit" size={15} color="var(--faint)" />
            </div>
          ))}
        </div>
        <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center' }}>{t('Le modifiche si applicano a tutta la superficie cliente e ai messaggi.', 'Changes apply across the whole client surface and messages.')}</div>
      </div>
    </div>
  );
}

function PreviewPhone({ brand, lang, t }) {
  return (
    <div style={{ flexShrink: 0, width: 168, borderRadius: 22, overflow: 'hidden', border: '5px solid var(--ink)', background: 'var(--paper-0)', boxShadow: 'var(--sh-card)', ...brandVars(brand) }}>
      <Cover brand={brand} h={94} />
      <div style={{ padding: 12 }}>
        <div style={{ height: 8, width: '70%', borderRadius: 4, background: 'var(--brand-tint)', marginBottom: 8 }} />
        <div style={{ height: 6, width: '90%', borderRadius: 4, background: 'var(--paper-2)', marginBottom: 5 }} />
        <div style={{ height: 6, width: '55%', borderRadius: 4, background: 'var(--paper-2)', marginBottom: 12 }} />
        <div style={{ height: 30, borderRadius: 99, background: 'var(--brand)', display: 'grid', placeItems: 'center', color: 'var(--brand-on)', fontSize: 11, fontWeight: 700 }}>{t('Prenota', 'Book')}</div>
      </div>
    </div>
  );
}
function PreviewMsg({ brand, t }) {
  return (
    <div style={{ flexShrink: 0, width: 168, borderRadius: 18, overflow: 'hidden', boxShadow: 'var(--sh-card)' }}>
      <div style={{ background: '#075E54', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 26, height: 26, borderRadius: 99, background: brand.color, display: 'grid', placeItems: 'center', color: onColor(brand.color), fontWeight: 800, fontSize: 12 }}>P</div>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: 12 }}>The Parlour</span>
      </div>
      <div style={{ background: '#E5DDD3', padding: 12, minHeight: 110 }}>
        <div style={{ background: '#fff', borderRadius: '4px 12px 12px 12px', padding: '8px 10px', fontSize: 11.5, lineHeight: 1.4, color: 'var(--ink-2)' }}>{t('Ciao Sofia! Ti aspettiamo giovedì alle 15:30 💫', 'Hi Sofia! See you Thursday at 15:30 💫')}</div>
      </div>
    </div>
  );
}

/* ================= CLIENT BOOKING (agenda-aware) ================= */
const BK_DAYS = [
  { it: 'Gio 14 nov', en: 'Thu 14 Nov', today: true },
  { it: 'Ven 15 nov', en: 'Fri 15 Nov', today: false },
  { it: 'Sab 16 nov', en: 'Sat 16 Nov', today: false },
  { it: 'Mar 19 nov', en: 'Tue 19 Nov', today: false },
];
const BK_CAT_ICON = { nail: 'sparkle', hair: 'scissors', viso: 'drop', extra: 'star' };
const bkCatIcon = (c) => BK_CAT_ICON[c] || 'sparkle';
function bkSlotFree(opId, start, dur, today) {
  if (!today) return true;
  const appts = window.APPTS || [];
  return !appts.some(a => a.opId === opId && a.status !== 'noshow' && start < window.apptEnd(a) && start + dur > a.start);
}
function ClientBooking({ brand, t, lang, wrap, onBack, onDone }) {
  const [step, setStep] = useStateClt(-1);     // -1 choice · 0 service · 1 op · 2 time · 3 review
  const [bkMode, setBkMode] = useStateClt('single'); // single | pkg
  const [serviceIds, setServiceIds] = useStateClt([]);
  const [opBy, setOpBy] = useStateClt({}); // serviceId → opId | 'any'
  const [dayIdx, setDayIdx] = useStateClt(0);
  const [start, setStart] = useStateClt(null);
  const bv = brandVars(brand);
  const services = (window.SERVICES || []).filter(s => window.svcMeta(s.id).online && window.svcMeta(s.id).active);
  const svcs = serviceIds.map(id => window.svc(id)).filter(Boolean);
  const s = svcs[0]; // primary (icon/category)
  const eligFor = (sv) => OPS.filter(o => (window.svcOpsClient ? window.svcOpsClient[sv.id] : sv.ops).includes(o.id));
  // primary operator for slot availability: first specific pick, else first eligible of first service
  const opId = (() => {
    const spec = svcs.map(sv => opBy[sv.id]).find(x => x && x !== 'any');
    if (spec) return spec;
    const e = s ? eligFor(s) : [];
    return e[0] ? e[0].id : null;
  })();
  const allChosen = svcs.every(sv => opBy[sv.id]); // each service has 'any' or a specific op
  const dur = svcs.reduce((sum, sv) => { const ov = opBy[sv.id]; const o = ov && ov !== 'any' ? ov : opId; return sum + (o ? window.svcDur(sv.id, o) : sv.dur); }, 0);
  const price = svcs.reduce((sum, sv) => sum + sv.price, 0);
  const depo = svcs.reduce((sum, sv) => { const m = window.svcMeta(sv.id); return sum + (m.depositOn ? Math.round(sv.price * m.depositPct / 100) : 0); }, 0);
  const toggleSvc = (id) => setServiceIds(l => l.includes(id) ? l.filter(x => x !== id) : [...l, id]);
  const slots = []; for (let m = 540; m <= 1140 - dur; m += 30) slots.push(m);
  const head = (title) => <ClientSubHead brand={brand} title={title} onBack={step <= -1 ? onBack : () => setStep(step - 1)} />;
  const STEP_INFO = [['Servizio', 'Service'], ['Operatrice', 'Stylist'], ['Giorno e ora', 'Day & time']];
  const StepBar = ({ i }) => (
    <div style={{ padding: '10px 22px 20px', ...bv }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
        {[0, 1, 2].map(n => <div key={n} style={{ flex: 1, height: 4, borderRadius: 99, background: n <= i ? 'var(--brand)' : 'var(--hair)', transition: 'background 220ms' }} />)}
      </div>
      <div className="t-meta" style={{ color: 'var(--brand-ink)' }}>{t('Passo', 'Step')} {i + 1} {t('di', 'of')} 3 · {t(STEP_INFO[i][0], STEP_INFO[i][1])}</div>
    </div>
  );
  // service (+ optional stylist) recap chip, shown on later steps
  const SummaryChip = ({ withOp }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--brand-tint)', marginBottom: 18 }}>
      <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--paper-0)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={bkCatIcon(s.cat)} size={19} color="var(--brand-ink)" /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--brand-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{svcs.map(sv => svcName(sv, lang)).join(' + ')}</div>
        <div className="t-sm" style={{ color: 'var(--brand-ink)', opacity: 0.72 }}>{fmtDur(dur, lang)} · {fmtEur(price, lang)}{withOp && opId ? ' · ' + op(opId).name : ''}</div>
      </div>
    </div>
  );

  // -1: choice — book in-app or contact
  if (step === -1) return wrap(
    <div style={{ paddingBottom: 30 }}>
      {head(t('Prenota', 'Book'))}
      <div style={{ padding: '4px 22px' }}>
        <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 22, maxWidth: 320 }}>{t('Come preferisci prenotare da The Parlour?', 'How would you like to book at The Parlour?')}</div>

        {/* hero — recommended */}
        <button className="press" onClick={() => setStep(0)} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 15, padding: '20px 18px', borderRadius: 'var(--r-lg, 20px)', background: 'var(--brand)', color: 'var(--brand-on)', marginBottom: 22, boxShadow: 'var(--sh-card)' }}>
          <div style={{ width: 50, height: 50, borderRadius: 15, background: 'rgba(255,255,255,0.16)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="calendar" size={26} color="var(--brand-on)" /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '3px 9px', borderRadius: 99, background: 'rgba(255,255,255,0.2)', marginBottom: 7 }}>{t('Consigliato', 'Recommended')}</span>
            <div style={{ fontWeight: 700, fontSize: 18, lineHeight: 1.1 }}>{t('Prenota nell’app', 'Book in the app')}</div>
            <div style={{ fontSize: 13, opacity: 0.82, marginTop: 3 }}>{t('In 3 passaggi, solo orari liberi', '3 steps, only free times')}</div>
          </div>
          <Icon name="chevR" size={20} color="var(--brand-on)" />
        </button>

        <div className="t-meta" style={{ marginBottom: 12 }}>{t('Oppure contattaci', 'Or get in touch')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <a href="tel:+390552100094" style={{ textDecoration: 'none' }}>
            <div className="press" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 15, borderRadius: 'var(--r-md)', border: '1px solid var(--hair)', background: 'var(--paper-0)' }}>
              <div style={{ width: 44, height: 44, borderRadius: 99, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="phone" size={21} color="var(--brand-ink)" /></div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 15.5, color: 'var(--ink)' }}>{t('Chiama il salone', 'Call the salon')}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>+39 055 21 00 94</div></div>
              <Icon name="chevR" size={18} color="var(--muted-2)" />
            </div>
          </a>
          <a href="https://wa.me/390552100094" target="_blank" rel="noopener" style={{ textDecoration: 'none' }}>
            <div className="press" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 15, borderRadius: 'var(--r-md)', border: '1px solid var(--hair)', background: 'var(--paper-0)' }}>
              <div style={{ width: 44, height: 44, borderRadius: 99, background: '#E7F3EA', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="whatsapp" size={21} color="#3F9D58" /></div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 15.5, color: 'var(--ink)' }}>{t('Scrivi su WhatsApp', 'Message on WhatsApp')}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Risposta in giornata', 'Reply within the day')}</div></div>
              <Icon name="chevR" size={18} color="var(--muted-2)" />
            </div>
          </a>
        </div>
      </div>
    </div>
  );

  // 0: choose service — grouped by category
  if (step === 0) {
    const groups = (window.CATS || []).map(c => ({ cat: c, items: services.filter(sv => sv.cat === c.id) })).filter(g => g.items.length);
    const pkgs = (window.PACKAGES || []).filter(p => p.active);
    return wrap(
      <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        {head(t('Scegli il servizio', 'Choose a service'))}
        <StepBar i={0} />
        <div style={{ padding: '0 22px', ...bv }}>
          {/* singolo servizio vs pacchetto */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--paper-2)', borderRadius: 99, padding: 4, marginBottom: 8 }}>
            {[['single', t('Servizi singoli', 'Single services')], ['pkg', t('Pacchetti', 'Packages')]].map(([k, l]) => { const on = (bkMode || 'single') === k; return (
              <button key={k} className="press" onClick={() => setBkMode(k)} style={{ flex: 1, padding: '9px', borderRadius: 99, fontSize: 13, fontWeight: 700, background: on ? 'var(--brand)' : 'transparent', color: on ? 'var(--brand-on)' : 'var(--muted)' }}>{l}</button>
            ); })}
          </div>
          {(bkMode || 'single') === 'single' && <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('Puoi selezionare più servizi per la stessa visita.', 'You can pick more than one service for the same visit.')}</div>}

          {(bkMode || 'single') === 'single' ? groups.map((g, gi) => (
            <div key={g.cat.id} style={{ marginBottom: gi === groups.length - 1 ? 0 : 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                <Icon name={bkCatIcon(g.cat.id)} size={15} color="var(--brand-ink)" />
                <span className="t-meta">{g.cat.name[lang]}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {g.items.map(sv => { const on = serviceIds.includes(sv.id); const depoOn = window.svcMeta(sv.id).depositOn; return (
                  <button key={sv.id} className="press" onClick={() => toggleSvc(sv.id)} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 15, borderRadius: 'var(--r-md)', textAlign: 'left', border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand-tint)' : 'var(--paper-0)' }}>
                    <div style={{ width: 24, height: 24, borderRadius: 8, flexShrink: 0, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--line-strong)'), background: on ? 'var(--brand)' : 'transparent', display: 'grid', placeItems: 'center' }}>{on && <Icon name="check" size={15} color="var(--brand-on)" stroke={2.6} />}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{svcName(sv, lang)}</div>
                      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="clock" size={13} color="var(--muted-2)" />{fmtDur(sv.dur, lang)}</span>
                        {depoOn && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-ink)', background: 'var(--brand-tint)', padding: '2px 8px', borderRadius: 99 }}>{t('Deposito', 'Deposit')}</span>}
                      </div>
                    </div>
                    <span className="t-num" style={{ fontSize: 17, color: 'var(--brand-ink)', flexShrink: 0 }}>{sv.price === 0 ? t('Gratis', 'Free') : fmtEur(sv.price, lang)}</span>
                  </button>
                ); })}
              </div>
            </div>
          )) : (
            <React.Fragment>
              <div style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--brand-tint)', marginBottom: 16 }}>
                <Icon name="phone" size={18} color="var(--brand-ink)" />
                <div style={{ fontSize: 13, lineHeight: 1.4, color: 'var(--brand-ink)', fontWeight: 600 }}>{t('I pacchetti si prenotano chiamando il salone.', 'Packages are booked by calling the salon.')}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {pkgs.map(p => {
                  const orig = window.pkgOriginal(p); const off = orig ? Math.round((1 - p.price / orig) * 100) : 0;
                  const svcs = p.serviceIds.map(id => window.svc(id) ? svcName(window.svc(id), lang) : '').filter(Boolean);
                  return (
                    <div key={p.id} className="card" style={{ padding: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                        <div style={{ fontFamily: headFont(brand), fontSize: 17, fontWeight: brand.type === 'serif' ? 500 : 700, lineHeight: 1.15, flex: 1, minWidth: 0 }}>{p.name[lang]}</div>
                        {off > 0 && <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 800, color: 'var(--brand-on)', background: 'var(--brand)', padding: '3px 9px', borderRadius: 99 }}>-{off}%</span>}
                      </div>
                      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 11, lineHeight: 1.45 }}>{svcs.join(' · ')}</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span className="t-num" style={{ fontSize: 22, color: 'var(--brand-ink)' }}>{fmtEur(p.price, lang)}</span>
                          {off > 0 && <span className="t-sm" style={{ color: 'var(--muted-2)', textDecoration: 'line-through' }}>{fmtEur(orig, lang)}</span>}
                        </div>
                        <a href="tel:+390552100094" style={{ textDecoration: 'none' }}><div className="press" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 'var(--r-pill)', background: 'var(--brand)', color: 'var(--brand-on)', fontWeight: 700, fontSize: 13.5 }}><Icon name="phone" size={15} color="var(--brand-on)" />{t('Chiama', 'Call')}</div></a>
                      </div>
                    </div>
                  );
                })}
              </div>
            </React.Fragment>
          )}
        </div>
        {(bkMode || 'single') === 'single' && (
          <React.Fragment>
            <div style={{ flex: 1 }} />
            <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(var(--safe-bottom) + 14px)', background: 'linear-gradient(transparent, var(--paper-0) 24%)', ...bv }}>
              <button className="btn btn--brand btn--block press" disabled={!serviceIds.length} style={{ opacity: serviceIds.length ? 1 : 0.4 }} onClick={() => { setStart(null); setStep(1); }}>{serviceIds.length > 1 ? t(`Continua · ${serviceIds.length} servizi · ${fmtEur(price, lang)}`, `Continue · ${serviceIds.length} services · ${fmtEur(price, lang)}`) : t('Continua', 'Continue')}</button>
            </div>
          </React.Fragment>
        )}
      </div>
    );
  }
  if (step === 1) {
    const multiSvc = svcs.length > 1;
    const OpChoices = ({ sv, compact }) => {
      const list = eligFor(sv); const cur = opBy[sv.id];
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 10 }}>
          <button className="press" onClick={() => { setOpBy(m => ({ ...m, [sv.id]: 'any' })); if (!multiSvc) { setStart(null); setStep(2); } }} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: compact ? 12 : 14, borderRadius: 'var(--r-md)', textAlign: 'left', border: '1.5px solid ' + (cur === 'any' ? 'var(--brand)' : 'var(--hair)'), background: cur === 'any' ? 'var(--brand-tint)' : 'var(--paper-0)' }}>
            <div style={{ width: compact ? 36 : 42, height: compact ? 36 : 42, borderRadius: 99, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="clients" size={compact ? 17 : 20} color="var(--brand-ink)" /></div>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: compact ? 14 : 15 }}>{t('Qualsiasi operatrice', 'Any stylist')}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Prima disponibilità', 'First availability')}</div></div>
            {cur === 'any' ? <Icon name="check" size={18} color="var(--brand)" stroke={2.4} /> : (!multiSvc && <Icon name="chevR" size={17} color="var(--muted-2)" />)}
          </button>
          {list.map(o => { const on = cur === o.id; return (
            <button key={o.id} className="press" onClick={() => { setOpBy(m => ({ ...m, [sv.id]: o.id })); if (!multiSvc) { setStart(null); setStep(2); } }} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: compact ? 12 : 14, borderRadius: 'var(--r-md)', textAlign: 'left', border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand-tint)' : 'var(--paper-0)' }}>
              <Avatar initials={o.initials} size={compact ? 36 : 44} color={o.color} ring />
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: compact ? 14 : 15 }}>{o.name}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{o.role[lang]}</div></div>
              {on ? <Icon name="check" size={18} color="var(--brand)" stroke={2.4} /> : (!multiSvc && <Icon name="chevR" size={17} color="var(--muted-2)" />)}
            </button>
          ); })}
        </div>
      );
    };
    return wrap(
      <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        {head(t('Scegli l’operatrice', 'Choose a stylist'))}
        <StepBar i={1} />
        <div style={{ padding: '0 22px', ...bv }}>
          <SummaryChip />
          {multiSvc ? (
            <React.Fragment>
              <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('Scegli chi esegue ogni servizio, o lascia “qualsiasi”.', 'Pick who does each service, or leave it to “any”.')}</div>
              {svcs.map((sv, i) => (
                <div key={sv.id} style={{ marginBottom: i === svcs.length - 1 ? 0 : 22 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                    <Icon name={bkCatIcon(sv.cat)} size={15} color="var(--brand-ink)" />
                    <span className="t-meta">{svcName(sv, lang)}</span>
                  </div>
                  <OpChoices sv={sv} compact />
                </div>
              ))}
            </React.Fragment>
          ) : (
            <React.Fragment>
              <div className="t-meta" style={{ marginBottom: 11 }}>{t('Con chi preferisci', 'Who you’d prefer')}</div>
              {s && <OpChoices sv={s} />}
            </React.Fragment>
          )}
        </div>
        {multiSvc && (
          <React.Fragment>
            <div style={{ flex: 1 }} />
            <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(var(--safe-bottom) + 14px)', background: 'linear-gradient(transparent, var(--paper-0) 24%)', ...bv }}>
              <button className="btn btn--brand btn--block press" disabled={!allChosen} style={{ opacity: allChosen ? 1 : 0.4 }} onClick={() => { setStart(null); setStep(2); }}>{t('Continua', 'Continue')}</button>
            </div>
          </React.Fragment>
        )}
      </div>
    );
  }

  // 2: choose day + time (only free slots, agenda-aware)
  if (step === 2) {
    const day = BK_DAYS[dayIdx];
    const free = slots.filter(m => bkSlotFree(opId, m, dur, day.today));
    const morning = free.filter(m => m < 720);
    const afternoon = free.filter(m => m >= 720);
    const TimeGrid = ({ list }) => (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 9 }}>
        {list.map(m => { const on = start === m; return (
          <button key={m} className="press tabnum" onClick={() => setStart(m)} style={{ padding: '13px 0', borderRadius: 12, fontWeight: 700, fontSize: 14.5, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)' }}>{timeLabel(m)}</button>
        ); })}
      </div>
    );
    return wrap(
      <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        {head(t('Scegli giorno e ora', 'Choose day & time'))}
        <StepBar i={2} />
        <div style={{ padding: '0 22px', ...bv }}>
          <SummaryChip withOp />
          <div style={{ display: 'flex', gap: 9, overflowX: 'auto', paddingBottom: 6, marginBottom: 20, marginInline: -2, paddingInline: 2 }} className="scroll">
            {BK_DAYS.map((d, i) => { const on = i === dayIdx; const parts = d[lang].split(' '); return (
              <button key={i} className="press" onClick={() => { setDayIdx(i); setStart(null); }} style={{ flexShrink: 0, minWidth: 62, padding: '9px 14px', borderRadius: 14, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, opacity: on ? 0.85 : 0.6 }}>{parts[0]}</span>
                <span className="tabnum" style={{ fontSize: 15, fontWeight: 800 }}>{parts[1]}</span>
              </button>
            ); })}
          </div>
          {free.length ? (
            <React.Fragment>
              {morning.length > 0 && <div style={{ marginBottom: afternoon.length ? 18 : 0 }}>
                <div className="t-meta" style={{ marginBottom: 10 }}>{t('Mattina', 'Morning')}</div>
                <TimeGrid list={morning} />
              </div>}
              {afternoon.length > 0 && <div>
                <div className="t-meta" style={{ marginBottom: 10 }}>{t('Pomeriggio', 'Afternoon')}</div>
                <TimeGrid list={afternoon} />
              </div>}
            </React.Fragment>
          ) : (
            <div style={{ padding: '28px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--hair)', textAlign: 'center' }}>
              <Icon name="clock" size={26} color="var(--muted-2)" />
              <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 8, marginBottom: 14 }}>{t('Nessun orario libero questo giorno. Prova un altro giorno o mettiti in lista d’attesa.', 'No free time this day. Try another day or join the waiting list.')}</div>
              <button className="press" onClick={() => { try { localStorage.setItem('yr_wl', '1'); } catch (e) {} onBack(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 99, background: 'var(--brand-tint)', color: 'var(--brand-ink)', fontWeight: 700, fontSize: 13.5 }}><Icon name="clock" size={15} color="var(--brand-ink)" />{t('Vai alla lista d’attesa', 'Go to waiting list')}</button>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(var(--safe-bottom) + 14px)', background: 'linear-gradient(transparent, var(--paper-0) 24%)', ...bv }}>
          <button className="btn btn--brand btn--block press" disabled={start == null} style={{ opacity: start == null ? 0.4 : 1 }} onClick={() => setStep(3)}>{t('Continua', 'Continue')}</button>
        </div>
      </div>
    );
  }

  // 3: review + confirm
  const day = BK_DAYS[dayIdx];
  return wrap(
    <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {head(t('Conferma prenotazione', 'Confirm booking'))}
      <div style={{ padding: '4px 22px', ...bv }}>
        <div className="card" style={{ padding: 20, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--hair)' }}>
            <div style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={bkCatIcon(s.cat)} size={23} color="var(--brand-ink)" /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: headFont(brand), fontSize: 19, fontWeight: brand.type === 'serif' ? 500 : 700, lineHeight: 1.2 }}>{svcs.map(sv => svcName(sv, lang)).join(' + ')}</div>
            </div>
          </div>
          {svcs.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--hair)' }}>
              {svcs.map(sv => (
                <div key={sv.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
                  <span style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{svcName(sv, lang)}</span>
                  <span className="t-num" style={{ color: 'var(--muted)' }}>{sv.price === 0 ? t('Gratis', 'Free') : fmtEur(sv.price, lang)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            <DetailRow icon="calendar" label={t('Quando', 'When')} value={day[lang] + ' · ' + timeLabel(start)} />
            <DetailRow icon="clock" label={t('Durata', 'Duration')} value={fmtDur(dur, lang)} />
            {svcs.length > 1
              ? svcs.map(sv => { const ov = opBy[sv.id]; const nm = ov && ov !== 'any' ? op(ov).name : t('Qualsiasi', 'Any'); return <DetailRow key={sv.id} icon="user" label={svcName(sv, lang)} value={nm} />; })
              : <DetailRow icon="user" label={t('Operatrice', 'Stylist')} value={opBy[s.id] && opBy[s.id] !== 'any' ? op(opBy[s.id]).name : t('Qualsiasi operatrice', 'Any stylist')} />}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--hair)' }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{t('Totale', 'Total')}</span><span className="t-num" style={{ fontSize: 22, color: 'var(--brand-ink)' }}>{price === 0 ? t('Gratis', 'Free') : fmtEur(price, lang)}</span>
          </div>
        </div>
        {depo > 0 && (
          <div style={{ display: 'flex', gap: 12, padding: 15, background: 'var(--brand-tint)', borderRadius: 'var(--r-md)', marginBottom: 14 }}>
            <Icon name="coupon" size={20} color="var(--brand-ink)" />
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>{t(`Per confermare è richiesto un deposito di €${depo} (scalato dal totale).`, `A €${depo} deposit is required to confirm (deducted from total).`)}</div>
          </div>
        )}
        <div className="t-sm" style={{ color: 'var(--muted)', display: 'flex', alignItems: 'flex-start', gap: 7 }}><Icon name="check" size={14} color="var(--ok)" stroke={2.4} /><span style={{ flex: 1 }}>{t('L’orario è confermato e non si sovrappone ad altri appuntamenti.', 'This time is confirmed and doesn’t overlap other bookings.')}</span></div>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(var(--safe-bottom) + 14px)', background: 'linear-gradient(transparent, var(--paper-0) 24%)', ...bv }}>
        <button className="btn btn--brand btn--block press" onClick={onDone}><Icon name="check" size={18} color="var(--brand-on)" />{depo > 0 ? t(`Conferma e versa €${depo}`, `Confirm & pay €${depo}`) : t('Conferma prenotazione', 'Confirm booking')}</button>
      </div>
    </div>
  );
}

/* review detail line */
function DetailRow({ icon, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <Icon name={icon} size={17} color="var(--brand)" />
      <span className="t-sm" style={{ color: 'var(--muted)', width: 76, flexShrink: 0 }}>{label}</span>
      <span style={{ fontWeight: 700, fontSize: 14.5, flex: 1, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

/* ================= CLIENT WAITLIST FORM ================= */
function ClientWaitlistForm({ brand, t, lang, wrap, onBack, onDone }) {
  const services = (window.SERVICES || []).filter(s => window.svcMeta(s.id).online && window.svcMeta(s.id).active);
  const [serviceId, setServiceId] = useStateClt(null);
  const [opId, setOpId] = useStateClt('any');
  const [pref, setPref] = useStateClt('morning');
  const [exactTime, setExactTime] = useStateClt('10:00');
  const [exactDays, setExactDays] = useStateClt(['sab']);
  const bv = brandVars(brand);
  const s = serviceId && window.svc(serviceId);
  const elig = s ? OPS.filter(o => (window.svcOpsClient ? window.svcOpsClient[s.id] : s.ops).includes(o.id)) : [];
  const prefs = [['morning', t('Mattina', 'Morning')], ['afternoon', t('Pomeriggio', 'Afternoon')], ['weekend', t('Weekend', 'Weekend')], ['any', t('Qualsiasi', 'Any time')]];
  return wrap(
    <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <ClientSubHead brand={brand} title={t('Aggiungiti alla lista', 'Join the list')} onBack={onBack} />
      <div style={{ padding: '4px 22px', ...bv }}>
        <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 20 }}>{t('Dicci cosa cerchi: ti avvisiamo appena si libera un posto adatto.', 'Tell us what you want: we’ll alert you as soon as a matching slot frees up.')}</div>

        <div className="t-meta" style={{ marginBottom: 11 }}>{t('Servizio', 'Service')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 22 }}>
          {services.map(sv => { const on = serviceId === sv.id; return (
            <button key={sv.id} className="press" onClick={() => { setServiceId(sv.id); setOpId('any'); }} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 'var(--r-md)', textAlign: 'left', border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand-tint)' : 'var(--paper-0)' }}>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 15 }}>{svcName(sv, lang)}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{fmtDur(sv.dur, lang)} · {fmtEur(sv.price, lang)}</div></div>
              {on && <Icon name="check" size={18} color="var(--brand)" stroke={2.4} />}
            </button>
          ); })}
        </div>

        {s && (
          <React.Fragment>
            <div className="t-meta" style={{ marginBottom: 11 }}>{t('Operatrice', 'Stylist')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 22 }}>
              {[['any', t('Qualsiasi', 'Any')], ...elig.map(o => [o.id, o.name])].map(([k, l]) => { const on = opId === k; return (
                <button key={k} className="press" onClick={() => setOpId(k)} style={{ padding: '10px 16px', borderRadius: 99, fontSize: 14, fontWeight: 700, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)' }}>{l}</button>
              ); })}
            </div>

            <div className="t-meta" style={{ marginBottom: 11 }}>{t('Preferenza oraria', 'Time preference')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {[...prefs, ['exact', t('Orario preciso', 'Exact time')]].map(([k, l]) => { const on = pref === k; return (
                <button key={k} className="press" onClick={() => setPref(k)} style={{ padding: '10px 16px', borderRadius: 99, fontSize: 14, fontWeight: 700, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)' }}>{l}</button>
              ); })}
            </div>
            {pref === 'exact' && (
              <div style={{ marginTop: 12 }}>
                <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 8 }}>{t('Scegli i giorni e l’orario. Ti avvisiamo se si libera (o il più vicino).', 'Pick the days and time. We’ll alert you if it frees up (or the closest).')}</div>
                <div className="t-meta" style={{ marginBottom: 8 }}>{t('Giorni', 'Days')}</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                  {[['lun', 'mon', 'L'], ['mar', 'tue', 'M'], ['mer', 'wed', 'M'], ['gio', 'thu', 'G'], ['ven', 'fri', 'V'], ['sab', 'sat', 'S'], ['dom', 'sun', 'D']].map(([k, ek, l]) => { const on = exactDays.includes(k); return (
                    <button key={k} className="press" onClick={() => setExactDays(d => d.includes(k) ? d.filter(x => x !== k) : [...d, k])} style={{ flex: 1, aspectRatio: '1', minWidth: 0, borderRadius: 12, fontSize: 14, fontWeight: 800, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)' }}>{lang === 'en' ? ek[0].toUpperCase() : l}</button>
                  ); })}
                </div>
                <div className="t-meta" style={{ marginBottom: 8 }}>{t('Orario', 'Time')}</div>
                <input type="time" value={exactTime} onChange={e => setExactTime(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '13px 15px', border: '1.5px solid var(--hair)', borderRadius: 'var(--r-md)', outline: 'none', background: 'var(--paper-0)', fontSize: 16, fontWeight: 700, fontFamily: 'var(--sans)', color: 'var(--ink)' }} />
              </div>
            )}
          </React.Fragment>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(var(--safe-bottom) + 14px)', background: 'linear-gradient(transparent, var(--paper-0) 24%)', ...bv }}>
        <button className="btn btn--brand btn--block press" disabled={!serviceId} style={{ opacity: serviceId ? 1 : 0.4 }} onClick={onDone}><Icon name="check" size={18} color="var(--brand-on)" />{t('Conferma richiesta', 'Confirm request')}</button>
      </div>
    </div>
  );
}

Object.assign(window, { ClientApp, BrandEditor, ClientWaitlistForm });