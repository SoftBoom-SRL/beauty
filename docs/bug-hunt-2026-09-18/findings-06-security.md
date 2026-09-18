# Sicurezza / autenticazione — 2 alti, 5 medi, 7 bassi

## [S1] Default fail-open: DEBUG=1, ALLOWED_HOSTS=*, SECRET_KEY nota che firma i JWT — ALTO
- Dove: config/settings.py:12-14, 198; entrypoint.sh (nessun controllo)
- Cosa: SECRET_KEY default "dev-insecure-change-me", DEBUG=1 se manca, ALLOWED_HOSTS=*, JWT_SECRET ripiega su SECRET_KEY. Nessun punto del boot verifica che in produzione siano stati sostituiti: l'app parte e l'healthcheck risponde ok.
- Scenario: una env si perde su Coolify -> DEBUG=1, CORS_ALLOW_ALL_ORIGINS=True, JWT_SECRET pubblico. Chiunque conosca il repository forgia un token staff firmato HS256 e passa come titolare di qualunque salone. Anche i link media sono firmati con la stessa chiave.
- Fix: ImproperlyConfigured al boot se non DEBUG e i valori sono quelli di default; invertire i default.

## [S2] Upload senza controllo estensione + /media/ serve HTML sull'origin dell'API — ALTO
- Dove: common/media.py:68-80, core/api.py:129-134, clients/api.py:441-446, 624-636
- Cosa: la validazione guarda solo il Content-Type dichiarato dal client (falsificabile), mai l'estensione; il logo salone non ha alcuna validazione. serve_media delega a django.views.static.serve, che deduce il tipo dall'estensione e non imposta Content-Disposition.
- Scenario: si carica evil.html come image/png su /api/core/settings/logo; finisce in branding/, che non e fra i PRIVATE_PREFIXES, quindi scaricabile senza token. La pagina esegue JS nell'origin dell'API, dove vive anche /admin/: un amministratore che apre il link consegna la sessione superuser. Il logo non ha nemmeno un limite di dimensione.
- Fix: whitelist di estensioni oltre al MIME, nome file generato dal server, Content-Disposition attachment.

## [S3] Il cambio password dall'admin Django non invalida i JWT gia emessi — MEDIO
- Dove: accounts/admin.py:20-42, models.py:51
- Cosa: token_version e incrementato solo dall'endpoint di cambio password volontario. Il form dell'admin chiama set_password senza toccarlo.
- Scenario: account compromesso, l'amministratore cambia la password dall'admin. L'attaccante usa il refresh (30 giorni) e ne ottiene uno nuovo ogni volta: resta dentro a tempo indeterminato.

## [S4] request-otp: enumerazione illimitata dei numeri e invio WhatsApp senza tetto per IP — MEDIO
- Dove: accounts/api.py:508-513, 107-112, services.py:56-84
- Cosa: risponde 404 per i numeri sconosciuti e 200 per quelli in anagrafica, senza alcun limite per IP ne per salone (client_register invece ce l'ha).
- Scenario: uno script cicla i numeri e ricava l'intera rubrica clienti del salone. Sui numeri validi fa partire 5 WhatsApp ogni 15 minuti a spese del salone e satura i 3 OTP attivi impedendo il login legittimo.
- Fix: rispondere sempre 200 e applicare i contatori per IP e per salone prima della ricerca.

## [S5] Lo scope team permette di auto-assegnarsi tutti gli altri permessi — MEDIO
- Dove: accounts/api.py:255-271, 303-339. require_owner non e usato in tutto il file.
- Scenario: al responsabile del personale viene dato il solo scope team. Crea un ruolo con tutti e nove gli scope e se lo assegna: al refresh ha incassi, listino, magazzino e analisi che il titolare gli aveva negato. Puo anche rimuovere dal team tutti i colleghi non titolari.

## [S6] Lo stream SSE consegna il registro attivita senza lo scope activity_log — MEDIO
- Dove: config/urls.py:23, core/api.py:340-346, core/views.py
- Cosa: GET /api/core/activity richiede lo scope, mentre il ticket per lo stream e emesso a qualunque membro autenticato e la vista controlla solo il ticket.
- Scenario: un'operatrice con scope agenda e clients apre lo stream e riceve in tempo reale sale.*, giftcard.*, loyalty.*, stock.*, order.*, settings.*: esattamente i dati che il permesso le nega.

## [S7] Refresh staff: sessione scorrevole infinita, nessuna revoca, token in localStorage — MEDIO
- Dove: accounts/api.py:172-191, common/auth.py:42-54, staffAuth.js:9-27
- Cosa: il refresh conia un nuovo token con TTL pieno senza invalidare il precedente, senza rate limit e senza lista di revoca. Non esiste logout lato server.
- Scenario: un refresh esfiltrato vale per sempre. Il titolare che "disconnette" il dispositivo smarrito non ottiene nulla; resta il cambio password, che pero non funziona (S3).

## [S8] Token cliente da 30 giorni, non revocabile — BASSO
- Dove: common/auth.py:57-63, 115-129. Access token con TTL di refresh, senza claim di versione.

## [S9] client_ip si fida ciecamente di X-Forwarded-For — BASSO
- Dove: common/ratelimit.py:30-41. Se il container e raggiungibile direttamente, i tetti su login e registrazioni spariscono; con due proxy tutti finiscono nello stesso secchiello e 50 tentativi bloccano l'intero salone.

## [S10] Enumerazione account staff dal tempo di risposta del login — BASSO
- Dove: accounts/api.py:161-163. Manca l'hash fittizio quando l'utente non esiste.

## [S11] Email non validata -> chiave rate limit oltre 200 char -> 500 — BASSO
- Dove: accounts/api.py:150-157, core/models.py:202. DataError non catturata (ratelimit.py:54-60).

## [S12] CORS_ALLOWED_ORIGIN_REGEXES non ancorato (re.match) — BASSO
- Dove: config/settings.py:188-195. Senza $ finale, beauty.yourang.ai.attaccante.it e autorizzato.

## [S13] Documentazione OpenAPI pubblica in produzione — BASSO
- Dove: config/api.py:8. /api/docs e /api/openapi.json senza auth, indipendentemente da DEBUG.

## [S14] Controllo dei prefissi riservati di /media/ case-sensitive — BASSO
- Dove: common/media.py:18, 36-37, 76. Su volume case-insensitive /media/Client_notes/... salta la firma. Su ext4 in produzione non sfruttabile.

## Verificati e scartati
- decode_token fissa HS256 e verifica exp; typ impedisce di usare un access come refresh o un token cliente su rotte staff.
- canonical_path normalizza prima di decidere: .., ., backslash e percent-encoding non aggirano la firma.
- salon_get applicato a membership, ruoli e inviti: nessun attraversamento fra saloni.
- Tetto di verifica OTP per cliente indipendente dal numero di codici emessi: forza bruta non praticabile.
- common/conditions.py non valuta espressioni arbitrarie.
- Gli handler message del frontend controllano e.origin.
- Nessuna chiamata in uscita con URL controllabili: SSRF non applicabile.

## Segnalazione fuori ambito
- POST /api/integrations/yourang/oauth/exchange (integrations/api.py:84) non ha state ne binding di sessione e in mode=login conia una sessione staff.
