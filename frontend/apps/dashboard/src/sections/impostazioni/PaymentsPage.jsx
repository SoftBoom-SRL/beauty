// PaymentsPage.jsx — collegamento dell'account Stripe del salone + policy di
// caparra e mancata presentazione.
//
// Modello Stripe: **Connect Standard + direct charges**. Il salone collega il SUO
// account: incassa lui, è lui il merchant of record (il suo nome sull'estratto
// conto della cliente) e gestisce lui le dispute. Youty non trattiene commissioni.
//
// Due automatismi DISTINTI, entrambi per salone:
//   PRIMA dell'appuntamento → scadenza della caparra
//   DOPO l'inizio           → mancata presentazione
//
// Rotte: GET/POST /api/integrations/stripe/{status,refresh,oauth/start},
// DELETE /api/integrations/stripe/connection, PUT /api/core/settings.
import React, { useCallback, useEffect, useState } from 'react';
import { api, Icon, Toggle, NumInput } from '@youty/shared';
import DkSeg from '../../ui/DkSeg.jsx';
import DkModal from '../../ui/DkModal.jsx';
import { useDash } from '../../ctx.jsx';
import { toastErr, LockNote, inputCss } from './lib.jsx';

const Card = ({ title, sub, children }) => (
  <div className="dk-card" style={{ padding: 20, marginBottom: 18 }}>
    <div style={{ fontWeight: 700, fontSize: 15.5 }}>{title}</div>
    {sub && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4, marginBottom: 16 }}>{sub}</div>}
    {children}
  </div>
);

/* NumInput non ha una prop `suffix` e spreda il resto sull'input: qui gli si dà
   una larghezza fissa e, quando serve, l'unità accanto. */
const Num = ({ value, onChange, min, max, unit }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
    <NumInput value={value} onChange={onChange} min={min} max={max} integer
      style={{ ...inputCss, width: 92, textAlign: 'right' }} />
    {unit && <span className="t-sm" style={{ color: 'var(--muted-2)', minWidth: 46 }}>{unit}</span>}
  </div>
);

