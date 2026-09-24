// ClientProfile.jsx — full client profile (ported DkClientProfile): header with
// contact actions, editable labels, KPI stats, deposit banner, language card
// and the 5 tabs (Storico / Scheda tecnica / Note / Wallet / Consensi).
// I dati (caricamento, ricarico dal vivo, modifiche in coda) stanno in
// useClientDetail.js, i pezzi della pagina in ProfileHeader, ProfileLabels e
// ProfileCards.
import { useState } from 'react';
import { Icon } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { ConfirmModal } from './components.jsx';
import { useClientDetail } from './useClientDetail.js';
import ProfileHeader from './ProfileHeader.jsx';
import ProfileLabels from './ProfileLabels.jsx';
import { LanguageCard, ProfileDetails, ProfileKpis } from './ProfileCards.jsx';
import StoricoTab from './tabs/StoricoTab.jsx';
import TechSheetTab from './tabs/TechSheetTab.jsx';
import NotesTab from './tabs/NotesTab.jsx';
import WalletTab from './tabs/WalletTab.jsx';
import ConsensiTab from './tabs/ConsensiTab.jsx';
import { clientsApi } from '../../api/clients.js';

export default function ClientProfile({ clientId, onChanged, onDeleted }) {
  const { t, lang, fireToast, hasScope, clientCategories, openModal, live } = useDash();
  const canWrite = hasScope('clients');

  const { c, setC, failed, onWaitlist, updateClient, toastErr } = useClientDetail(clientId, onChanged);
  const [tab, setTab] = useState('storico');
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const doDelete = async () => {
    setDeleting(true);
    try {
      await clientsApi.remove(clientId);
      fireToast({ msg: t(`Cliente ${c.full_name} archiviato`, `Client ${c.full_name} archived`), icon: 'check' });
      setConfirmDel(false);
      onDeleted && onDeleted();
    } catch (err) { toastErr(err); } finally { setDeleting(false); }
  };

  if (failed) {
    return (
      <div style={{ padding: '40px 30px', textAlign: 'center' }}>
        <div className="t-title" style={{ marginBottom: 6 }}>{t('Cliente non disponibile', 'Client unavailable')}</div>
        <div className="t-body" style={{ color: 'var(--muted)' }}>{t('La scheda non può essere caricata.', 'The profile could not be loaded.')}</div>
      </div>
    );
  }
  if (!c) {
    return (
      <div style={{ padding: '26px 30px 40px', maxWidth: 880 }}>
        <div style={{ display: 'flex', gap: 18, marginBottom: 22 }}>
          <div className="skel" style={{ width: 76, height: 76, borderRadius: 99 }} />
          <div style={{ flex: 1 }}>
            <div className="skel" style={{ height: 30, width: 260, marginBottom: 10 }} />
            <div className="skel" style={{ height: 16, width: 180 }} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 14 }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 90, borderRadius: 16 }} />)}
        </div>
        <div className="skel" style={{ height: 260, borderRadius: 16 }} />
      </div>
    );
  }

  const openEdit = () => openModal('newclient', { client: c, onSaved: (u) => { setC((prev) => ({ ...prev, ...u })); onChanged && onChanged(); } });
  // Scheda archiviata: prima non c'era modo di riattivarla, benché la conferma
  // dell'archiviazione lo promettesse (06-02). PUT {is_active: true} da solo.
  const archived = c.is_active === false;
  const reactivate = () => updateClient({ is_active: true }, { msg: t(`Scheda di ${c.full_name} riattivata`, `${c.full_name}'s profile reactivated`), icon: 'check' });
  // la cliente archiviata che ha provato a rientrare (app o modulo contatti)
  const asked = archived ? (live?.events || []).find((e) => e.type === 'client.reactivation_requested' && e.payload?.client_id === c.id) : null;

  const tabs = [
    ['storico', t('Storico', 'History')],
    ['scheda', t('Scheda tecnica', 'Tech sheet')],
    ['note', t('Note', 'Notes')],
    ['voucher', 'Wallet'],
    ['consensi', t('Consensi', 'Consents')],
  ];

  return (
    <div style={{ padding: '26px 30px 40px', maxWidth: 880 }}>
      <ProfileHeader c={c} onWaitlist={onWaitlist} canWrite={canWrite} archived={archived}
        openEdit={openEdit} onArchive={() => setConfirmDel(true)} t={t} fireToast={fireToast} />

      {archived && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: 'var(--paper-2)', border: '1px solid var(--hair)', borderRadius: 12, margin: '-6px 0 18px' }}>
          <Icon name="alert" size={18} color="var(--muted)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink-2)' }}>{t('Scheda archiviata', 'Archived profile')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>
              {asked ? asked.summary : t('Non compare nelle liste e non si può prenotare; lo storico resta.', 'Hidden from lists and cannot be booked; history is kept.')}
            </div>
          </div>
          {canWrite && <button className="dk-btn dk-btn--clay" style={{ height: 34, fontSize: 12.5, flexShrink: 0 }} onClick={reactivate}><Icon name="refresh" size={14} color="#fff" />{t('Riattiva', 'Reactivate')}</button>}
        </div>
      )}

      <ProfileLabels c={c} canWrite={canWrite} clientCategories={clientCategories}
        updateClient={updateClient} openModal={openModal} t={t} />

      <ProfileKpis c={c} t={t} lang={lang} />
      <ProfileDetails c={c} canWrite={canWrite} openEdit={openEdit} t={t} lang={lang} />
      {c.deposit_always && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', background: 'var(--warn-tint)', borderRadius: 12, marginBottom: 14 }}>
          <Icon name="coupon" size={18} color="var(--warn)" />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)', flex: 1 }}>{t('Deposito sempre richiesto per questo cliente', 'Deposit always required for this client')}</span>
          {canWrite && <button onClick={() => updateClient({ deposit_always: false }, { msg: t('Caparra obbligatoria rimossa', 'Mandatory deposit removed'), icon: 'check' })} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}>{t('Rimuovi', 'Remove')}</button>}
        </div>
      )}

      <LanguageCard c={c} canWrite={canWrite} updateClient={updateClient} t={t} />

      {/* tabs */}
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 20 }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '11px 4px', marginRight: 18, fontSize: 14.5, fontWeight: 600, cursor: 'pointer', color: tab === k ? 'var(--ink)' : 'var(--muted)', background: 'transparent', border: 'none', borderBottom: '2px solid ' + (tab === k ? 'var(--clay)' : 'transparent'), marginBottom: -1 }}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'storico' && <StoricoTab c={c} />}
      {tab === 'scheda' && <TechSheetTab c={c} />}
      {tab === 'note' && <NotesTab clientId={c.id} />}
      {tab === 'voucher' && <WalletTab c={c} />}
      {tab === 'consensi' && <ConsensiTab c={c} updateClient={updateClient} canWrite={canWrite} />}

      {confirmDel && (
        <ConfirmModal t={t}
          title={t('Archiviare il cliente?', 'Archive this client?')}
          sub={c.full_name}
          body={t('Il cliente viene disattivato (soft delete): sparisce dalle liste ma lo storico resta. Potrà essere riattivato in seguito.', 'The client is deactivated (soft delete): removed from the lists, history is kept. It can be reactivated later.')}
          confirmLabel={t('Archivia', 'Archive')}
          busy={deleting}
          onConfirm={doDelete}
          onClose={() => setConfirmDel(false)} />
      )}
    </div>
  );
}
