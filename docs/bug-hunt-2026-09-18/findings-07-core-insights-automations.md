# Core / insight / automazioni — 3 alti, 7 medi, 5 bassi

## [F1] KPI "Nuovi clienti" strutturalmente sempre 0 — ALTO
- Dove: insights/services.py:346-352; campo clients/models.py:75
- Cosa: conta i Client con since nel periodo, ma since non viene MAI valorizzato: nessuno dei cinque punti di creazione lo scrive (clients/api.py:181 lo prende solo da ClientIn, clients/api.py:731 hook pubblico, accounts/api.py:480 registrazione app, integrations/sync.py:115, clients/services.py:220 import). Client non ha nemmeno un created_at.
- Scenario: 40 clienti nuovi nel mese -> new_clients: 0, e poiche returning = closed - new, il grafico "Nuovi vs di ritorno" mostra sempre 0% / 100%.

## [F2] Outbox: claimed_at con l'istante di inizio batch -> consegne duplicate — ALTO
- Dove: core/management/commands/flush_outbox.py:182-199, 164, 171-178
- Cosa: now calcolato una volta sola per tutti i 200 eventi del giro. L'evento preso in carico dopo 10 minuti risulta claimed 10 minuti fa, gia oltre STALE_CLAIM_SECONDS.
- Scenario: il job gira ogni minuto; Yourang lento (timeout 15s). Il giro successivo libera gli eventi ancora in volo e li rispedisce: la cliente riceve due volte lo stesso OTP o promemoria. Il docstring garantisce esplicitamente il contrario.

## [F3] Intervallo personalizzato senza tetto -> thread gunicorn bloccato — ALTO
- Dove: insights/services.py:78-86, 96-103
- Scenario: il selettore data non ha min/max anno. date_from=0202-01-01 -> 666.000 giorni, 4 chiamate in parallelo, 4 thread occupati per minuti. Con 0001/9999 sono 3,65 milioni di giorni: worker morto.

## [F4] PUT /settings: campi Optional a null e fuori range -> 500 — MEDIO
- Dove: core/api.py:96-97, 109-111
- Cosa: exclude_unset mantiene i null inviati esplicitamente. int(None) esplode, setattr scrive None su colonne NOT NULL. Nessun range o lunghezza.

## [F5] Location.is_default non esclusivo: la sede predefinita scelta viene ignorata — MEDIO
- Dove: core/api.py:160-175. Chi legge fa filter(is_default=True).first(), che ordina per pk: vince sempre la piu vecchia. Nessun modo di correggere dall'interfaccia.

## [F6] GET /api/automations/ senza require_scope: i webhook_token a tutto lo staff — MEDIO
- Dove: automations/api.py:83-86
- Scenario: un'operatrice con solo scope agenda legge tutti i token. POST /api/automations/hook/<token> non ha autenticazione e il token non si rigenera mai: puo far partire sequenze di messaggi anche dopo la revoca dell'accesso.

## [F7] Sollecito caparra oltre la scadenza abbassando solo deposit_hold_minutes — MEDIO
- Dove: core/api.py:99-104. L'invariante e verificata solo se reminder e nel payload.
- Scenario: hold 120 reminder 60; si porta hold a 30 -> il sollecito non parte piu, la cliente perde lo slot senza avviso, e in Impostazioni il valore mostrato resta 60.

## [F8] Feed live: eventi persi per la corsa fra id di sequenza e commit — MEDIO
- Dove: core/views.py:107-118, core/api.py:280-288
- Scenario: una chiusura conto in transazione prende id 1000 e committa dopo; un settings.updated fuori transazione prende 1001 e committa subito. Il cursore va a 1001 e l'evento 1000 non arriva mai a nessuna dashboard.

## [F9] Automazioni: event/offset/trigger_origin non validati; interi e nome senza limiti — MEDIO
- Dove: automations/api.py:92, 108-110
- Scenario: event="birtday" salvato e spedito a Yourang: il titolare vede la regola attiva e non parte mai un messaggio. offset_value=-2 -> 500.

## [F10] Upload logo senza controllo tipo e dimensione — MEDIO
- Dove: core/api.py:128-137 (stesso di S2). branding/ non e fra i PRIVATE_PREFIXES: il file e servito a chiunque sull'origin dell'API.

## [F11] rebooking_rate misurato sempre su "oggi": confronto col periodo precedente distorto — MEDIO
- Dove: insights/services.py:335-344. La freccia di variazione mostra sempre un miglioramento inventato, a comportamento identico.

## [F12] normalize_opening_hours_week accetta orari fino a 24:59 — BASSO
- Dove: core/services.py:70-76. "24:00-24:30" salvato: il salone risulta chiuso ma le Impostazioni mostrano una fascia valida.

## [F13] log_activity non tronca actor_name e summary -> 500 — BASSO
- Dove: core/services.py:22. Un nome di 130 caratteri fa fallire OGNI azione registrata da quell'utente, perche log_activity sta dentro la transazione dell'operazione.

## [F14] "Clienti per categoria" ignora il periodo selezionato — BASSO
- Dove: insights/services.py:356-363. Una COUNT per categoria, sull'anagrafica intera.

## [F15] privacy_policy_url senza validazione, reso come href nell'app pubblica — BASSO
- Dove: core/api.py:109-111, 368.

## Verificati e scartati
- activity_feed: logica del cursore corretta oltre il limite; unico problema la corsa di F8.
- _safe_div/_safe_pct/_safe_avg_money degradano a 0; nessun KPI supera 1/100.
- Trunc* ricevono il fuso corrente e i bucket coincidono col database; period_range corretto a cavallo d'anno.
- Isolamento multi-salone: corretto in insights, core e automations.
- ratelimit.hit atomico, gestisce la corsa di creazione della finestra.
- _teardown di seed_demo rispetta l'ordine delle FK PROTECT.
- compute_deposit limita l'importo a [0, totale].
- Lo slot SSE viene rilasciato anche se il generatore non parte.
- healthz non tocca il database ed e esente da SECURE_SSL_REDIRECT.
