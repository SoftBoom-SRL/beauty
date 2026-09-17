// DkConfirm.jsx — conferma per un'azione che non si può annullare.
//
// Esiste perché rimuovere un membro del team o eliminare una sede partivano al
// primo clic, senza chiedere niente: un clic sbagliato su una riga accanto e il
// lavoro era fatto. Le azioni distruttive chiedono, le altre no.
import React from 'react';
import { Icon } from '@youty/shared';
import DkModal from './DkModal.jsx';

export default function DkConfirm({
  open, onClose, onConfirm, title, message, detail,
  confirmLabel, cancelLabel, busy = false, danger = true,
}) {
  return (
    <DkModal
      open={open}
      onClose={() => { if (!busy) onClose?.(); }}
      title={title}
      width={420}
      foot={(
        <React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={onClose} disabled={busy}>
            {cancelLabel || 'Annulla'}
          </button>
          <button
            className={danger ? 'dk-btn dk-btn--danger' : 'dk-btn dk-btn--clay'}
            onClick={onConfirm}
            disabled={busy}
            style={danger ? { background: 'var(--danger)', color: '#fff' } : undefined}
          >
            <Icon name={danger ? 'alert' : 'check'} size={16} color="#fff" />
            {confirmLabel || 'Conferma'}
          </button>
        </React.Fragment>
      )}
    >
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: detail ? 8 : 0 }}>{message}</div>
      {detail && <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>{detail}</div>}
    </DkModal>
  );
}
