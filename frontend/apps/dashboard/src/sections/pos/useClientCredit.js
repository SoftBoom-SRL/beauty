// useClientCredit — le carte a importo della cliente con saldo da spendere (la
// «carta VIP» ricaricabile, le gift card ricevute): la cassa le propone fra i
// metodi di pagamento, senza dover scrivere il codice.
import { useResource } from '../../hooks/useResource.js';
import { giftCardsApi } from '../../api/marketing.js';
import { ownsCredit } from '../fedelta/credits.js';

/** → [carta] della cliente `clientId` (vuoto senza cliente o se la lettura fallisce). */
export default function useClientCredit(clientId, enabled = true) {
  const on = enabled && clientId != null;
  const { data } = useResource(
    () => giftCardsApi.list({ client_id: clientId, status: 'active', payment_status: 'paid' }),
    [clientId],
    { enabled: on, fallback: { items: [] } },
  );
  if (!on || !data) return [];
  return (data.items || []).filter((g) => g.gift_service_id == null && Number(g.balance) > 0 && ownsCredit(g, clientId));
}
