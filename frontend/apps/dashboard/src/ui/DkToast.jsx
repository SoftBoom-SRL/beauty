import React, { useEffect } from 'react';
import { Icon } from '@youty/shared';

/** Desktop toast. Feed it the `toastProps` from useToastHost() (exposed on ctx). */
export default function DkToast({ toast, onUndo, onDone }) {
  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(onDone, toast.undo ? 4500 : 2800);
    return () => clearTimeout(tm);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="dk-toast">
      {toast.icon && <Icon name={toast.icon} size={20} color="#fff" />}
      <span style={{ flex: 1, fontSize: 14.5, fontWeight: 500 }}>{toast.msg}</span>
      {toast.undo && <button onClick={onUndo} style={{ color: 'var(--clay-tint)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>{toast.undo}</button>}
    </div>
  );
}
