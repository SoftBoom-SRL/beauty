// TechSheetModal — registry modal (opened e.g. from the agenda appointment
// detail): shows the immutable sheet linked to an appointment / a specific
// sheet, or the creation form when none exists yet.
// Props (all optional except clientId): { clientId, apptId, apptLabel,
// category, viewSheetId }.
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';
import { TechSheetCard, TechSheetForm } from '../TechSheet.jsx';

export default function TechSheetModal({ clientId, apptId = null, apptLabel = '', category, viewSheetId = null, onClose }) {
  const { t, fireToast } = useDash();
  const [sheets, setSheets] = useState(null);
  const [clientName, setClientName] = useState('');

  useEffect(() => {
    let dead = false;
    if (!clientId) { setSheets([]); return undefined; }
    api.get(`/api/clients/${clientId}/sheets`)
      .then((rows) => { if (!dead) setSheets(rows); })
      .catch((err) => {
        if (dead) return;
        setSheets([]);
        fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
      });
    api.get(`/api/clients/${clientId}`)
      .then((c) => { if (!dead) setClientName(c.full_name); })
      .catch(() => {});
    return () => { dead = true; };
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  const existing = sheets == null ? null
    : viewSheetId ? sheets.find((s) => s.id === viewSheetId)
    : apptId ? sheets.find((s) => s.appointment_id === apptId)
    : null;

  return (
    <DkModal open onClose={onClose} title={t('Scheda tecnica', 'Technical sheet')}
      sub={[clientName, apptLabel].filter(Boolean).join(' · ')} width={560}>
      {sheets == null && <div className="skel" style={{ height: 180, borderRadius: 12, margin: '4px 0 12px' }} />}
      {sheets != null && (existing ? (
        <TechSheetCard sheet={existing} defaultOpen />
      ) : !clientId ? (
        <div className="t-body" style={{ color: 'var(--muted)', padding: '8px 0 16px' }}>
          {t('Nessun cliente collegato a questo appuntamento.', 'No client linked to this appointment.')}
        </div>
      ) : (
        <TechSheetForm clientId={clientId} appointmentId={apptId} defaultCategory={category}
          onCancel={onClose}
          onSaved={() => {
            fireToast({ msg: t('Scheda tecnica salvata', 'Technical sheet saved'), icon: 'check' });
            onClose();
          }} />
      ))}
    </DkModal>
  );
}
