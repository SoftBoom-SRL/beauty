// vipBonus.js — il bonus della «carta VIP» (Impostazioni → Bonus carta VIP):
// chi carica almeno la soglia riceve il bonus in credito in più, in cassa
// entra solo il pagato. La regola vera la applica il server
// (marketing.gift_cards.vip_bonus_for); qui serve a dirlo PRIMA di ricaricare.
// Logica pura: la caricano anche i test con `node --test`.

const cents = (v) => Math.round(Number(String(v ?? '').replace(',', '.')) * 100);

/** Il bonus in centesimi per un carico di `amount` € (stringa o numero): quello
 *  della soglia più alta raggiunta, 0 senza regole o sotto la prima. */
export function vipBonusCents(rules, amount) {
  const paid = cents(amount);
  if (!(paid > 0)) return 0;
  let best = null;
  for (const r of rules || []) {
    const min = cents(r.min_amount), bonus = cents(r.bonus);
    if (paid >= min && bonus > 0 && (!best || min > best.min)) best = { min, bonus };
  }
  return best ? best.bonus : 0;
}
