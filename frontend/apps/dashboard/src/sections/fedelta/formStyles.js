// formStyles.js — small style helpers shared by the fedelta modals (coupon / loyalty / gift card).
// Kept local to this section — no shared UI package changes needed for these one-off form controls.

export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5,
  padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%',
};

export const numCss = {
  display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)',
  borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)',
};

/** Segmented-button style: solid ink when active. */
export function segBtn(on) {
  return {
    flex: 1, padding: '10px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
    border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'),
    background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)',
  };
}

/** Pill-button style: clay tint when active (or a custom accent colour). */
export function pillBtn(on, accent) {
  const border = accent || 'var(--clay)';
  const tint = accent ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'var(--clay-tint)';
  const ink = accent || 'var(--clay-ink)';
  return {
    padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    border: '1px solid ' + (on ? border : 'var(--hair)'),
    background: on ? tint : 'var(--surface)', color: on ? ink : 'var(--ink-2)',
  };
}
