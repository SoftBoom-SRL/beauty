// Staff section — operator grid + per-operator page (port of prototype DkStaff/DkStaffPage).
import React, { useState } from 'react';
import StaffGrid from './StaffGrid.jsx';
import StaffPage from './StaffPage.jsx';

export default function StaffSection() {
  const [openId, setOpenId] = useState(null);
  if (openId != null) return <StaffPage id={openId} onBack={() => setOpenId(null)} />;
  return <StaffGrid onOpen={setOpenId} />;
}
