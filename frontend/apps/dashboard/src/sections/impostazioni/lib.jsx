// lib.jsx — local shared helpers for the impostazioni section.
// DkCondRow qui è la riga di condizione delle regole caparra: stessa grafica
// di quella delle automazioni (automazioni/DkCondRow.jsx) ma un altro modello
// di campi (depositFields, con i tipi bool/enum/num/money), quindi resta sua.
// Il menu a tendina è quello comune, ui/DkDrop.jsx.
import React from 'react';
import { Icon, NumInput, copyText } from '@youty/shared';
import DkSeg from '../../ui/DkSeg.jsx';
import DkDrop from '../../ui/DkDrop.jsx';

// logica pura delle regole caparra: vive in rules.js (provata con node --test)
export { depositFields, ruleSentence, amountForType } from './rules.js';

/* ---------------- common bits ---------------- */
export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14,
  padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', color: 'var(--ink)',
};

export function LockNote({ t, msg }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 12, border: '1px solid var(--hair)' }}>
      <Icon name="lock" size={16} color="var(--muted)" />
      <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>
        {msg || t('Sezione riservata al titolare.', 'This section is reserved to the owner.')}
      </span>
    </div>
  );
}

export function CopyField({ value, t, fireToast }) {
  /* Si aspetta l'esito della copia (copyText, col ripiego di execCommand): la
   * promessa di navigator.clipboard.writeText non era attesa, e con la copia
   * rifiutata (permesso negato, pagina non sicura, niente clipboard) restava
   * una rejection non gestita e partiva lo stesso «Copiato negli appunti». Il
   * titolare incollava quello che aveva negli appunti prima, per esempio al
   * posto del link d'invito per una collega (voce 47). */
  const copy = async () => {
    const ok = await copyText(value);
    fireToast && fireToast(ok
      ? { msg: t('Copiato negli appunti', 'Copied to clipboard'), icon: 'check' }
      : { msg: t('Copia non riuscita: seleziona il testo e copialo a mano', 'Copy failed: select the text and copy it by hand'), icon: 'alert' });
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 6px 0 12px', height: 40, background: 'var(--surface-2)' }}>
      <span style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      <button onClick={copy} className="dk-btn dk-btn--soft" style={{ height: 30, padding: '0 12px', fontSize: 12.5, flexShrink: 0 }} title={t('Copia', 'Copy')}>
        <Icon name="tag" size={13} />{t('Copia', 'Copy')}
      </button>
    </div>
  );
}

/* ---------------- condition builder (vedi la nota in cima) ----------------
   Works directly on the API rule shape: { field, cmp, value }
   cmp ∈ eq,neq,lt,lte,gt,gte,contains */
const CMP_NUM = [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '=']];

export function DkCondRow({ rule, onChange, onRemove, t, lang, fields }) {
  const f = fields.find((x) => x.id === rule.field) || fields[0];
  const unitTxt = typeof f.unit === 'object' ? f.unit[lang] : f.unit;
  const onField = (fid) => {
    const nf = fields.find((x) => x.id === fid) || fields[0];
    if (nf.type === 'bool') onChange({ field: fid, cmp: 'eq', value: true });
    else if (nf.type === 'enum') onChange({ field: fid, cmp: nf.cmp || 'eq', value: nf.options.length ? nf.options[0].value : '' });
    else onChange({ field: fid, cmp: nf.defaultCmp || 'gt', value: nf.defaultValue != null ? nf.defaultValue : (nf.type === 'money' ? 100 : 1) });
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', padding: '11px 13px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--hair)' }}>
      <span style={{ fontWeight: 800, fontSize: 11.5, letterSpacing: '0.08em', color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 8px', borderRadius: 6 }}>{t('SE', 'IF')}</span>
      <DkDrop value={rule.field} onChange={onField} options={fields.map((x) => ({ value: x.id, label: x.label[lang] || x.label.it }))} />
      {f.type === 'bool' ? (
        <React.Fragment>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>{t('è', 'is')}</span>
          <DkSeg value={rule.value ? 'y' : 'n'} onChange={(v) => onChange({ value: v === 'y' })} options={[{ value: 'y', label: t('Sì', 'Yes') }, { value: 'n', label: 'No' }]} style={{ padding: 3 }} />
        </React.Fragment>
      ) : f.type === 'enum' ? (
        <React.Fragment>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>{f.cmp === 'contains' ? t('include', 'includes') : t('è', 'is')}</span>
          <DkDrop value={rule.value} onChange={(v) => onChange({ value: v })} options={f.options} missingLabel={f.missingLabel} loose={f.loose} />
        </React.Fragment>
      ) : (
        <React.Fragment>
          <DkDrop value={rule.cmp} onChange={(v) => onChange({ cmp: v })} options={CMP_NUM.map(([k, s]) => ({ value: k, label: s }))} narrow />
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--hair)', borderRadius: 9, padding: '0 10px', height: 36, background: 'var(--surface)' }}>
            {f.type === 'money' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>}
            <NumInput integer min={0} value={rule.value} onChange={(value) => onChange({ value })} style={{ width: 52, border: 'none', outline: 'none', background: 'transparent', fontSize: 14.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} />
            {unitTxt && f.type !== 'money' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>{unitTxt}</span>}
          </div>
        </React.Fragment>
      )}
      <div style={{ flex: 1 }} />
      <button className="dk-iconbtn" onClick={onRemove} aria-label="remove" style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 9, cursor: 'pointer', color: 'var(--muted)' }}><Icon name="x" size={16} /></button>
    </div>
  );
}
