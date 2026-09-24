// DepositCard — la caparra nel dettaglio: stato, importo (e rimborsato, e
// ancora in cassa), scadenza sull'orologio del salone; con la caparra da
// versare, link di pagamento, sollecito, copia e incasso al banco; da
// rimborsare, «Segna rimborsata». `dm` = depositMeta dello stato.
import { Icon, fmtEur } from '@youty/shared';
import { depositDueLabel } from '../rules.js';

export default function DepositCard({
  appt, dm, t, lang, terminal, hasScope, busy, linkBusy, linkCopyFailed,
  sendDepositLink, copyDepositLink, cashDeposit, onMarkRefunded,
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderRadius: 12, background: appt.deposit_status === 'paid' ? 'var(--ok-tint)' : 'var(--warn-tint)', border: '1px solid color-mix(in srgb, ' + dm.color + ' 28%, transparent)' }}>
      <div style={{ width: 34, height: 34, borderRadius: 10, background: appt.deposit_status === 'paid' ? 'var(--ok)' : 'var(--surface)', border: appt.deposit_status === 'paid' ? 'none' : '1.5px dashed ' + dm.color, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Icon name={appt.deposit_status === 'paid' ? 'check' : 'wallet'} size={16} color={appt.deposit_status === 'paid' ? '#fff' : dm.color} stroke={appt.deposit_status === 'paid' ? 3 : 1.7} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: dm.color }}>{dm.label}</div>
        <div className="t-sm" style={{ color: 'var(--ink-2)' }}>
          {fmtEur(Number(appt.deposit_amount), lang)}
          {/* Rimborso parziale: in cassa resta meno di quanto la cliente
              ha versato, e al checkout si detrae quel meno. Scrivere solo
              l'importo versato faceva leggere all'operatrice una cifra
              che il salone non ha più. */}
          {Number(appt.deposit_refunded_amount || 0) > 0 && (
            <span> · {t('rimborsati', 'refunded')} <b className="tabnum">{fmtEur(Number(appt.deposit_refunded_amount), lang)}</b>
              {/* «In cassa» ha senso finché quella quota è ancora da
                  scontare: a visita chiusa è già stata detratta dal
                  conto, e ripeterla faceva sembrare che il salone la
                  tenesse ancora da parte. */}
              {appt.deposit_status === 'paid' && appt.status !== 'closed' && (
                <>, {t('in cassa', 'in the till')} <b className="tabnum">{fmtEur(Number(appt.deposit_credit), lang)}</b></>
              )}
            </span>
          )}
          {/* Orario del SALONE: da un portatile con un altro fuso la
              scadenza si leggeva spostata di ore, e la reception
              richiamava la cliente quando il posto era già libero. */}
          {appt.deposit_status === 'required' && appt.deposit_due_at && !terminal && (
            <span> · {t('entro le', 'by')} <b className="tabnum">{depositDueLabel(appt.deposit_due_at, lang)}</b>{t(', poi lo slot si libera', ', then the slot is freed')}</span>
          )}
        </div>
        {appt.deposit_status === 'required' && !terminal && hasScope('sales') && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="dk-btn dk-btn--soft" disabled={linkBusy} style={{ height: 30, fontSize: 12 }} onClick={sendDepositLink} title={t('Crea il link di pagamento Stripe e lo manda alla cliente (WhatsApp via Yourang)', 'Creates the Stripe payment link and sends it to the client (WhatsApp via Yourang)')}>
              <Icon name="send" size={13} />{appt.deposit_payment_link ? t('Sollecita', 'Remind') : t('Invia link di pagamento', 'Send payment link')}
            </button>
            {appt.deposit_payment_link && (
              <button className="dk-btn dk-btn--ghost" style={{ height: 30, fontSize: 12 }} onClick={copyDepositLink}>
                <Icon name="copy" size={13} />{t('Copia link', 'Copy link')}
              </button>
            )}
            {appt.deposit_payment_link && linkCopyFailed && (
              <input readOnly value={appt.deposit_payment_link} onFocus={(e) => e.currentTarget.select()} aria-label={t('Link di pagamento', 'Payment link')}
                style={{ flexBasis: '100%', minWidth: 0, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--mono, monospace)', background: 'var(--surface)', color: 'var(--ink)', outline: 'none' }} />
            )}
            {/* Il salone che non incassa online non aveva nessun modo di
                registrare la caparra pagata al banco: il termine scadeva
                e lo slot si liberava sotto gli occhi dell'operatrice. */}
            <button className="dk-btn dk-btn--ghost" disabled={linkBusy} style={{ height: 30, fontSize: 12 }} onClick={() => cashDeposit('cash')}
              title={t('Segna la caparra incassata in contanti al banco: il posto non si libera più e l’incasso entra in cassa', 'Mark the deposit as cashed at the counter: the slot is no longer freed and the money is recorded in the till')}>
              <Icon name="wallet" size={13} />{t('Incassata: contanti', 'Cashed: cash')}
            </button>
            <button className="dk-btn dk-btn--ghost" disabled={linkBusy} style={{ height: 30, fontSize: 12 }} onClick={() => cashDeposit('card')}
              title={t('Segna la caparra incassata con il POS del salone', 'Mark the deposit as cashed on the salon card terminal')}>
              <Icon name="wallet" size={13} />{t('Incassata: POS', 'Cashed: card')}
            </button>
          </div>
        )}
      </div>
      {appt.deposit_status === 'refund_due' && hasScope('sales') && (
        <button className="dk-btn dk-btn--soft" disabled={busy} style={{ height: 32, fontSize: 12.5, flexShrink: 0 }}
          title={t('Conferma di aver restituito la caparra alla cliente', 'Confirm you have returned the deposit to the client')}
          onClick={onMarkRefunded}>
          <Icon name="check" size={14} />{t('Segna rimborsata', 'Mark refunded')}
        </button>
      )}
    </div>
  );
}
