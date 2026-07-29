// YourangGate.jsx — il popup che precede SEMPRE il rinvio alla piattaforma Yourang.
//
// Due motivi di blocco, due destinazioni:
//   not_connected → il salone non ha ancora accesso alla piattaforma: si va alla
//                   pagina di richiesta informazioni, dove gli specialisti fanno
//                   attivazione e setting.
//   no_credit     → il salone è collegato ma ha finito il credito: si va sulla
//                   piattaforma per ricaricare (stesso ingresso del bottone
//                   "Apri su Yourang" già presente in dashboard).
//
// Gli URL arrivano dal backend (/api/integrations/yourang/status) così cambiarli
// non richiede una release del frontend.
import React from 'react';
import { Icon } from '@youty/shared';
import DkModal from './DkModal.jsx';

export default function YourangGate({ reason, yourang, t, onClose }) {
  if (!reason) return null;

  const noCredit = reason === 'no_credit';
  const url = noCredit
    ? (yourang?.topup_url || yourang?.activation_url)
    : yourang?.activation_url;

  const title = noCredit
    ? t('Credito Yourang esaurito', 'Yourang credit used up')
    : t('Strumento non ancora attivo', 'Tool not active yet');

  const sub = noCredit
    ? t('Questo strumento usa la piattaforma Yourang.', 'This tool runs on the Yourang platform.')
    : t('Questo strumento richiede la piattaforma Yourang.', 'This tool requires the Yourang platform.');

  const body = noCredit
    ? t(
      'Il salone è collegato a Yourang, ma il credito è finito: gli invii restano in attesa finché non ricarichi. Prosegui su Yourang per acquistare nuovo credito — al primo invio riuscito lo strumento si riattiva da solo.',
      'Your salon is connected to Yourang, but the credit has run out: messages stay queued until you top up. Continue on Yourang to buy new credit — the tool re-enables itself on the first successful send.',
    )
    : t(
      'Questo strumento funziona attraverso la piattaforma Yourang, che per questo salone non è ancora attiva. Prosegui per richiedere informazioni: gli specialisti si occupano dell’attivazione del piano e della configurazione della piattaforma.',
      'This tool works through the Yourang platform, which is not active for this salon yet. Continue to request information: the specialists handle plan activation and platform setup.',
    );

  const cta = noCredit
    ? t('Apri su Yourang', 'Open in Yourang')
    : t('Richiedi informazioni', 'Request information');

  const go = () => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  };

  return (
    <DkModal open onClose={onClose} title={title} sub={sub} width={520}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{
          width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'grid',
          placeItems: 'center',
          background: noCredit ? 'var(--warn-tint)' : 'var(--clay-tint)',
        }}>
          <Icon name={noCredit ? 'wallet' : 'lock'} size={20}
            color={noCredit ? 'var(--warn)' : 'var(--clay-ink)'} />
        </div>
        <div className="t-body" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>{body}</div>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 24 }}>
        <button className="dk-btn dk-btn--soft" onClick={onClose}>
          {t('Non ora', 'Not now')}
        </button>
        <button className="dk-btn dk-btn--primary" onClick={go} disabled={!url}
          title={url || t('Destinazione non configurata', 'Destination not configured')}>
          <Icon name="ext" size={16} color="#fff" />{cta}
        </button>
      </div>

      {!url && (
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 12, textAlign: 'right' }}>
          {t('Destinazione Yourang non ancora configurata.', 'Yourang destination not configured yet.')}
        </div>
      )}
    </DkModal>
  );
}
