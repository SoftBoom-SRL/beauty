# Magazzino / catalogo / staff — 2 alti, 8 medi, 6 bassi

## [G1] PUT /products/{id} riscrive stock_qty e annulla i movimenti concorrenti — ALTO
- Dove: apps/inventory/api.py:64 (_apply_product_payload), chiamata da update_product:141
- Cosa: product.save() senza update_fields scrive tutti i campi, stock_qty compresa, col valore letto a inizio richiesta. models.py:55 dice esplicitamente che stock_qty non va mai scritta direttamente; delete_product usa update_fields, qui manca.
- Scenario: si salva un cambio di prezzo su Shampoo (giacenza 10) mentre il POS vende 3 pezzi. Il save riporta stock_qty a 10: a magazzino restano 10 ma lo storico dice che ne sono usciti 3.
- Fix: save(update_fields=[...]) coi soli campi anagrafici, o select_for_update.

## [G2] ?months= senza tetto in performance_series: un GET blocca il worker — ALTO
- Dove: apps/staff/services.py:184-205, api.py:358-361
- Cosa: months = max(1, int(months)) limita solo il basso, e genera una query di aggregazione per mese.
- Scenario: GET /api/staff/1/performance?months=20000 -> 20.000 SELECT in serie; con 50.000.000 il worker esaurisce la memoria. Nessuno scope richiesto.
- Fix: min(int(months), 36) e una sola query TruncMonth + GROUP BY.

## [G3] Fattura allegata al carico: URL non firmato -> 403 sempre — MEDIO
- Dove: apps/inventory/schemas.py:168-170. invoice ha upload_to inventory/invoices/, prefisso privato in common/media.py:18.
- Scenario: in Magazzino > Storico il link apre "Accesso al file non autorizzato". Funzione inutilizzabile al 100%.
- Fix: signed_media_url(obj.invoice).

## [G4] N+1 nella lista operatrici: ~6 query per operatrice — MEDIO
- Dove: apps/staff/api.py:70-71, 137-155. 15 operatrici -> ~90 query, pagina aperta tutto il giorno.

## [G5] Abbassare cycle_weeks lascia turni orfani: l'operatrice sparisce — MEDIO
- Dove: apps/staff/api.py:99-117, services.py:103-108
- Scenario: rotazione da 2 a 1 settimana; se la seconda chiamata (PUT shifts) fallisce restano turni con week_index=1 mai piu selezionati: meta delle settimane l'operatrice risulta a riposo e la causa non e visibile.

## [G6] PUT /packages/{id} senza items svuota il pacchetto — MEDIO
- Dove: apps/catalog/schemas.py:82 (items default []), api.py:272-273.

## [G7] Upload fattura senza validazione tipo/dimensione — MEDIO
- Dove: apps/inventory/api.py:173-192. Nessun controllo content_type ne size, a differenza di clients/api.py:442-447.

## [G8] N+1 in served_clients: un aggregate per cliente — MEDIO
- Dove: apps/staff/services.py:232-240. 600 clienti -> 601 query.

## [G9] week_index frontend e backend divergono dal 2027-01-04 — MEDIO
- Dove: apps/staff/services.py:58-67 vs frontend staff/lib.js:145-156
- Scenario: con cycle_weeks=2 le formule coincidono fino al 2027-01-03 e divergono per 728 giorni. ShiftPattern marca come "settimana corrente" quella sbagliata: chi modifica "questa settimana" modifica l'altra.

## [G10] PUT /orders/{id} applica le righe fuori transazione — MEDIO
- Dove: apps/inventory/api.py:486-509. Una riga sconosciuta da 404 dopo che le precedenti sono gia state scritte.

## [G11] generate_draft_orders senza lock: bozze e righe duplicate — BASSO
- Dove: apps/inventory/services.py:89-121. PurchaseOrderLine non ha unique_together (order, product).

## [G12] Prodotto esattamente a soglia con reorder_qty=0 mai riordinato — BASSO
- Dove: apps/inventory/services.py:104-106. stock_state lo dice "low" ma "Genera ordini" lo scarta in silenzio.

## [G13] send_order senza lock: doppio invio al fornitore — BASSO
- Dove: apps/inventory/api.py:512-560. receive_order ha gia la correzione, send_order no.

## [G14] Campi non validati (color, order, week_index, cycle_weeks) -> 500 — BASSO
- Dove: catalog/api.py:58, inventory/api.py:414-418, staff/api.py:108-131.

## [G15] Utente gia collegato a un'altra operatrice -> IntegrityError 500 — BASSO
- Dove: apps/staff/api.py:56-67.

## [G16] Endpoint pubblici catalog/staff senza rate limit — BASSO
- Dove: catalog/api.py:307,329; staff/api.py:373. L'equivalente in agenda ha ratelimit.hit.

## Verificati e scartati
- receive_order correttamente sotto select_for_update + rilettura.
- _week_index lato backend corretto sugli anni da 53 settimane.
- Merge dei turni contigui corretto.
- Isolamento multi-salone dei tre moduli: corretto ovunque.
- Blocco giacenza negativa in apply_movement, dentro l'atomic di finalize_sale.
