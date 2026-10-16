// Staff section — operator grid + per-operator page (port of prototype DkStaff/DkStaffPage).
// In cima la scelta fra le schede delle operatrici e «Turni del team»
// (TeamRoster). Dalla vista dei turni la scheda si apre sui turni; dentro la
// scheda si passa da un'operatrice all'altra senza tornare all'elenco.
import { useState } from 'react';
import { useDash } from '../../ctx.jsx';
import SubTabs from '../../ui/SubTabs.jsx';
import StaffGrid from './StaffGrid.jsx';
import StaffPage from './StaffPage.jsx';
import TeamRoster from './TeamRoster.jsx';

export default function StaffSection() {
  const { t } = useDash();
  const [openId, setOpenId] = useState(null);
  const [view, setView] = useState('cards');     // 'cards' | 'roster'
  const [tab, setTab] = useState(null);          // linguetta con cui aprire la scheda
  if (openId != null) return <StaffPage id={openId} initialTab={tab} onBack={() => setOpenId(null)} onSwitch={setOpenId} />;
  const top = (
    <SubTabs value={view} onChange={setView}
      tabs={[['cards', t('Operatrici', 'Stylists')], ['roster', t('Turni del team', 'Team shifts')]]} />
  );
  const open = (id, onTab = null) => { setTab(onTab); setOpenId(id); };
  return view === 'roster'
    ? <TeamRoster top={top} onOpen={(id) => open(id, 'turni')} />
    : <StaffGrid top={top} onOpen={(id) => open(id)} />;
}
