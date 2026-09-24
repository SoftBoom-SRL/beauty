// StickyCta.jsx — la barra del pulsante principale in fondo allo schermo.

/** Sticky bottom CTA bar (gradient fade). */
export function StickyCta({ children }) {
  return (
    <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(var(--safe-bottom) + 14px)', background: 'linear-gradient(transparent, var(--paper-0) 24%)' }}>
      {children}
    </div>
  );
}
