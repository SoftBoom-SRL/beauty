// DashedEmpty.jsx — il riquadro tratteggiato degli elenchi vuoti.

/** Dashed empty box used across wallet/waitlist lists. */
export function DashedEmpty({ children, style = {} }) {
  return (
    <div style={{ padding: '18px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--hair)', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5, ...style }}>
      {children}
    </div>
  );
}
