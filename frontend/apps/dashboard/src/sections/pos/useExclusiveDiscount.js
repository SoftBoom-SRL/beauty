// useExclusiveDiscount — lo sconto sui prodotti della Exclusive Card della
// cliente del conto: la titolare lo dava a memoria, guardando un foglio a
// parte (Beauty Boutique, 11/2026). 0 se la carta non è attiva in
// Impostazioni, se la cliente non è iscritta o se l'iscrizione è scaduta.
import { useResource } from '../../hooks/useResource.js';
import { useDash } from '../../ctx.jsx';
import { exclusiveApi } from '../../api/marketing.js';

/** → la percentuale di sconto sui prodotti per la cliente `clientId` (0 = nessuno). */
export default function useExclusiveDiscount(clientId) {
  const { settings } = useDash();
  const conf = settings?.exclusive_card;
  const pct = conf?.enabled ? Number(conf.product_discount_pct) || 0 : 0;
  const on = pct > 0 && clientId != null;
  const { data } = useResource(() => exclusiveApi.ofClient(clientId), [clientId], { enabled: on, fallback: null });
  // la risposta di un'altra cliente (appena cambiata nel conto) non vale
  if (!on || !data?.membership?.active || data.membership.client_id !== clientId) return 0;
  return pct;
}
