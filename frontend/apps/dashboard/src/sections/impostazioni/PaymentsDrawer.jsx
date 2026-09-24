// PaymentsDrawer.jsx — Pagamenti & caparre (titolare): collegamento dell'account
// Stripe del salone (Stripe Connect, popup /stripe-connect/*) e caparra con
// scadenza: dopo quanti minuti dalla prenotazione lo slot viene liberato se la
// caparra non è arrivata, e quando parte il sollecito. Le regole di CHI paga
// la caparra restano in Prenotazioni & ottimizzazione → Regole deposito.
import { useEffect, useState } from 'react';
import { api, Icon, NumInput, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DkConfirm from '../../ui/DkConfirm.jsx';
import { useDash } from '../../ctx.jsx';
import { LockNote } from './lib.jsx';

const HOLD_PRESETS = [0, 15, 20, 30, 60, 120];

export default function PaymentsDrawer({ onClose }) {
  const { t, session, settings, reload, fireToast } = useDash();
  const isOwner = !!session?.is_owner;
  const [stripe, setStripe] = useState(null);      // StripeConnectStatusOut
  const [hold, setHold] = useState(settings?.deposit_hold_minutes || 0);
  const [reminder, setReminder] = useState(settings?.deposit_reminder_minutes || 0);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  // «Scollega» staccava l'account al primo clic (15-08): da lì le caparre
  // pagate dal link finivano sull'account della piattaforma. Ora si chiede.
  const [confirmOff, setConfirmOff] = useState(false);

  const loadStripe = () => api.get('/api/sales/stripe/connect/status').then(setStripe).catch(() => setStripe(null));
  useEffect(() => { loadStripe(); }, []);

  // il popup /stripe-connect/done avvisa con postMessage quando ha scambiato il code
  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || e.data?.type !== 'stripe-connect') return;
      if (e.data.ok) { fireToast({ msg: t('Account Stripe collegato', 'Stripe account connected'), icon: 'check' }); loadStripe(); reload.salon().catch(() => {}); }
      else fireToast({ msg: t('Collegamento Stripe non riuscito', 'Stripe connection failed') + (e.data.error ? ': ' + e.data.error : ''), icon: 'alert' });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = () => {
    const popup = window.open('/stripe-connect/start', 'stripe-connect', 'width=620,height=760');
    if (!popup) fireToast({ msg: t('Popup bloccato: consenti i popup e riprova', 'Popup blocked: allow popups and retry'), icon: 'info' });
  };
  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.del('/api/sales/stripe/connect');
      setStripe(res);
      setConfirmOff(false);
      reload.salon().catch(() => {});
      fireToast({ msg: t('Account Stripe scollegato', 'Stripe account disconnected'), icon: 'check' });
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (saving) return;
    if (hold > 0 && reminder >= hold) { fireToast({ msg: t('Il sollecito deve precedere la scadenza', 'The reminder must come before the deadline'), icon: 'alert' }); return; }
    setSaving(true);
    try {
      await api.put('/api/core/settings', { deposit_hold_minutes: hold, deposit_reminder_minutes: hold > 0 ? reminder : 0 });
      await reload.salon();
      fireToast({ msg: t('Impostazioni salvate', 'Settings saved'), icon: 'check' });
      onClose();
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally { setSaving(false); }
  };

  const fmtMin = (m) => (m === 0 ? t('Mai', 'Never') : m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`);
  const stripeOk = !!stripe?.connected;

  return (
    <DkDrawer open onClose={onClose}>
      <div className="dk-modalhead">
        <div style={{ flex: 1 }}>
          <div className="t-title" style={{ fontSize: 20 }}>{t('Pagamenti & caparre', 'Payments & deposits')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Account Stripe del salone e scadenza della caparra', 'The salon Stripe account and the deposit deadline')}</div>
        </div>
        <button className="dk-iconbtn" onClick={onClose} aria-label={t('Chiudi', 'Close')} style={{ width: 36, height: 36 }}><Icon name="x" size={17} /></button>
      </div>
      <div className="dk-modalbody" style={{ padding: '0 22px 22px' }}>
        {!isOwner && <div style={{ marginBottom: 14 }}><LockNote t={t} msg={t('Solo il titolare può collegare Stripe e cambiare la scadenza della caparra.', 'Only the owner can connect Stripe and change the deposit deadline.')} /></div>}

        {/* ── Stripe ── */}
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('Pagamenti online', 'Online payments')}</div>
        <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)', marginBottom: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, background: stripeOk ? 'var(--ok-tint)' : 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <Icon name="wallet" size={20} color={stripeOk ? 'var(--ok)' : 'var(--muted)'} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Stripe</div>
              <div className="t-sm" style={{ color: stripeOk ? 'var(--ok)' : 'var(--muted)', fontWeight: 600 }}>
                {stripe === null ? '…' : stripeOk
                  ? t('Collegato', 'Connected') + (stripe.account_id ? ` · ${stripe.account_id}` : '')
                  : stripe?.available ? t('Non collegato', 'Not connected') : t('Non disponibile su questa installazione', 'Not available on this installation')}
              </div>
            </div>
            {isOwner && stripe?.available && (stripeOk
              ? <button className="dk-btn dk-btn--ghost" disabled={busy} onClick={() => setConfirmOff(true)}>{t('Scollega', 'Disconnect')}</button>
              : <button className="dk-btn dk-btn--clay" onClick={connect}><Icon name="plus" size={16} color="#fff" />{t('Collega Stripe', 'Connect Stripe')}</button>)}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 12, lineHeight: 1.5 }}>
            {t('Con l’account collegato le caparre pagate dal link finiscono direttamente sul conto Stripe del salone, e gli addebiti no-show sulla carta salvata passano da lì. Senza collegamento le clienti pagano la caparra in salone.', 'With a connected account, deposits paid through the link go straight to the salon’s Stripe balance, and no-show charges on saved cards go through it too. Without it, clients pay the deposit in the salon.')}
            {stripe && !stripe.available && (
              <span> {t('Chiedi al fornitore della piattaforma di abilitare Stripe Connect (chiave e client id).', 'Ask the platform provider to enable Stripe Connect (key and client id).')}</span>
            )}
            {stripe && stripe.payments_enabled && !stripeOk && (
              <span> {t('Nota: la piattaforma ha una chiave Stripe generale, quindi i link caparra funzionano già, ma gli incassi arrivano sull’account della piattaforma finché non colleghi il tuo.', 'Note: the platform has a general Stripe key, so deposit links already work, but payouts land on the platform account until you connect yours.')}</span>
            )}
          </div>
        </div>

        {/* ── caparra con scadenza ── */}
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('Caparra con scadenza', 'Deposit deadline')}</div>
        <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
          <div style={{ fontWeight: 600, fontSize: 14.5 }}>{t('Libera lo slot se la caparra non arriva entro', 'Free the slot if the deposit is not paid within')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>
            {t('Vale per gli appuntamenti con caparra richiesta (regole deposito). Alla prenotazione parte il link di pagamento; allo scadere lo slot torna libero e la cliente resta fra i «da richiamare» in agenda, dove puoi ripristinare o riprenotare. 20 minuti bastano per pagare con calma senza tenere occupato lo slot.', 'Applies to appointments with a required deposit (deposit rules). The payment link goes out at booking; when the time runs out the slot is freed and the client stays in the agenda’s “to call back” list, where you can restore or rebook. 20 minutes are enough to pay calmly without holding the slot.')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 12 }}>
            {HOLD_PRESETS.map((m) => {
              const on = hold === m;
              return <button key={m} disabled={!isOwner} onClick={() => setHold(m)} style={{ padding: '8px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: isOwner ? 'pointer' : 'default', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{fmtMin(m)}</button>;
            })}
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 99, padding: '0 12px', height: 36, background: 'var(--surface)' }}>
              <NumInput integer min={0} max={10080} value={hold} disabled={!isOwner} onChange={setHold} style={{ width: 52, border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, fontWeight: 700, textAlign: 'right' }} />
              <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>min</span>
            </div>
          </div>
          {hold > 0 && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--hair)' }}>
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>{t('Sollecito dopo', 'Reminder after')}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Un secondo messaggio con il link prima della scadenza (0 = nessun sollecito).', 'A second message with the link before the deadline (0 = no reminder).')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 10, alignItems: 'center' }}>
                {[0, 5, 10, 15, 30].filter((m) => m < hold).map((m) => {
                  const on = reminder === m;
                  return <button key={m} disabled={!isOwner} onClick={() => setReminder(m)} style={{ padding: '7px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: isOwner ? 'pointer' : 'default', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{m === 0 ? t('Nessuno', 'None') : `${m} min`}</button>;
                })}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 99, padding: '0 12px', height: 34, background: 'var(--surface)' }}>
                  <NumInput integer min={0} max={Math.max(0, hold - 1)} value={reminder} disabled={!isOwner} onChange={setReminder} style={{ width: 44, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, fontWeight: 700, textAlign: 'right' }} />
                  <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>min</span>
                </div>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, padding: '11px 13px', background: 'var(--clay-tint)', borderRadius: 11, marginTop: 14 }}>
            <Icon name="sparkle" size={15} color="var(--clay-ink)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.5 }}>
              {hold === 0
                ? t('Nessuna scadenza: gli appuntamenti con caparra richiesta restano in agenda finché non li gestisci a mano.', 'No deadline: appointments with a required deposit stay in the agenda until you handle them by hand.')
                : t(`Alla prenotazione la cliente riceve il link; ${reminder ? `dopo ${fmtMin(reminder)} un sollecito; ` : ''}dopo ${fmtMin(hold)} senza pagamento lo slot torna libero e la cliente compare fra i «da richiamare». Il controllo gira anche se nessuno ha l’agenda aperta (cron process_deposit_holds).`, `At booking the client gets the link; ${reminder ? `after ${fmtMin(reminder)} a reminder; ` : ''}after ${fmtMin(hold)} without payment the slot is freed and the client shows up in “to call back”. The check also runs when nobody has the agenda open (cron process_deposit_holds).`)}
            </div>
          </div>
        </div>

        {isOwner && (
          <button className="dk-btn dk-btn--clay" disabled={saving} style={{ width: '100%', marginTop: 18, opacity: saving ? 0.6 : 1 }} onClick={save}>
            <Icon name="check" size={17} color="#fff" />{saving ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
          </button>
        )}
      </div>
      <DkConfirm
        open={confirmOff}
        busy={busy}
        onClose={() => setConfirmOff(false)}
        onConfirm={disconnect}
        title={t('Scollegare Stripe?', 'Disconnect Stripe?')}
        message={t('L’account Stripe del salone verrà scollegato.', 'The salon’s Stripe account will be disconnected.')}
        detail={stripe?.payments_enabled
          ? t('Da quel momento le caparre pagate dal link finiscono sull’account della piattaforma, non sul conto del salone, e lo stesso gli addebiti no-show sulla carta salvata. Per tornare indietro dovrai rifare il collegamento con Stripe.',
            'From then on, deposits paid through the link land on the platform account, not the salon’s, and so do no-show charges on saved cards. To undo it you will have to connect Stripe again.')
          : t('Da quel momento i link di pagamento della caparra non funzionano più: le clienti pagano la caparra in salone. Per tornare indietro dovrai rifare il collegamento con Stripe.',
            'From then on, deposit payment links stop working: clients pay the deposit in the salon. To undo it you will have to connect Stripe again.')}
        confirmLabel={t('Scollega', 'Disconnect')}
        cancelLabel={t('Annulla', 'Cancel')}
      />
    </DkDrawer>
  );
}
