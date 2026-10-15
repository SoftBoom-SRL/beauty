// sell/PackageForm.jsx — scegli un pacchetto di listino da vendere (check-out e
// banco). Venduto, diventa le sedute della cliente: una carta per servizio
// del pacchetto, che l'agenda mostra sulle sue visite e la cassa scala.
import { Icon } from '@youty/shared';
import { inputCss, money } from '../lib.js';
import { packageSummary } from '../lines.js';

/* `packages`: i pacchetti in vendita (null = in arrivo); `form`: { packageId };
 * `setForm` accetta una funzione, come lo stato; `onCancel` facoltativo. */
export default function PackageForm({ packages, services, form, setForm, onAdd, onCancel, t, lang }) {
  const chosen = (packages || []).find((p) => String(p.id) === String(form.packageId)) || null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select value={form.packageId ?? ''} onChange={(e) => setForm((f) => ({ ...f, packageId: e.target.value }))}
          aria-label={t('Pacchetto', 'Package')} style={{ ...inputCss, flex: 1, minWidth: 170, cursor: 'pointer' }}>
          <option value="">{packages === null ? t('Caricamento…', 'Loading…') : t('Scegli un pacchetto…', 'Choose a package…')}</option>
          {(packages || []).map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price, lang)}</option>)}
        </select>
        <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 11px' }} disabled={!chosen} onClick={() => onAdd(chosen)}>
          <Icon name="plus" size={13} />{t('Aggiungi', 'Add')}
        </button>
        {onCancel && <button className="dk-iconbtn" style={{ width: 30, height: 30 }} onClick={onCancel}><Icon name="x" size={14} /></button>}
      </div>
      {chosen && (
        <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>
          {packageSummary(chosen, services, lang)}
          {chosen.validity_days ? ' · ' + t(`sedute valide ${chosen.validity_days} giorni`, `sessions valid ${chosen.validity_days} days`) : ''}
        </div>
      )}
      {packages && !packages.length && (
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>
          {t('Nessun pacchetto in vendita: si creano in Servizi, alla voce Pacchetti.', 'No packages on sale: create them in Services, under Packages.')}
        </div>
      )}
    </div>
  );
}
