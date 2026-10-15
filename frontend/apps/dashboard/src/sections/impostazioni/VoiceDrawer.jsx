// VoiceDrawer.jsx — assistente vocale: l'agente Yourang prenota al telefono
// (backend: apps/integrations/voice.py). Il titolare genera la chiave e scarica
// il file da importare su Yourang; la chiave in chiaro si vede una volta sola.
import { useEffect, useState } from 'react';
import { API_URL, Icon, fmtDateIt, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DrawerHead from '../../ui/DrawerHead.jsx';
import DkConfirm from '../../ui/DkConfirm.jsx';
import { useDash } from '../../ctx.jsx';
import { CopyField } from './lib.jsx';
import { voiceApi } from '../../api/integrations.js';
import { buildYourangImport } from './voiceTools.js';

function download(key) {
  const blob = new Blob([JSON.stringify(buildYourangImport(API_URL, key), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'yourang-strumenti-prenotazioni.json';
  a.click();
  URL.revokeObjectURL(url);
}

export default function VoiceDrawer({ onClose, onChange }) {
  const { t, fireToast } = useDash();
  const [status, setStatus] = useState(null);   // { active, created_at }
  const [key, setKey] = useState('');           // in chiaro solo dopo «Genera»
  const [confirm, setConfirm] = useState(null); // 'rotate' | 'revoke'
  const [busy, setBusy] = useState(false);

  useEffect(() => { voiceApi.status().then(setStatus).catch(() => setStatus(null)); }, []);

  const run = async (action) => {
    setBusy(true);
    try {
      if (action === 'revoke') {
        await voiceApi.revoke();
        setKey('');
        setStatus({ active: false, created_at: null });
        fireToast({ msg: t('Assistente vocale disattivato', 'Voice assistant switched off'), icon: 'check' });
      } else {
        const data = await voiceApi.generate();
        setKey(data.key);
        setStatus({ active: true, created_at: data.created_at });
      }
      onChange?.();
      setConfirm(null);
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { setBusy(false); }
  };

  const active = !!status?.active;

  return (
    <DkDrawer open onClose={onClose}>
      <DrawerHead onClose={onClose} title={t('Assistente vocale', 'Voice assistant')}
        sub={t('L’agente Yourang prenota gli appuntamenti al telefono', 'The Yourang agent books appointments over the phone')} />

      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 30px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: active ? 'var(--ok)' : 'var(--muted-2)', flexShrink: 0 }} />
          <div style={{ fontWeight: 600, fontSize: 14.5, flex: 1 }}>
            {active
              ? t('Attivo', 'Active') + (status.created_at ? ' · ' + t('chiave del', 'key from') + ' ' + fmtDateIt(status.created_at, { weekday: false }) : '')
              : t('Nessuna chiave: l’agente non può prenotare', 'No key: the agent cannot book')}
          </div>
        </div>

        <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.5, marginBottom: 18 }}>
          {t('Con la chiave, l’agente vocale di Yourang legge i servizi e gli orari liberi e prenota per la cliente durante la chiamata, come dall’app: stessa disponibilità, caparra e conferma su WhatsApp.',
             'With the key, the Yourang voice agent reads services and free times and books for the client during the call, just like the app: same availability, deposit and WhatsApp confirmation.')}
        </div>

        {key && (
          <div style={{ marginBottom: 18 }}>
            <div className="t-meta" style={{ marginBottom: 8 }}>{t('Chiave (copiala ora: non verrà più mostrata)', 'Key (copy it now: it will not be shown again)')}</div>
            <CopyField value={key} t={t} fireToast={fireToast} />
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="dk-btn dk-btn--clay" disabled={busy} onClick={() => (active ? setConfirm('rotate') : run('rotate'))}>
            <Icon name="check" size={16} color="#fff" />{active ? t('Genera una nuova chiave', 'Generate a new key') : t('Genera la chiave', 'Generate the key')}
          </button>
          {(active || key) && (
            <button className="dk-btn dk-btn--soft" onClick={() => download(key)}>
              {key ? t('Scarica il file per Yourang (con la chiave)', 'Download the Yourang file (with the key)') : t('Scarica il file per Yourang (senza chiave)', 'Download the Yourang file (without the key)')}
            </button>
          )}
          {active && (
            <button className="dk-btn dk-btn--ghost" disabled={busy} onClick={() => setConfirm('revoke')}>
              {t('Disattiva', 'Switch off')}
            </button>
          )}
        </div>

        <div className="t-sm" style={{ color: 'var(--muted-2)', lineHeight: 1.5, marginTop: 20 }}>
          {t('Su Yourang: agente → Strumenti → Strumenti esterni → Importa, e scegli il file. Senza la chiave nel file, aggiungila a mano come Bearer token su ogni strumento. Spegni lo strumento di prenotazione interno di Yourang sull’agente: altrimenti la stessa prenotazione arriva due volte.',
             'On Yourang: agent → Tools → External tools → Import, and pick the file. If the file has no key, add it by hand as a Bearer token on each tool. Turn off Yourang’s built-in booking tool on the agent: otherwise the same booking arrives twice.')}
        </div>
      </div>

      <DkConfirm
        open={!!confirm}
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => run(confirm)}
        title={confirm === 'revoke' ? t('Disattivare l’assistente vocale?', 'Switch off the voice assistant?') : t('Generare una nuova chiave?', 'Generate a new key?')}
        message={confirm === 'revoke'
          ? t('L’agente Yourang non potrà più leggere gli orari né prenotare.', 'The Yourang agent will no longer read times or book.')
          : t('La chiave attuale smette subito di funzionare: dovrai mettere la nuova su Yourang.', 'The current key stops working right away: you will have to put the new one on Yourang.')}
        confirmLabel={confirm === 'revoke' ? t('Disattiva', 'Switch off') : t('Genera', 'Generate')}
        cancelLabel={t('Annulla', 'Cancel')} />
    </DkDrawer>
  );
}
