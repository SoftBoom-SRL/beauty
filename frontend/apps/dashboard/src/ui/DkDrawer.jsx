import React from 'react';

export default function DkDrawer({ open, onClose, children }) {
  if (!open) return null;
  return (
    <div className="dk-scrim" onClick={onClose}>
      <div className="dk-drawer" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
