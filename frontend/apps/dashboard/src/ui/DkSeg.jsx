import React from 'react';

export default function DkSeg({ options, value, onChange, style }) {
  return (
    <div className="dk-seg" style={style}>
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
