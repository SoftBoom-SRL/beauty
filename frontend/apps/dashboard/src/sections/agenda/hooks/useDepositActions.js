// useDepositActions — la caparra dal pannello di dettaglio: il link di
// pagamento (creato, o rimandato come sollecito), l'incasso (contanti o POS al
// banco, bonifico o link Nexi, con l'importo versato davvero) e la copia del link.
import { useState } from 'react';
import { ApiError, toastApiError } from '@youty/shared';
import { copyText } from '../modals/rules.js';
import { depositToApi, sameAmount } from '../lib/deposit.js';
import * as agendaApi from '../agendaApi.js';

/** `apptRef`, `alive`, `adopt` vengono da useApptCopy. */
export function useDepositActions({ apptRef, alive, adopt, t, fireToast, onMutate }) {
  const [linkBusy, setLinkBusy] = useState(false);
  /* link di pagamento della caparra: crea (o rimanda come sollecito) e copia */
  async function sendDepositLink() {
    if (linkBusy) return;
    setLinkBusy(true);
    try {
      const cur = apptRef.current;
      const res = await agendaApi.sendDepositLink(cur.id);
      if (alive.current) adopt({ ...apptRef.current, deposit_payment_link: res.url, deposit_due_at: res.due_at || apptRef.current.deposit_due_at });
      fireToast({ msg: cur.deposit_payment_link ? t('Sollecito inviato alla cliente', 'Reminder sent to the client') : t('Link di pagamento inviato alla cliente', 'Payment link sent to the client'), icon: 'check' });
      onMutate?.(apptRef.current);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) fireToast({ msg: t('Pagamenti online non configurati: collega Stripe in Impostazioni → Pagamenti', 'Online payments not configured: connect Stripe in Settings → Payments'), icon: 'alert' });
      else toastApiError(err, fireToast, t);
    } finally { if (alive.current) setLinkBusy(false); }
  }
  /* Caparra incassata: contanti o POS al banco, bonifico o link Nexi. Senza
   * questo, l'unico modo di segnarla pagata era il pagamento online: dove
   * Stripe non è configurato — o quando la cliente paga di persona — il
   * termine scadeva lo stesso e lo slot si liberava da solo.
   *
   * `depositDraft` è l'importo che si sta scrivendo: null finché nessuno lo
   * tocca (vale la caparra chiesta) o, sulla visita senza caparra, finché il
   * riquadro «Registra caparra versata» è chiuso. L'importo parte solo se è
   * diverso da quello chiesto. */
  const [depositDraft, setDepositDraft] = useState(null);
  async function cashDeposit(method) {
    if (linkBusy) return;
    const cur = apptRef.current;
    const amount = depositDraft != null && !(cur.deposit_status === 'required' && sameAmount(depositDraft, cur.deposit_amount))
      ? depositToApi(depositDraft) : undefined;
    setLinkBusy(true);
    try {
      const res = await agendaApi.cashDeposit(cur.id, method, amount);
      if (alive.current) { adopt(res); setDepositDraft(null); }
      fireToast({ msg: t('Caparra incassata e registrata in cassa', 'Deposit cashed and recorded in the till'), icon: 'check' });
      onMutate?.(res);
    } catch (err) { toastApiError(err, fireToast, t); }
    finally { if (alive.current) setLinkBusy(false); }
  }

  /* «Copia link»: la conferma si dà solo se la copia è riuscita; se non lo è,
   * il link resta scritto nel pannello da copiare a mano (13-25). */
  const [linkCopyFailed, setLinkCopyFailed] = useState(false);
  async function copyDepositLink() {
    const ok = await copyText(apptRef.current?.deposit_payment_link);
    if (!alive.current) return;
    setLinkCopyFailed(!ok);
    fireToast(ok
      ? { msg: t('Link copiato', 'Link copied'), icon: 'check' }
      : { msg: t('Copia non riuscita: il link è scritto nel pannello, selezionalo e copialo a mano', 'Copy failed: the link is shown in the panel, select it and copy it by hand'), icon: 'alert' });
  }

  return { linkBusy, linkCopyFailed, sendDepositLink, cashDeposit, copyDepositLink, depositDraft, setDepositDraft };
}