const FieldRow = ({ label, hint, children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0', borderTop: '1px solid var(--hair)' }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
      {hint && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{hint}</div>}
    </div>
    <div style={{ flexShrink: 0 }}>{children}</div>
  </div>
);

export default function PaymentsPage({ onBack }) {
  const { t, session, settings, reload, fireToast } = useDash();
  const isOwner = !!session?.is_owner;

  const [stripe, setStripe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const loadStripe = useCallback(
    () => api.get('/api/integrations/stripe/status').then(setStripe).catch(() => setStripe(null)),
    [],
  );
  useEffect(() => { loadStripe(); }, [loadStripe]);

  // Handshake dal popup Stripe.
  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || e.data?.type !== 'stripe-oauth') return;
      if (e.data.ok) {
        fireToast({ msg: t('Account Stripe collegato', 'Stripe account connected'), icon: 'check' });
        loadStripe();
      } else {
        fireToast({ msg: t('Collegamento a Stripe non riuscito', 'Stripe connection failed'), icon: 'alert' });
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- policy locale (salvata su PUT /api/core/settings) ---- */
  const [f, setF] = useState(() => ({
    deposit_enabled: settings?.deposit_enabled ?? false,
    deposit_deadline_hours: settings?.deposit_deadline_hours ?? 0,
    deposit_deadline_action: settings?.deposit_deadline_action ?? 'none',
    noshow_charge_mode: settings?.noshow_charge_mode ?? 'manual',
    noshow_charge_delay_min: settings?.noshow_charge_delay_min ?? 30,
    noshow_charge_pct: settings?.noshow_charge_pct ?? 100,
    late_cancel_charge_pct: settings?.late_cancel_charge_pct ?? 0,
  }));
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const savePolicy = async () => {
    setBusy(true);
    try {
      await api.put('/api/core/settings', f);
      await reload.salon();
      fireToast({ msg: t('Policy pagamenti salvata', 'Payment policy saved'), icon: 'check' });
    } catch (err) {
      toastErr(err, fireToast, t);
    } finally {
      setBusy(false);
    }
  };

  const connect = () => {
    const popup = window.open('/oauth-popup/stripe-start', 'stripe-oauth', 'width=520,height=720');
    if (!popup) fireToast({ msg: t('Popup bloccato: consenti i popup e riprova', 'Popup blocked: allow popups and retry'), icon: 'info' });
  };

  const recheck = async () => {
    setBusy(true);
    try {
      setStripe(await api.post('/api/integrations/stripe/refresh'));
      fireToast({ msg: t('Stato aggiornato', 'Status refreshed'), icon: 'check' });
    } catch (err) { toastErr(err, fireToast, t); } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setConfirmOff(false);
    setBusy(true);
    try {
      await api.del('/api/integrations/stripe/connection');
      await loadStripe();
      fireToast({ msg: t('Account Stripe scollegato', 'Stripe account disconnected'), icon: 'check' });
    } catch (err) { toastErr(err, fireToast, t); } finally { setBusy(false); }
  };

  if (!isOwner) {
    return (
      <div className="dk-page" style={{ maxWidth: 760 }}>
        <button className="dk-btn dk-btn--ghost" onClick={onBack} style={{ marginBottom: 16 }}>
          <Icon name="chevL" size={16} />{t('Impostazioni', 'Settings')}
        </button>
        <LockNote t={t} msg={t('Solo il titolare può gestire i pagamenti del salone.', 'Only the owner can manage salon payments.')} />
      </div>
    );
  }

  const connected = !!stripe?.connected;
  const canCharge = !!stripe?.can_charge;
  const configured = !!stripe?.configured;
  const automatic = f.noshow_charge_mode === 'automatic';

  return (
    <div className="dk-page" style={{ maxWidth: 760 }}>
      <button className="dk-btn dk-btn--ghost" onClick={onBack} style={{ marginBottom: 16 }}>
        <Icon name="chevL" size={16} />{t('Impostazioni', 'Settings')}
      </button>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 22 }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--ok-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="wallet" size={22} color="var(--ok)" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, lineHeight: 1.1 }}>
            {t('Pagamenti', 'Payments')}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>
            {t('Collega il tuo account Stripe per incassare caparre e mancate presentazioni.',
               'Connect your Stripe account to collect deposits and no-show charges.')}
          </div>
        </div>
      </div>

      {/* ---- Account Stripe ---- */}
      <Card
        title={t('Account Stripe', 'Stripe account')}
        sub={t('Gli incassi arrivano direttamente sul tuo conto Stripe: è il tuo nome a comparire sull’estratto conto della cliente. Youty non trattiene alcuna commissione.',
               'Payouts land straight in your own Stripe account: your name appears on the client’s statement. Youty takes no commission.')}
      >
        {!configured ? (
          <div className="t-sm" style={{ color: 'var(--warn)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Icon name="alert" size={16} color="var(--warn)" />
            {t('Stripe Connect non è ancora configurato lato piattaforma: contatta l’assistenza.',
               'Stripe Connect is not configured on the platform side yet: contact support.')}
          </div>
        ) : !connected ? (
          <React.Fragment>
            <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 16, lineHeight: 1.55 }}>
              {t('Ti serve un account Stripe: è gratuito e non ha abbonamenti, si paga solo una commissione su ogni incasso. Se non ne hai uno, lo crei durante il collegamento.',
                 'You need a Stripe account: it’s free with no subscription — you only pay a fee per transaction. If you don’t have one, you can create it during the connection.')}
            </div>
            <button className="dk-btn dk-btn--primary" onClick={connect} disabled={busy}>
              <Icon name="ext" size={16} color="#fff" />{t('Collega Stripe', 'Connect Stripe')}
            </button>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700,
                padding: '3px 10px', borderRadius: 99,
                color: canCharge ? 'var(--ok)' : 'var(--warn)',
                background: canCharge ? 'var(--ok-tint)' : 'var(--warn-tint)',
              }}>
                <Icon name={canCharge ? 'check' : 'alert'} size={12} color={canCharge ? 'var(--ok)' : 'var(--warn)'} />
                {canCharge ? t('Incassi attivi', 'Charges enabled') : t('Verifica da completare', 'Verification pending')}
              </span>
              {!stripe?.livemode && (
                <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('modalità test', 'test mode')}</span>
              )}
            </div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', fontFamily: 'monospace' }}>{stripe?.stripe_account_id}</div>

            {!canCharge && (
              <div className="t-sm" style={{ color: 'var(--warn)', marginTop: 12, lineHeight: 1.5 }}>
                {t('L’account è collegato ma Stripe non ha ancora abilitato gli incassi: completa la verifica dell’identità e l’IBAN sul tuo cruscotto Stripe, poi premi “Ricontrolla”.',
                   'The account is connected but Stripe has not enabled charges yet: complete identity verification and bank details on your Stripe dashboard, then press “Re-check”.')}
              </div>
            )}
            {stripe?.last_error && (
              <div className="t-sm" style={{ color: 'var(--danger)', marginTop: 10 }}>{stripe.last_error}</div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
              <button className="dk-btn dk-btn--soft" onClick={recheck} disabled={busy}>
                <Icon name="refresh" size={15} />{t('Ricontrolla', 'Re-check')}
              </button>
              <button className="dk-btn dk-btn--ghost" onClick={() => setConfirmOff(true)} disabled={busy}
                style={{ color: 'var(--danger)' }}>
                {t('Scollega', 'Disconnect')}
              </button>
            </div>
          </React.Fragment>
        )}
      </Card>

      {/* ---- Caparra ---- */}
      <Card
        title={t('Caparra', 'Deposit')}
        sub={t('Quanto chiedere lo decidono le regole in “Prenotazioni e ottimizzazione”. Qui decidi se la caparra è attiva e cosa fare se non viene versata in tempo.',
               'How much to ask is set by the rules in “Bookings & optimisation”. Here you decide whether deposits are on, and what happens if one isn’t paid in time.')}
      >
        <FieldRow label={t('Richiedi la caparra', 'Require a deposit')}
          hint={t('La cliente la salda dall’app con un pagamento sicuro ospitato da Stripe.',
                  'The client pays it from the app through Stripe’s hosted checkout.')}>
          <Toggle on={f.deposit_enabled} onChange={(v) => set('deposit_enabled', v)} />
        </FieldRow>

        {f.deposit_enabled && (
          <React.Fragment>
            <FieldRow label={t('Scadenza', 'Deadline')}
              hint={t('Ore prima dell’appuntamento entro cui la caparra va versata. 0 = nessuna scadenza.',
                      'Hours before the appointment by which the deposit must be paid. 0 = no deadline.')}>
              <Num value={f.deposit_deadline_hours} min={0} max={720} unit={t('ore', 'hours')}
                onChange={(v) => set('deposit_deadline_hours', v)} />
            </FieldRow>

            {f.deposit_deadline_hours > 0 && (
              <FieldRow label={t('Alla scadenza', 'At the deadline')}
                hint={t('“Addebita” funziona solo se la cliente ha già una carta salvata.',
                        '“Charge” only works if the client already has a saved card.')}>
                <select className="dk-input" style={{ ...inputCss, width: 210, cursor: 'pointer' }}
                  value={f.deposit_deadline_action}
                  onChange={(e) => set('deposit_deadline_action', e.target.value)}>
                  <option value="none">{t('Solo avviso', 'Notify only')}</option>
                  <option value="charge">{t('Addebita la caparra', 'Charge the deposit')}</option>
                  <option value="cancel">{t('Annulla e libera lo slot', 'Cancel and free the slot')}</option>
                </select>
              </FieldRow>
            )}
          </React.Fragment>
        )}
      </Card>

      {/* ---- Mancata presentazione ---- */}
      <Card
        title={t('Mancata presentazione', 'No-show')}
        sub={t('Cosa accade quando una cliente non si presenta, o annulla troppo tardi.',
               'What happens when a client doesn’t show up, or cancels too late.')}
      >
        <FieldRow label={t('Addebito', 'Charge')}
          hint={automatic
            ? t('Scatta da sé, senza intervento dello staff.', 'Fires by itself, with no staff action.')
            : t('Decide lo staff, appuntamento per appuntamento.', 'Staff decides, case by case.')}>
          <DkSeg value={f.noshow_charge_mode} onChange={(v) => set('noshow_charge_mode', v)}
            options={[
              { value: 'manual', label: t('Manuale', 'Manual') },
              { value: 'automatic', label: t('Automatico', 'Automatic') },
            ]} />
        </FieldRow>

        {automatic && (
          <FieldRow label={t('Dopo quanto', 'After how long')}
            hint={t('Minuti dall’orario di inizio: se non c’è stato il check-in, l’appuntamento diventa una mancata presentazione.',
                    'Minutes after the start time: with no check-in, the appointment becomes a no-show.')}>
            <Num value={f.noshow_charge_delay_min} min={0} max={1440} unit={t('minuti', 'minutes')}
              onChange={(v) => set('noshow_charge_delay_min', v)} />
          </FieldRow>
        )}

        <FieldRow label={t('Quanto trattenere', 'How much to keep')}
          hint={t('Percentuale del totale dell’appuntamento.', 'Percentage of the appointment total.')}>
          <Num value={f.noshow_charge_pct} min={0} max={100} unit="%"
            onChange={(v) => set('noshow_charge_pct', v)} />
        </FieldRow>

        <FieldRow label={t('Annullamento tardivo', 'Late cancellation')}
          hint={t('Percentuale trattenuta a chi annulla oltre il limite. 0 = si trattiene solo la caparra già versata.',
                  'Percentage kept when a client cancels past the limit. 0 = only the deposit already paid is kept.')}>
          <Num value={f.late_cancel_charge_pct} min={0} max={100} unit="%"
            onChange={(v) => set('late_cancel_charge_pct', v)} />
        </FieldRow>

        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 16, lineHeight: 1.5, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <Icon name="info" size={15} color="var(--muted-2)" />
          {t('Un addebito su carta salvata può richiedere alla cliente di autenticarsi presso la sua banca: in quel caso resta in attesa finché non lo fa. Lo trovi nel registro attività.',
             'A charge on a saved card may require the client to authenticate with her bank: it then stays pending until she does. You’ll find it in the activity log.')}
        </div>
      </Card>

      <button className="dk-btn dk-btn--primary" onClick={savePolicy} disabled={busy}>
        {busy ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
      </button>

      <DkModal open={confirmOff} onClose={() => setConfirmOff(false)}
        title={t('Scollegare Stripe?', 'Disconnect Stripe?')} width={460}
        foot={
          <React.Fragment>
            <button className="dk-btn dk-btn--soft" onClick={() => setConfirmOff(false)}>{t('Annulla', 'Cancel')}</button>
            <button className="dk-btn dk-btn--primary" onClick={disconnect} style={{ background: 'var(--danger)' }}>
              {t('Scollega', 'Disconnect')}
            </button>
          </React.Fragment>
        }>
        <div className="t-body" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>
          {t('Da quel momento non potrai più incassare caparre né addebitare le mancate presentazioni. Gli incassi già ricevuti restano sul tuo conto Stripe.',
             'From then on you won’t be able to collect deposits or charge no-shows. Payments already received stay in your Stripe account.')}
        </div>
      </DkModal>
    </div>
  );
}
