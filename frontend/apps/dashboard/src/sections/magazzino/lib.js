// lib.js — Magazzino: API-enum metadata + pure helpers shared by the sub-tabs.
import { ApiError } from '@youty/shared';

/* ---- stock_state (server-computed: low / warning / ok) ---- */
export const STOCK_META = {
  low:     { color: '#D14343', tint: 'rgba(209,67,67,0.14)',  it: 'Sotto soglia',        en: 'Below threshold' },
  warning: { color: '#D98A3A', tint: 'rgba(217,138,58,0.16)', it: 'Vicino alla soglia',  en: 'Near threshold' },
  ok:      { color: '#3F9D6B', tint: 'rgba(63,157,107,0.14)', it: 'Nella norma',          en: 'In stock' },
};

/* ---- product usage enum ---- */
export const USAGE_META = {
  retail:   { it: 'Vendita',     en: 'Retail',   color: 'var(--ok)',       tint: 'var(--ok-tint)' },
  internal: { it: 'Uso interno', en: 'In-salon', color: 'var(--info)',     tint: 'var(--info-tint)' },
  mixed:    { it: 'Misto',       en: 'Mixed',    color: 'var(--clay-ink)', tint: 'var(--clay-tint)' },
};

/* ---- movement kind enum ---- */
export const MOVE_META = {
  load:            { icon: 'arrowDn', color: 'var(--ok)',    tint: 'var(--ok-tint)',    it: 'Carico',           en: 'Stock in' },
  sale:            { icon: 'arrowUp', color: 'var(--muted)', tint: 'var(--surface-2)',  it: 'Vendita',          en: 'Sale' },
  internal_use:    { icon: 'arrowUp', color: 'var(--info)',  tint: 'var(--info-tint)',  it: 'Uso interno',      en: 'Internal use' },
  adjustment:      { icon: 'edit',    color: 'var(--warn)',  tint: 'var(--warn-tint)',  it: 'Rettifica',        en: 'Adjustment' },
  transfer:        { icon: 'refresh', color: 'var(--info)',  tint: 'var(--surface-2)',  it: 'Trasferimento',    en: 'Transfer' },
  return_supplier: { icon: 'undo',    color: 'var(--warn)',  tint: 'var(--warn-tint)',  it: 'Reso a fornitore', en: 'Supplier return' },
};

/* ---- supplier order methods ---- */
export const ORDER_METHODS = {
  email:    { it: 'Email',    en: 'Email',    icon: 'mail' },
  whatsapp: { it: 'WhatsApp', en: 'WhatsApp', icon: 'whatsapp' },
  pdf:      { it: 'PDF',      en: 'PDF',      icon: 'arrowDn' },
};

/* ---- purchase-order status enum ---- */
export const ORDER_STATUS_META = {
  draft:    { it: 'Bozza',    en: 'Draft',    color: 'var(--muted)', tint: 'var(--surface-2)' },
  sent:     { it: 'Inviato',  en: 'Sent',     color: 'var(--ok)',    tint: 'var(--ok-tint)' },
  received: { it: 'Ricevuto', en: 'Received', color: 'var(--ok)',    tint: 'var(--ok-tint)' },
  partial:  { it: 'Parziale', en: 'Partial',  color: 'var(--warn)',  tint: 'var(--warn-tint)' },
};

export const UNIT_OPTIONS = ['pz', 'flaconi', 'tubi', 'ml', 'g', 'vasetti', 'confezioni'];

/* ---- numbers: the API sends decimals as strings ("3.00") ---- */
export const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
export const fmtQty = (x, lang) => num(x).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT');
/** fmtEur renders 0 as "Gratis" — for stock values we want €0 */
export const eur0 = (n, lang, fmtEur) => (num(n) === 0 ? '€0' : fmtEur(num(n), lang));

/** unit purchase cost net of the supplier discount */
export const unitCost = (p) => (p ? num(p.purchase_price) * (1 - num(p.purchase_discount_pct) / 100) : 0);

/** net / VAT / total for an order line */
export function orderLineMath(qty, cost, vatRate) {
  const net = num(qty) * num(cost);
  const vat = (net * num(vatRate)) / 100;
  return { net, vat, total: net + vat };
}

