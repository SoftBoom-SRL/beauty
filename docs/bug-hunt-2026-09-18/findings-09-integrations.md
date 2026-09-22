# Integrazioni Yourang — 1 critico, 5 alti, 8 medi, 3 bassi

## [H1] event.deleted senza resource_id annulla TUTTI gli appuntamenti del salone — CRITICO
- Dove: apps/integrations/api.py:214-215 -> sync.py:322-325
- Cosa: il ramo event.deleted chiama cancel_event(conn, entity_id) senza verificare che entity_id non sia vuoto (il ramo gemello lo fa). cancel_event filtra yourang_event_id=str(event_id): con "" combacia con TUTTI gli appuntamenti nativi, perche il campo e blank=True default="" e il vincolo unico e parziale (condition=~Q(yourang_event_id=""), agenda/models.py:116-118).
- Scenario: il proxy consegna {"type":"event.deleted","organization_id":"org-x"} col campo assente o rinominato (il commento a api.py:206-207 documenta che il nome e gia cambiato una volta: prima id, ora resource_id). Risposta 200 "ok" e in una sola UPDATE l'intera agenda del salone, passata e futura, passa a cancelled.
- Fix: if not event_id: return in cancel_event, e nel dispatch elif event_type == "event.deleted" and entity_id.

## [H2] sync_clients muore con IntegrityError non gestita e blocca l'integrazione — ALTO
- Dove: apps/integrations/sync.py:138-160, 98-123
- Cosa: il try/except copre solo la chiamata HTTP, non il save. Due clienti il cui telefono e scritto in due modi ma normalizza allo stesso E.164 ricevono lo stesso contact_id e il secondo save viola uniq_client_salon_yourang_contact. Simmetrico: locals_by_phone costruito una volta e mai aggiornato.
- Scenario: anagrafica con "333 1234567" e "+39 333 1234567". Dal webhook -> 503 e Yourang ritenta all'infinito; dal cron -> connessione in ERROR. Errore deterministico, nessun tentativo puo riuscire.
- Fix: try/except per cliente, riconciliare per phone_key aggiornando gli indici dentro il ciclo.

## [H3] Un errore transitorio esclude il salone dal cron per sempre — ALTO
- Dove: management/commands/sync_yourang.py:24, 41-45
- Cosa: seleziona solo status=CONNECTED e al primo errore scrive ERROR. Nessun percorso torna a CONNECTED senza un OAuth manuale. Nessun retry ne backoff.
- Scenario: un 502 durante il cron orario e il salone non viene piu riconciliato. I webhook continuano a funzionare, quindi nessuno si accorge che il backfill e morto.

## [H4] Ogni ri-consegna evento sovrascrive operatrice, stato e nota locali — ALTO
- Dove: apps/integrations/sync.py:287-298
- Cosa: update_or_create riscrive incondizionatamente operator (sempre la prima attiva), status, start, note, created_via. Non esiste push appuntamenti->eventi, quindi il dato piu recente e sempre il nostro.
- Scenario: prenotazione assegnata a Giulia e con check-in fatto; arriva un event.updated o una ri-consegna dopo un 503: torna confirmed con l'operatrice di default, mentre le righe AppointmentService restano su Giulia e l'agenda la sposta di colonna. Se era closed riappare aperta; la nota dello staff sparisce.

## [H5] Login senza org_id: un salone nuovo a ogni accesso — ALTO
- Dove: apps/integrations/login.py:101-133 vs api.py:114-116
- Cosa: il connect rifiuta un'identita senza organizzazione, il login no.
- Scenario: utente senza organizzazione: ogni accesso crea un salone nuovo e vuoto; il DB accumula saloni, location e settings fantasma.

## [H6] Dopo disconnect/riconnessione clienti e listino non si sincronizzano piu — ALTO
- Dove: apps/integrations/api.py:150-155, sync.py:139-141, 173-218
- Cosa: disconnect cancella YourangConnection ma non azzera Client.yourang_contact_id ne Service/Package.yourang_item_id.
- Scenario: ricollegando, ogni cliente viene saltato e ogni PUT catalogues/items/{id} risponde 404. Il listino non arriva mai nel catalogo nuovo, a nessuna esecuzione successiva.

## [H7] Webhook: 500 non autenticato su JSON che non e un oggetto — MEDIO
- Dove: apps/integrations/api.py:186-191. Il parse avviene PRIMA della verifica firma: rotta pubblica, corpo [] -> 500 ripetibile.

## [H8] hmac.compare_digest alza TypeError su firma non-ASCII -> 500 — MEDIO
- Dove: apps/integrations/api.py:177-180. Header X-Yourang-Signature con un byte >= 0x80 -> 500 invece di 401.

## [H9] Il servizio segnaposto "Prenotazione Yourang" finisce nel listino pubblico — MEDIO
- Dove: apps/integrations/sync.py:235-245. active=True di default, price=0, nella prima categoria. Visibile e prenotabile su /api/catalog/public/services e rispinto su Yourang a 0 EUR.

## [H10] Paginazione contatti senza tetto + sync completa dentro il webhook — MEDIO
- Dove: apps/integrations/sync.py:74-81, api.py:212-213. Ciclo infinito se il proxy ignora offset; ogni webhook contact.* fa la riconciliazione completa sincrona.

## [H11] Stato evento sconosciuto -> appuntamento "confermato" che occupa lo slot — MEDIO
- Dove: apps/integrations/sync.py:24-36, 285 (_EVENT_STATUS.get(status, CONFIRMED)).

## [H12] Prenotazioni senza telefono confluiscono su un unico cliente — MEDIO
- Dove: apps/integrations/sync.py:268-277. get_or_create(phone="") riusa sempre lo stesso record; il nome resta quello della prima cliente.

## [H13] Nessun unique su yourang_org_id e login senza controllo org gia presa — MEDIO
- Dove: apps/integrations/models.py:26, login.py:128-133 vs api.py:120-122. Eventi consegnati al salone sbagliato.

## [H14] e2e: fedelta verificata con "punti > 0" invece dell'incremento — MEDIO
- Dove: scripts/e2e_smoke.py:452-459. Su DB non resettato lo step resta verde anche se l'accredito smette di funzionare.

## [H15] e2e: OutboxEvent letti da uno sqlite che puo non essere il DB sotto test — MEDIO
- Dove: scripts/e2e_smoke.py:119-146, 602-603. Con seed_demo --reset gli id ripartono da 1: un vecchio slot.freed puo far passare lo step.

## [H16] Id remoti interpolati nel path senza codifica — BASSO
- Dove: apps/integrations/client.py:112-122. httpx normalizza i dot-segment: .../events/1/../../contacts diventa .../contacts.

## [H17] Gli errori della prima sync non arrivano mai al titolare — BASSO
- Dove: apps/integrations/api.py:131-139, login.py:134-138. report.errors scartato: la dashboard mostra "Connesso" mentre su Yourang non e arrivato nulla.
