// AutomationKeyDrawer.jsx — chiave per n8n / Make / Zapier (backend:
// apps/integrations/automation_key.py). Lo strumento esterno legge gli
// appuntamenti in arrivo e manda da sé i messaggi per trattamento. La chiave
// si vede una volta sola, appena generata: il server ne tiene solo l'impronta.
import { useEffect, useState } from 'react';
import { API_URL, Icon, fmtDateIt, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DrawerHead from '../../ui/DrawerHead.jsx';
import DkConfirm from '../../ui/DkConfirm.jsx';
import { useDash } from '../../ctx.jsx';
import { automationKeyApi } from '../../api/integrations.js';
import { CopyField } from './lib.jsx';

const ENDPOINT = API_URL + '/api/integrations/automation/appointments';

export default function AutomationKeyDrawer({ onClose, onChange }) {
  const { t, fireToast } = useDash();
  const [status, setStatus] = useState(null);   // { active, created_at, key? }
  const [confirm, setConfirm] = useState(null); // 'rotate' | 'revoke'
  const [busy, setBusy] = useState(false);

  useEffect(() => { automationKeyApi.status().then(setStatus).catch(() => setStatus(null)); }, []);

  const run = async (action) => {
    setBusy(true);
    try {
      setStatus(await (action === 'revoke' ? automationKeyApi.revoke() : automationKeyApi.rotate()));
      fireToast({ msg: action === 'revoke' ? t('Chiave revocata', 'Key revoked') : t('Chiave generata', 'Key generated'), icon: 'check' });
      onChange?.();
      setConfirm(null);
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { setBusy(false); }
  };

  const active = !!status?.active;

  return (
    <DkDrawer open onClose={onClose}>
      <DrawerHead onClose={onClose} title={t('Automazioni esterne', 'External automations')}
        sub={t('Chiave per n8n, Make o Zapier', 'Key for n8n, Make or Zapier')} />

      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 30px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: active ? 'var(--ok)' : 'var(--muted-2)', flexShrink: 0 }} />
          <div style={{ fontWeight: 600, fontSize: 14.5, flex: 1 }}>
            {active
              ? t('Attiva', 'Active') + (status.created_at ? ' · ' + t('dal', 'since') + ' ' + fmtDateIt(status.created_at, { weekday: false }) : '')
              : t('Non attiva', 'Off')}
          </div>
        </div>

        <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.5, marginBottom: 18 }}>
          {t('Lo strumento esterno legge gli appuntamenti confermati in arrivo (cliente, telefono, trattamenti) e manda da sé i messaggi: per esempio ogni ora chiede quelli fra 24 e 25 ore e sceglie il testo in base al trattamento. La chiave legge soltanto, non modifica niente.',
             'The external tool reads upcoming confirmed appointments (client, phone, treatments) and sends the messages itself: for example, every hour it asks for those between 24 and 25 hours ahead and picks the text by treatment. The key is read-only.')}
        </div>

        <div className="t-sm" style={{ fontWeight: 600, marginBottom: 6 }}>{t('Indirizzo (GET, parametri start ed end in ISO)', 'URL (GET, start and end parameters in ISO)')}</div>
        <div style={{ marginBottom: 16 }}><CopyField value={ENDPOINT} t={t} fireToast={fireToast} /></div>

        {status?.key && (
          <>
            <div className="t-sm" style={{ fontWeight: 600, marginBottom: 6 }}>{t('Chiave (header Authorization: Bearer …)', 'Key (Authorization: Bearer … header)')}</div>
            <div style={{ marginBottom: 6 }}><CopyField value={status.key} t={t} fireToast={fireToast} /></div>
            <div className="t-sm" style={{ color: 'var(--warn)', lineHeight: 1.5, marginBottom: 16 }}>
              {t('Copiala adesso: non la vedrai più.', 'Copy it now: you won’t see it again.')}
            </div>
          </>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {active ? (
            <>
              <button className="dk-btn dk-btn--soft" disabled={busy} onClick={() => setConfirm('rotate')}>
                {t('Genera una chiave nuova', 'Generate a new key')}
              </button>
              <button className="dk-btn dk-btn--ghost" disabled={busy} onClick={() => setConfirm('revoke')}>
                {t('Revoca', 'Revoke')}
              </button>
            </>
          ) : (
            <button className="dk-btn dk-btn--clay" disabled={busy || !status} onClick={() => run('rotate')}>
              <Icon name="check" size={16} color="#fff" />{t('Genera chiave', 'Generate key')}
            </button>
          )}
        </div>
      </div>

      <DkConfirm
        open={!!confirm}
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => run(confirm)}
        title={confirm === 'revoke' ? t('Revocare la chiave?', 'Revoke the key?') : t('Generare una chiave nuova?', 'Generate a new key?')}
        message={t('La chiave attuale smette subito di funzionare: i flussi che la usano non leggeranno più l’agenda.', 'The current key stops working at once: workflows using it will no longer read the calendar.')}
        confirmLabel={confirm === 'revoke' ? t('Revoca', 'Revoke') : t('Genera', 'Generate')}
        cancelLabel={t('Annulla', 'Cancel')} />
    </DkDrawer>
  );
}