/** ISO datetime → "3 lug · 14:30" */
export function fmtWhen(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  const day = d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'short' });
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} · ${hh}:${mm}`;
}

/** ApiError → toast message */
export const errMsg = (err, t) =>
  err instanceof ApiError ? err.message : t('Errore di rete', 'Network error');

/* ---- CSV paste parsing (restock import) ----
 * One row per product: "name-or-sku, qty" (delimiter , ; or tab).
 * Header rows are skipped. Returns [{ key, qty }] where key = name or SKU. */
export function parseRestockCsv(text) {
  const rows = String(text || '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const out = [];
  rows.forEach((row, i) => {
    if (i === 0 && /nome|name|prodotto|product|sku|quant|qty/i.test(row) && !/\d/.test(row)) return;
    const cols = row.split(/[,;\t]/).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    if (cols.length < 2) return;
    const key = cols[0];
    const qty = parseInt(cols[cols.length - 1], 10);
    if (!key || !Number.isFinite(qty) || qty <= 0) return;
    out.push({ key, qty });
  });
  return out;
}

/* ---- Order PDF export ----
 * Reimplemented WITHOUT dependencies: opens a print-friendly HTML window
 * (window.open + @page print CSS) — the browser's print dialog saves it as PDF.
 * Returns false when the popup was blocked. */
export function openOrderPrint({ salonName, order, supplier, lines, lang }) {
  const tt = (it, en) => (lang === 'en' ? en : it);
  const loc = lang === 'en' ? 'en-GB' : 'it-IT';
  const eur = (n) => '€' + num(n).toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = new Date().toLocaleDateString(loc, { day: '2-digit', month: 'long', year: 'numeric' });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let net = 0;
  let vat = 0;
  const rows = lines.map((l) => {
    const m = orderLineMath(l.qty, l.cost, l.vat);
    net += m.net; vat += m.vat;
    return `<tr><td>${esc(l.name)}${l.sku ? ' <span class="sku">· ' + esc(l.sku) + '</span>' : ''}</td>` +
      `<td class="r">${fmtQty(l.qty, lang)}${l.unit ? ' ' + esc(l.unit) : ''}</td>` +
      `<td class="r">${eur(l.cost)}</td><td class="r">${num(l.vat)}%</td><td class="r">${eur(m.total)}</td></tr>`;
  }).join('');
  const contact = supplier
    ? (supplier.order_method === 'whatsapp' ? (supplier.phone || supplier.email) : (supplier.email || supplier.phone))
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${tt('Ordine', 'Order')} — ${esc(order.supplier_name)}</title><style>
    @page { size: A4; margin: 22mm; }
    body { font-family: Inter, -apple-system, system-ui, sans-serif; color: #2C2C2F; font-size: 13px; }
    h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: .04em; text-transform: uppercase; }
    .muted { color: #6F6E74; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1F1F21; padding-bottom: 14px; margin-bottom: 22px; }
    .to { margin-bottom: 22px; }
    .to .lbl { text-transform: uppercase; letter-spacing: .12em; font-size: 10px; color: #6F6E74; margin-bottom: 4px; }
    .to .name { font-size: 16px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { text-align: left; text-transform: uppercase; letter-spacing: .08em; font-size: 10px; color: #6F6E74; border-bottom: 1px solid #D8D6DC; padding: 8px 6px; }
    td { padding: 9px 6px; border-bottom: 1px solid #ECEAEE; }
    .r { text-align: right; }
    .sku { color: #93919A; font-size: 11px; }
    .tot { margin-top: 18px; margin-left: auto; width: 240px; }
    .tot .row { display: flex; justify-content: space-between; padding: 5px 0; }
    .tot .grand { border-top: 2px solid #1F1F21; margin-top: 4px; padding-top: 8px; font-size: 17px; font-weight: 800; }
  </style></head><body>
    <div class="head"><div><h1>${esc(salonName || '')}</h1><div class="muted">${tt("Buono d'ordine", 'Purchase order')} · ${today}</div></div><div class="muted r">${tt('Rif.', 'Ref.')} PO-${order.id}</div></div>
    <div class="to"><div class="lbl">${tt('Fornitore', 'Supplier')}</div><div class="name">${esc(order.supplier_name)}</div>${contact ? '<div class="muted">' + esc(contact) + '</div>' : ''}</div>
    <table><thead><tr><th>${tt('Prodotto', 'Product')}</th><th class="r">${tt('Quantità', 'Qty')}</th><th class="r">${tt('Prezzo un.', 'Unit price')}</th><th class="r">IVA</th><th class="r">${tt('Totale', 'Total')}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="tot"><div class="row"><span class="muted">${tt('Imponibile', 'Net')}</span><span>${eur(net)}</span></div><div class="row"><span class="muted">IVA</span><span>${eur(vat)}</span></div><div class="row grand"><span>${tt('Totale', 'Total')}</span><span>${eur(net + vat)}</span></div></div>
    <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) {
    w.document.write(html);
    w.document.close();
  }
  return !!w;
}
