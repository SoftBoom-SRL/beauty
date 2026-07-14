import React from 'react';

/** Dependency-free pseudo-QR — deterministic from `code`, purely a visual placeholder
 * (ported 1:1 from the prototype's desktop-fedelta.jsx QrMini). No real QR encoding/library. */
export default function QrMini({ code, size = 54 }) {
  const n = 11, cell = size / n;
  let s = 0;
  for (let i = 0; i < code.length; i++) s = (s * 31 + code.charCodeAt(i)) >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >> 16) & 1; };
  const inFinder = (r, c) => (r < 3 && c < 3) || (r < 3 && c > n - 4) || (r > n - 4 && c < 3);
  const cells = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (inFinder(r, c)) continue;
      if (rnd()) cells.push(<rect key={r + '-' + c} x={c * cell} y={r * cell} width={cell} height={cell} />);
    }
  }
  const finder = (x, y) => (
    <g key={x + ',' + y}>
      <rect x={x} y={y} width={cell * 3} height={cell * 3} fill="none" stroke="currentColor" strokeWidth={cell * 0.7} />
      <rect x={x + cell} y={y + cell} width={cell} height={cell} />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={'0 0 ' + size + ' ' + size} style={{ color: 'var(--ink)', display: 'block' }} fill="currentColor" aria-hidden="true">
      {cells}{finder(0, 0)}{finder((n - 3) * cell, 0)}{finder(0, (n - 3) * cell)}
    </svg>
  );
}
