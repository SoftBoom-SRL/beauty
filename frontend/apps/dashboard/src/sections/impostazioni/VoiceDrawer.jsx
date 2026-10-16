// VoiceDrawer.jsx — assistente vocale: l'agente Yourang prenota al telefono
// (backend: apps/integrations/voice.py). Un interruttore: il backend installa
// gli strumenti sull'org Yourang da sé (anche appena il salone si collega).
// Prima il titolare generava una chiave, scaricava un file JSON e lo importava
// su Yourang a mano: troppi passi per chi gestisce un salone.
import { useEffect, useState } from 'react';
import { Icon, fmtDateIt, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DrawerHead from '../../ui/DrawerHead.jsx';
import DkConfirm from '../../ui/DkConfirm.jsx';
import { useDash } from '../../ctx.jsx';
import { voiceApi } from '../../api/integrations.js';

export default function VoiceDrawer({ onClose, onChange, onReconnect }) {
  const { t, fireToast } = useDash();
  const [status, setStatus] = useState(null);   // { active, created_at, connected, needs_reconnect }
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { voiceApi.status().then(setStatus).catch(() => setStatus(null)); }, []);

  const run = async (action) => {
    setBusy(true);
    try {
      setStatus(await (action === 'off' ? voiceApi.uninstall() : voiceApi.install()));
      fireToast({ msg: action === 'off' ? t('Assistente vocale disattivato', 'Voice assistant switched off') : t('Assistente vocale attivo', 'Voice assistant active'), icon: 'check' });
      onChange?.();
      setConfirmOff(false);
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { setBusy(false); }
  };

  const active = !!status?.active;
  const reconnect = status && (!status.connected || status.needs_reconnect);

  return (
    <DkDrawer open onClose={onClose}>
      <DrawerHead onClose={onClose} title={t('Assistente vocale', 'Voice assistant')}
        sub={t('L’agente Yourang prenota gli appuntamenti al telefono', 'The Yourang agent books appointments over the phone')} />

      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 30px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: active ? 'var(--ok)' : 'var(--muted-2)', flexShrink: 0 }} />
          <div style={{ fontWeight: 600, fontSize: 14.5, flex: 1 }}>
            {active
              ? t('Attivo', 'Active') + (status.created_at ? ' · ' + t('dal', 'since') + ' ' + fmtDateIt(status.created_at, { weekday: false }) : '')
              : t('Non attivo', 'Off')}
          </div>
        </div>

        <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.5, marginBottom: 18 }}>
          {t('L’agente vocale di Yourang legge i servizi e gli orari liberi e prenota per la cliente durante la chiamata, come dall’app: stessa disponibilità, caparra e conferma su WhatsApp. Non devi configurare niente su Yourang.',
             'The Yourang voice agent reads services and free times and books for the client during the call, just like the app: same availability, deposit and WhatsApp confirmation. Nothing to set up on Yourang.')}
        </div>

        {reconnect ? (
          <>
            <div className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 12 }}>
              {status.connected
                ? t('Il collegamento con Yourang è di prima che esistesse l’assistente: ricollegalo e si attiva da solo.', 'The Yourang connection predates the assistant: reconnect it and it switches on by itself.')
                : t('Collega Yourang: l’assistente si attiva da solo.', 'Connect Yourang: the assistant switches on by itself.')}
            </div>
            <button className="dk-btn dk-btn--clay" onClick={() => { onReconnect?.(); onClose(); }}>
              <Icon name="globe" size={16} color="#fff" />{status.connected ? t('Ricollega Yourang', 'Reconnect Yourang') : t('Collega Yourang', 'Connect Yourang')}
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {active ? (
              <>
                <button className="dk-btn dk-btn--soft" disabled={busy} onClick={() => run('on')}>
                  {t('Reinstalla su Yourang', 'Reinstall on Yourang')}
                </button>
                <button className="dk-btn dk-btn--ghost" disabled={busy} onClick={() => setConfirmOff(true)}>
                  {t('Disattiva', 'Switch off')}
                </button>
              </>
            ) : (
              <button className="dk-btn dk-btn--clay" disabled={busy || !status} onClick={() => run('on')}>
                <Icon name="check" size={16} color="#fff" />{t('Attiva', 'Switch on')}
              </button>
            )}
          </div>
        )}
      </div>

      <DkConfirm
        open={confirmOff}
        busy={busy}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => run('off')}
        title={t('Disattivare l’assistente vocale?', 'Switch off the voice assistant?')}
        message={t('L’agente Yourang non potrà più leggere gli orari né prenotare.', 'The Yourang agent will no longer read times or book.')}
        confirmLabel={t('Disattiva', 'Switch off')}
        cancelLabel={t('Annulla', 'Cancel')} />
    </DkDrawer>
  );
}
