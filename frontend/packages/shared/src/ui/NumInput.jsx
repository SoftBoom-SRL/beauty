// NumInput.jsx — campo numerico universale della piattaforma.
//
// Perché esiste: i normali <input type="number"> mostrano le freccette su/giù
// del browser e, quando il valore del modello è 0, costringono a cancellare lo
// "0" prima di poter digitare. Questo componente risolve entrambe le cose:
//
//   • usa type="text" + inputMode → nessuna freccetta nativa, solo tastiera;
//   • quando il valore è 0 / null / '' mostra un placeholder grigio (campo
//     "vuoto"), non uno zero fisso da eliminare a mano;
//   • bufferizza la stringa digitata mentre il campo è a fuoco, così input
//     parziali come "12." o "0,5" continuano a funzionare;
//   • emette sempre un Number al genitore (0 quando il campo è vuoto), quindi
//     i calcoli a valle non cambiano comportamento.
//
// Props principali:
//   value      number | '' | null           valore del modello
//   onChange   (n:number) => void            riceve sempre un numero
//   integer    bool  (default false)         solo interi (niente decimali)
//   min, max   number                        clamp applicato all'uscita (blur)
//   decimals   number (default 2)            cifre decimali max (se non integer)
//   placeholder string (default '0')         testo grigio a campo vuoto
//   ...rest    className, style, disabled, autoFocus, aria-label, onFocus, onBlur…
import React, { useState } from 'react';

// "vuoto" a video: null/undefined, stringa vuota, oppure qualunque zero
// (numerico o stringa tipo "0" / "0.00" che arriva dall'API).
const isBlank = (v) => v == null || v === '' || Number(v) === 0;

export function NumInput({
  value,
  onChange,
  integer = false,
  min,
  max,
  decimals = 2,
  placeholder = '0',
  emptyValue = 0,
  onFocus,
  onBlur,
  ...rest
}) {
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState('');

  // A campo non attivo il display deriva dal modello: vuoto quando 0/blank.
  const display = focused ? raw : (isBlank(value) ? '' : String(value));

  const clean = (v) => {
    if (integer) return v.replace(/[^0-9]/g, '');
    v = v.replace(',', '.').replace(/[^0-9.]/g, '');
    const parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
    if (decimals != null && parts[1] != null) {
      v = parts[0] + '.' + parts[1].slice(0, decimals);
    }
    return v;
  };

  const emit = (v) => {
    if (v === '' || v === '.') { onChange(emptyValue); return; }
    const n = integer ? parseInt(v, 10) : parseFloat(v);
    onChange(Number.isFinite(n) ? n : emptyValue);
  };

  const handleChange = (e) => {
    const v = clean(e.target.value);
    setRaw(v);
    emit(v);
  };

  const handleFocus = (e) => {
    setFocused(true);
    setRaw(isBlank(value) ? '' : String(value));
    onFocus?.(e);
  };

  const handleBlur = (e) => {
    setFocused(false);
    let n = integer ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(n)) {
      // campo lasciato vuoto → resta vuoto (nessun clamp a min)
      onChange(emptyValue);
    } else {
      // clamp del range solo quando c'è un valore digitato
      if (min != null) n = Math.max(min, n);
      if (max != null) n = Math.min(max, n);
      onChange(n);
    }
    onBlur?.(e);
  };

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={display}
      placeholder={placeholder}
      {...rest}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  );
}
