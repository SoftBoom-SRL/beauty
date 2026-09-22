# Revisore 10 — Sicurezza, autenticazione e permessi

Perimetro: `backend/apps/accounts/`, `backend/common/` (auth, permissions, ratelimit, media, utils),
`backend/config/`, ticket/stream SSE in `core/views.py`+`core/api.py`, login Yourang in
`integrations/login.py`, più scansione trasversale di tutti i router `apps/*/api.py` (auth/salone/scope,
IDOR fra saloni, dati della cliente all'app cliente). Tabella endpoint in fondo.

I probe di conferma stavano in `backend/apps/accounts/tests_probe_sicurezza10.py` (12+3 test, tutti verdi),
ora CANCELLATO.

---

### [ALTO] 10-01 Lo scope «team» scala a qualunque ruolo tramite gli inviti in attesa
- File: `backend/apps/accounts/api.py:503-508` (`list_invitations`), `543-589` (`accept_invitation`), `510-540`
- Stato: CONFERMATO (probe `InvitationEscalationProbe.test_team_user_takes_over_pending_invitation_of_more_powerful_role`).
- Difetto: la passata di settembre ha chiuso l'auto-promozione diretta (`_require_grantable` su create_role,
  set_member_role, create_invitation), ma `list_invitations` restituisce a chiunque abbia lo scope `team`
  TUTTI gli inviti in attesa del salone, **token compreso** (`InvitationOut.token`). `accept_invitation` è
  pubblico e non verifica chi accetta: chiunque abbia il token crea l'account con la password che vuole e
  ottiene il ruolo dell'invito. Il controllo `_require_grantable` non è mai applicato in accettazione.
- Scenario: al front-desk/responsabile personale si dà il solo scope `team` (gestire il personale) senza
  cassa/magazzino. Il titolare crea un invito «Manager» (tutti gli scope) per una nuova assunta. Il
  front-desk apre `GET /auth/invitations`, copia il token, chiama `POST /auth/invitations/accept` con
  quel token e una propria password: nasce un account Manager che controlla lui. Con quella sessione legge
  `GET /api/sales/` (che al suo ruolo dà 403), incassi, listino, magazzino, analisi. È lo stesso buco S5
  della caccia precedente, riaperto da un'altra porta.
- Correzione: non esporre `token` in `list_invitations` (mostralo solo a chi può concedere quel ruolo, o mai);
  e/o in `accept_invitation` non consentire l'accettazione a una sessione staff già membro del salone / far
  scadere il token dopo l'uso. Il token dovrebbe raggiungere solo il destinatario dell'invito.

### [ALTO] 10-05 «team» può azzerare il ruolo di un collega più potente (revoca di permessi altrui)
- File: `backend/apps/accounts/api.py:383-408` (`set_member_role`)
- Stato: CONFERMATO (probe `InvitationEscalationProbe.test_team_user_strips_role_of_more_powerful_colleague`).
- Difetto: `set_member_role` applica `_require_grantable` solo sul ruolo NUOVO che si assegna (righe 396-397),
  mai sul ruolo ATTUALE del bersaglio. `remove_member` invece chiama `_require_can_touch_role` (righe 420-421)
  proprio per impedire a chi ha solo `team` di intaccare colleghi più potenti. La stessa guardia manca nel
  cambio ruolo: chi ha `team` può portare a «nessun ruolo» (o a un ruolo depotenziato) la Manager, la
  responsabile magazzino, ecc., togliendo al salone accessi che non era autorizzato a concedere.
- Scenario: il front-desk (solo `team`) chiama `POST /auth/members/{id}/role` con `role_id=null` sulla
  Manager: passa (200) e la collega perde cassa/listino/magazzino al successivo refresh. Rimuoverla dal team
  è invece vietato (403), quindi la difesa esiste già ed è solo incoerente.
- Correzione: in `set_member_role`, quando `not ctx.is_owner`, chiamare `_require_can_touch_role(ctx, membership.role)`
  sul ruolo attuale del bersaglio (come fa `remove_member`), oltre a `_require_grantable` sul nuovo.

### [MEDIO] 10-03 Il login «Accedi con Yourang» collega il salone all'org di un membro qualunque
- File: `backend/apps/integrations/login.py:82-98` (`_resolve_salon`, ramo B), `116-147` (`login_with_link_code`)
- Stato: CONFERMATO (probe `YourangLoginProbe.test_non_owner_links_salon_to_her_own_org`).
- Difetto: il «connect» dalle Impostazioni è riservato al titolare (`oauth_start`/`oauth_exchange` mode=connect →
  `require_owner`). Il «login con Yourang» no: se il salone non ha ancora una `YourangConnection`, un membro
  qualunque che accede con la propria identità Yourang fa scrivere `conn.yourang_org_id = <sua org>` e
  `connected_by = <lui>` (login.py:142-147), instradando su quell'org tutti i webhook e la sync del salone.
  Non c'è nessun controllo di ruolo su questo lato.
- Scenario: un'operatrice con solo scope `agenda`, membro del salone «The Parlour» (di proprietà di un altro),
  entra da `/oauth-popup/start?mode=login` con la sua org Yourang. Il salone risulta «Connesso» alla sua org:
  i contatti/eventi del salone finiscono verso un'organizzazione che controlla lei, e diventa `connected_by`.
  Se invece il salone ha già una connessione, il ramo B viene saltato e le viene provisionato un salone nuovo
  (nessun danno) — quindi il buco colpisce il caso comune del salone non ancora collegato.
- Correzione: il primo collegamento di un'org a un salone esistente dovrebbe richiedere il titolare (o essere
  consentito solo se `membership.is_owner`); un membro non titolare che accede via Yourang entra come membro
  ma non deve poter (ri)definire la `YourangConnection` del salone.

### [MEDIO] 10-06 Codici gift card e coupon (strumenti al portatore) leggibili da tutto lo staff
- File: `backend/apps/marketing/api.py:214-271` (`list_gift_cards`), `82-104` (`list_coupons`)
- Stato: CONFERMATO (probe `ReadScopeProbe.test_gift_card_codes_to_operatrice`).
- Difetto: entrambe le letture hanno solo `staff_auth`, nessun `require_scope("marketing")` né `sales`.
  `GiftCardOut.code` e `CouponOut.code` sono segreti al portatore: chi conosce il codice può riscattarlo in
  cassa. Un'operatrice con il solo scope `agenda`/`clients` sfoglia tutti i codici gift card attivi e pagati
  del salone (e il loro saldo). È incoerente con il principio applicato altrove, dove i dati di cassa sono
  nascosti senza `sales` (`get_client.stats_hidden`, `sale_detail`, lista vendite).
- Scenario: operatrice senza `marketing`/`sales` apre `GET /api/marketing/gift-cards`, annota codice e saldo
  di una carta da 100 €, e (se ha accesso alla cassa o si fa aiutare) la spende su una vendita. Anche solo la
  fuga dei codici a chi lascia il salone resta un problema (i codici non si rigenerano).
- Correzione: mascherare `code` (o richiedere `marketing`/`sales`) su queste letture per chi non ha il permesso,
  come si è già fatto con i `webhook_token` delle automazioni (`_mask_secrets`).

### [MEDIO] 10-09 Dati di cassa/HR (costo orario, incassi per operatrice, spesa cliente, fatture) senza il permesso «sales»
- File: `backend/apps/staff/api.py:214-237` (`list_operators` → `hourly_cost`, `month_revenue`),
  `439-442` (`get_performance`), `445-448` (`get_served_clients` → `total_spent`);
  `backend/apps/inventory/api.py:363-386` (`list_movements`/`list_product_movements` → `invoice_url` firmato);
  `backend/apps/agenda/api.py:610-617` (`list_released` senza `require_scope("agenda")`)
- Stato: CONFERMATO (probe `ReadScopeProbe.test_cash_data_without_sales_scope`, `test_released_without_agenda_scope`).
- Difetto: queste letture hanno solo `staff_auth`. `list_operators` espone il costo orario (dato salariale) e
  l'incasso mensile per operatrice; `get_performance` la serie ricavi mensile; `get_served_clients` lo speso
  per cliente; i movimenti magazzino espongono l'URL firmato della fattura fornitore. Il progetto altrove
  nasconde esattamente questi dati senza `sales` (`get_client` mette `stats_hidden`, la lista/dettaglio
  vendite chiede `sales`). `list_released` inoltre non chiede `agenda` mentre `day/week/range` sì: un ruolo
  senza `agenda` legge comunque gli appuntamenti liberati (nome, telefono, caparra) da `GET /agenda/released`.
- Scenario: un ruolo con solo `inventory` apre `GET /api/staff/` e vede lo stipendio orario di ogni collega e
  l'incasso mensile di ognuna; `GET /api/staff/{id}/clients` gli dà lo speso di ogni cliente; `GET
  /api/agenda/released` gli dà gli appuntamenti persi con i recapiti — tutti dati che i permessi d'area gli
  negano dalle vie principali.
- Correzione: nascondere `hourly_cost`/`month_revenue`/`total_spent`/`invoice_url` quando manca `sales`
  (o `is_owner`), come per `get_client`; aggiungere `require_scope(ctx, "agenda")` a `list_released`.

### [MEDIO] 10-10 Le note interne dello staff finiscono alla cliente quando sposta o annulla dall'app
- File: `backend/apps/agenda/api.py:1127-1148` (`client_move_appointment`, `client_cancel_appointment` →
  `_appointment_out`), `186-215` (`_appointment_out` include `note`)
- Stato: CONFERMATO (probe `ClientMoveNoteLeakProbe.test_client_cancel_returns_staff_note`).
- Difetto: la lista degli appuntamenti della cliente usa `_client_appointment_out`, che NON include `note`.
  Ma `client_move_appointment` e `client_cancel_appointment` rispondono con `_appointment_out` (il
  serializzatore staff), che include `appointment.note` — il campo dove lo staff scrive annotazioni interne
  sull'appuntamento (l'agenda lo mostra come riquadro di avviso «allergia alla tinta», ma è testo libero).
- Scenario: lo staff crea un appuntamento con nota interna «cliente insolvente, non fare sconti». La cliente,
  dall'app, sposta o annulla quell'appuntamento (`POST /agenda/client/appointments/{id}/move|cancel`) e nella
  risposta JSON riceve `note` con quel testo. Espone alla cliente annotazioni riservate del salone.
- Correzione: far rispondere gli endpoint cliente con `_client_appointment_out` (che non porta `note`), non con
  `_appointment_out`.

### [BASSO] 10-04 I tetti «per salone» di OTP e registrazione bloccano l'accesso di tutte le clienti del salone
- File: `backend/apps/accounts/api.py:664-701` (`client_request_otp`, `OTP_MAX_PER_SALON=60`), `596-657`
  (`client_register`, `REGISTER_MAX_PER_SALON=60`)
- Stato: CONFERMATO (probe `OtpSalonCapProbe.test_three_addresses_block_every_client_login`).
- Difetto: il tetto per salone su `request-otp` è condiviso fra tutti i numeri e tutti gli IP. Riempirlo (60
  richieste/15 min, raggiungibili da 3 IP a 20 ciascuno) fa rispondere 429 a QUALUNQUE cliente legittima che
  provi ad accedere, per finestre scorrevoli di 15 minuti — anche da casa sua e con il suo numero. Idem per
  `register-salon` (60/ora): blocca l'onboarding di nuove clienti. I tetti sono voluti (anti-enumerazione,
  audit S4), ma la protezione è weaponizzabile in DoS mirato sull'accesso clienti di un salone.
- Scenario: uno script cicla numeri finti da poche reti verso `/api/auth/client/request-otp?salon_slug=...`;
  saturato il secchiello del salone, per 15 minuti nessuna cliente riceve il codice e non entra nell'app.
- Correzione: alzare/riparametrare il tetto per salone o renderlo un semplice segnale di allarme anziché un
  blocco duro (il tetto per IP + per cliente già limita spam ed enumerazione); valutare un tetto per salone
  molto più alto o basato su una media mobile.

### [BASSO] 10-11 Il logout non revoca i refresh «legacy» senza jti, che restano riusabili
- File: `backend/apps/accounts/api.py:259-263` (`staff_refresh`, ramo senza jti), `266-287` (`staff_logout`),
  `295-327` (`staff_change_password`)
- Stato: CONFERMATO (probe `LegacyRefreshProbe.test_refresh_without_jti_is_reusable_and_survives_logout`).
- Difetto: i refresh emessi prima della rotazione non hanno `jti`; `staff_refresh` li accetta e conia token
  nuovi senza revocarli, quindi restano riusabili più volte. Logout e cambio password revocano solo le righe
  `StaffRefreshToken`, che per un token legacy non esistono: un refresh legacy esfiltrato sopravvive a logout
  e cambio password fino alla sua scadenza naturale (fino a 30 giorni dal deploy della rotazione). Il
  `token_version` copre l'access ma i refresh legacy passano comunque il controllo `tv` se `tv` combacia.
- Scenario: refresh legacy rubato prima del 18/09; il titolare fa logout / cambia password credendo di aver
  chiuso tutto, ma quel refresh continua a rigenerare access token per settimane.
- Correzione: transitorio (si esaurisce da sé entro ~30 giorni dal deploy della rotazione). Se si vuole
  chiuderlo subito: rifiutare i refresh senza `jti` una volta passata la finestra di migrazione, o bumpare
  `token_version` di tutti gli utenti al deploy.

### [BASSO] 10-12 Il ticket dello stream SSE resta valido dopo rimozione/cambio password (fino a 10 min)
- File: `backend/apps/core/views.py:121-139` (`issue_stream_ticket`, TTL 600s), `202-235` (`activity_stream`)
- Stato: CONFERMATO (probe `StreamTicketProbe.test_ticket_survives_removal`).
- Difetto: il ticket è una riga di cache con salon/scopes, indipendente dalla vita della membership o dal
  `token_version`. `activity_stream` controlla solo l'esistenza del ticket. Un membro rimosso (o con password
  cambiata) i cui token API vengono già rifiutati (401 su `/auth/me`) può comunque aprire lo stream con un
  ticket ottenuto poco prima e ricevere per ~10 minuti gli eventi live delle sue aree.
- Scenario: si licenzia un'operatrice; lei aveva appena chiesto un `stream-ticket`. Rimossa dal team, continua
  a leggere il feed attività del salone finché il ticket non scade.
- Correzione: legare il ticket a `user_id`+`token_version` e, all'apertura dello stream, verificare che la
  membership sia ancora attiva e il `tv` coincida (una query sola, come già fa `StaffAuth`).

### [BASSO] 10-13 `POST /auth/staff/password` senza tetto sui tentativi: brute force della password attuale
- File: `backend/apps/accounts/api.py:295-327` (`staff_change_password`)
- Stato: CONFERMATO (probe `ChangePasswordOracleProbe.test_current_password_guessing_is_unlimited`).
- Difetto: il login staff ha un doppio tetto (per account e per IP), l'endpoint di cambio password no.
  Richiede `current_password`, ma nessun rate limit: chi possiede un access token valido (stateless, fino a
  60 min) ma non conosce la password può provarla all'infinito qui, ottenendo un oracolo che il login nega.
- Scenario: access token rubato (finestra 60 min). L'attaccante non può usare il login (throttled) ma
  martella `/auth/staff/password` per indovinare la password attuale — utile perché la password consente
  l'accesso all'admin Django e sopravvive alla scadenza del token.
- Correzione: applicare `ratelimit.hit` per utente (e per IP) ai tentativi con `current_password` errata,
  come sul login.

### [BASSO] 10-14 `client/register`: la corsa sul doppio invio esce come 500 invece del 400
- File: `backend/apps/accounts/api.py:602-657` (`client_register`)
- Stato: CONFERMATO (probe `RegisterDoubleSubmitProbe.test_register_integrity_error_is_not_handled` → `IntegrityError`).
- Difetto: `client_register` fa `find_client_by_phone` e poi `Client.objects.create` senza catturare
  `IntegrityError`. Il controllo non è atomico e il vincolo unico `(salon, phone_key)` esiste: due richieste
  simultanee con lo stesso numero (doppio tap su «Registrati», o retry di rete) fanno passare entrambe il
  controllo e la seconda muore con 500. `create_client` e `public_hook` gestiscono già questo caso con
  `try/except IntegrityError`; qui manca.
- Scenario: la cliente tocca due volte «Registrati» su una rete lenta: una richiesta crea la scheda, l'altra
  restituisce 500 (e, essendo dopo `emit_event`/`issue_otp`, può lasciare stato incoerente).
- Correzione: avvolgere la create in `try/except IntegrityError` e rispondere 400 «Numero già registrato»,
  come negli altri due punti.

### [BASSO] 10-15 `public/hook`: riattiva schede cliente disattivate senza autenticazione
- File: `backend/apps/clients/api.py:794-921` (`public_hook`, righe 906-916 `revived`)
- Stato: PLAUSIBILE (percorso ripercorso; è una scelta esplicita ma con effetto collaterale sulla sicurezza dei dati).
- Difetto: il form pubblico anonimo, dato nome+telefono, se trova una scheda `is_active=False` la RIATTIVA
  (`client.is_active = True`) e ne aggiorna i consensi. `delete_client` è una disattivazione (soft delete):
  una cliente che il salone ha volutamente rimosso (o un contatto revocato GDPR) può essere reimmesso in
  rubrica e nelle audience marketing da chiunque conosca nome e numero, senza autenticazione.
- Scenario: il salone disattiva una cliente problematica; qualcuno compila il form pubblico con quel nome e
  numero e la scheda torna attiva con consenso marketing «fresco». È il rovescio del fix D11 della caccia
  precedente (che voleva non perdere i lead): riattiva anche chi era stato tolto di proposito.
- Correzione: non riattivare da endpoint pubblico una scheda disattivata dallo staff (o marcarla come «lead da
  rivedere» senza rimetterla nelle liste finché lo staff non conferma).

### [BASSO] 10-16 Upload fattura magazzino: validazione debole, conserva nome/estensione del client
- File: `backend/apps/inventory/api.py:109-112` (`_validate_invoice`), `222-249` (`load_product`),
  `backend/apps/inventory/services.py:27-62` (`apply_movement`, `invoice=invoice`)
- Stato: CONFERMATO (probe `InvoiceUploadProbe.test_invoice_keeps_client_extension` → file salvato come `.html`).
- Difetto: a differenza di logo/note/foto schede (che usano `common.media.stored_upload_name`: tipo dichiarato
  in whitelist, estensione coerente, nome generato dal server), l'upload fattura controlla solo il
  Content-Type dichiarato (falsificabile) e la dimensione, e salva il file con il NOME e l'ESTENSIONE scelti
  dal client. Un `fattura.html` dichiarato `application/pdf` finisce su disco come `.html`. Il danno è
  contenuto perché `inventory/invoices/` è prefisso riservato (`serve_media` richiede il token firmato,
  aggiunge `X-Content-Type-Options: nosniff` e `Content-Disposition: attachment` per le non-immagini —
  verificato nel probe), quindi non esegue inline. Resta l'incoerenza con la regola unica di `common.media`
  e il nome-file arbitrario su disco (doppie estensioni, collisioni).
- Correzione: usare `stored_upload_name(invoice, allowed_types=INVOICE_TYPES, max_bytes=INVOICE_MAX_BYTES)` e
  salvare quel nome, come fanno gli altri upload.

### [BASSO] 10-02 `oauth/exchange` (connect) senza `state`/CSRF: login-CSRF sul collegamento Yourang
- File: `backend/apps/integrations/api.py:94-155` (`oauth_exchange`, ramo connect)
- Stato: PLAUSIBILE (già segnalato come «fuori ambito» nella caccia precedente; qui solo il lato auth).
- Difetto: `oauth_exchange` non ha `state` né binding di sessione con la richiesta di avvio (PKCE/state vivono
  nel proxy). Il ramo connect richiede sessione titolare, ma un `code` è un parametro che l'attaccante può
  scegliere: indurre il titolare loggato a inviare un `exchange` con un `code` dell'attaccante collega l'org
  dell'attaccante al salone del titolare (il webhook risolve il salone dall'org → dati del salone verso
  un'org esterna). Serve interazione del titolare, quindi impatto limitato.
- Correzione: introdurre uno `state` firmato legato alla sessione che avvia il flusso e verificarlo in
  exchange (anche solo per il ramo connect).

---

## Aree controllate senza reperti (verificate corrette)

- `common/auth.py`: `decode_token` fissa `HS256` e verifica `exp`; `typ` separa staff/staff_refresh/client
  (un access non vale come refresh, un token cliente non entra su rotte staff). `StaffAuth` filtra su
  `user__is_active` e confronta `token_version` (cambio password → 401). `ClientAuth` filtra su `is_active`
  (disattivare la scheda invalida subito il token). Token cliente con durata propria (`JWT_CLIENT_TTL_DAYS`).
  PyJWT 2.14 rifiuta la chiave vuota (`InvalidKeyError`) → JWT_SECRET vuota non firma nulla.
- Token cliente e slug: `ClientAuth` porta `salon = client.salon`; gli endpoint app cliente filtrano sempre su
  `ctx.client`/`ctx.salon` (`salon_get(..., client=ctx.client)`), lo slug non entra dopo il login → un token
  cliente non opera su un altro salone.
- OTP: `verify_otp` ha tetto per cliente indipendente dal numero di codici (`otp-verify:{id}`), soglia
  tentativi per codice, scadenza 10 min, `used` monouso; `verify-otp` ha tetto per IP; il 404/200 uniforme di
  `request-otp` è VOLUTO (registrazione nuove clienti, vedi INTEGRATION_NOTES) — non segnalato.
- `common/media.py`: `canonical_path` normalizza prima di decidere (`..`, `.`, backslash, percent-encoding non
  aggirano la firma); `verify_media_token` copre percorso+scadenza (4h); `is_private` case-insensitive;
  `serve_media` mette `nosniff` e `Content-Disposition: attachment` per le non-immagini; upload logo/note/foto
  usano `stored_upload_name` (whitelist tipo+estensione, nome generato). SVG escluso dal logo.
- `common/ratelimit.py`: `client_ip` legge l'ULTIMO elemento di X-Forwarded-For solo da peer fidato
  (`_is_trusted_peer`), reti di documentazione escluse; `hit` è `UPDATE count+1` atomica con scadenza propria.
- `common/permissions.py`: `require_scope`/`require_owner` corretti; titolare bypassa; la doppia mappa scope
  del feed live è stata eliminata (`allowed_prefixes` unica fonte, riusata da SSE e polling).
- `config/settings.py`: fail-closed in produzione (SECRET_KEY placeholder/<32, ALLOWED_HOSTS aperto,
  DATABASE_URL assente → ImproperlyConfigured); cookie Secure/HttpOnly/SameSite; CORS regex ancorate con `$`;
  `/api/docs` spente senza DEBUG salvo `API_DOCS=1`. `admin/` esposto ma protetto da auth Django + CSRF;
  nota: il login admin (`/admin/login/`) NON ha rate limit applicativo (Django non lo fornisce di suo) —
  fuori dal perimetro Ninja, ma vale ricordarlo per il deploy.
- Stripe: webhook con firma obbligatoria (503 senza secret); `_payment_intent_succeeded`/`setup_intent`
  filtrano per `salon_id` nei metadata e confrontano `event["account"]` con l'account del salone
  (`_account_recognised`, token firmato `account_token`); connect con `state` firmato e legato al salone.
- Yourang webhook: firma HMAC verificata PRIMA di toccare il DB; org non fidata finché non verificata;
  `compare_digest` protetto da header non-ASCII; `event.deleted`/`event` richiedono `entity_id` (niente
  cancellazione di massa dell'agenda).
- IDOR fra saloni: tutte le scritture e le letture per-id passano da `salon_get(..., ctx)` o
  `filter(salon=ctx.salon)`; `_validate_references` (vendite), `_resolve_user` (staff), `_get_client`
  (marketing), `_sync_package_items`/`create_service` (catalog) verificano che gli id annidati nel body siano
  del salone del chiamante. `finalize_sale` valida servizi/prodotti/operatrici. Nessun `__in` non filtrato per
  salone trovato sfruttabile fra tenant.
- App cliente: gli endpoint `client/*` restituiscono solo dati della cliente (wallet filtra su
  buyer/recipient=ctx.client; gift card altrui invisibili; appuntamenti/waitlist filtrati su ctx.client).
- Log: `emit_event` logga solo tipo e id; `flush_outbox` oscura `code/otp/token` alla consegna e cancella i
  consegnati dopo 30 giorni; l'OTP in chiaro nel log è solo sotto `DEBUG`.

---

## Tabella endpoint → auth / salone / scope

Generata dal sorgente (201 rotte). Auth: `staff`=JWT staff, `cliente`=JWT cliente, `pubblico`=nessuna.
Scope = `require_scope`/`require_owner` risolti anche negli helper chiamati. «Salone» = come si delimita il
tenant. Le righe con nota richiamano un reperto.

| Endpoint | Auth | Salone | Scope | Note |
|---|---|---|---|---|
| POST /auth/staff/login | pubblico | email → prima membership | — |  |
| POST /auth/staff/refresh | pubblico | claim salon + membership | — | refresh senza jti riusabili (10-11) |
| POST /auth/staff/logout | staff | ctx.salon | — |  |
| GET /auth/me | staff | ctx.salon | — |  |
| POST /auth/staff/password | staff | ctx.salon | — | nessun tetto tentativi (10-13) |
| GET /auth/members | staff | ctx.salon | team |  |
| POST /auth/members/{id}/role | staff | salon_get | team | non controlla il ruolo attuale del bersaglio (10-05) |
| DELETE /auth/members/{id} | staff | salon_get | team | (guarda il ruolo del bersaglio, corretto) |
| GET /auth/roles | staff | ctx.salon | team |  |
| POST /auth/roles | staff | ctx.salon | team | _require_grantable |
| PUT /auth/roles/{id} | staff | salon_get | team | _require_grantable |
| DELETE /auth/roles/{id} | staff | salon_get | team |  |
| GET /auth/invitations | staff | ctx.salon | team | espone i token degli inviti (10-01) |
| POST /auth/invitations | staff | salon_get | team | _require_grantable |
| POST /auth/invitations/accept | pubblico | token invito | — | nessun controllo su chi accetta (10-01) |
| POST /auth/client/register | pubblico | slug | — | tetto salone (10-04); IntegrityError non gestita (10-14) |
| POST /auth/client/request-otp | pubblico | slug | — | tetto salone (10-04); 404/200 uniforme VOLUTO |
| POST /auth/client/verify-otp | pubblico | slug | — | tetto per IP + per cliente |
| GET/PUT /auth/client/me | cliente | ctx.client | — |  |
| GET /core/salon | staff | ctx.salon | — |  |
| PUT /core/settings, POST/DELETE /core/settings/logo | staff | ctx.salon | titolare |  |
| GET /core/locations | staff | ctx.salon | — |  |
| POST/PUT/DELETE /core/locations… | staff | salon_get | titolare |  |
| GET/POST/PUT/DELETE /core/deposit-rules… | staff | salon_get | titolare |  |
| GET /core/activity | staff | ctx.salon | activity_log |  |
| GET /core/activity/feed | staff | ctx.salon | — | filtrato per prefisso/scope |
| GET /core/outbox/status | staff | ctx.salon | titolare |  |
| POST /core/activity/stream-ticket | staff | ctx.salon | — | biglietto non revocato (10-12) |
| GET /api/core/activity/stream (Django) | ticket | salon nel ticket | scopes nel ticket | non rilegge la membership (10-12) |
| GET /core/public/branding | pubblico | slug | — |  |
| GET /clients/categories | staff | ctx.salon | — |  |
| POST/PUT/DELETE /clients/categories… | staff | salon_get | clients |  |
| GET /clients/ | staff | ctx.salon | — | (stripe id non più in output) |
| POST /clients/ | staff | ctx.salon | clients |  |
| GET /clients/{id} | staff | salon_get | — | statistiche cassa nascoste senza sales |
| PUT/DELETE /clients/{id} | staff | salon_get | clients |  |
| POST /clients/import | staff | ctx.salon | clients |  |
| GET /clients/{id}/appointments·history·notes·sheets | staff | salon_get | clients | incassi solo con sales |
| POST/PUT/DELETE /clients/{id}/notes… ·sheets… | staff | salon_get | clients | upload via common.media |
| POST /clients/public/hook | pubblico | slug | — | riattiva schede disattivate (10-15) |
| GET /catalog/… (categories/services/packages) | staff | ctx.salon | — |  |
| POST/PUT/DELETE /catalog/… | staff | salon_get | pricing |  |
| GET /catalog/public/services·packages | pubblico | slug | — | rate limit per IP |
| GET /agenda/day·week·range·availability | staff | ctx.salon | agenda |  |
| POST /agenda/appointments (+move/split/restore/check-in/…) | staff | salon_get | agenda | force solo staff |
| POST /agenda/appointments/{id}/deposit-cashed·deposit-refunded | staff | salon_get | sales |  |
| GET /agenda/appointments/{id}·/margin | staff | salon_get | agenda |  |
| GET /agenda/released | staff | ctx.salon | — (manca agenda) | (10-09) |
| GET/POST /agenda/undo | staff | ctx.salon | agenda | storico per persona |
| GET/POST/PUT/DELETE /agenda/pauses… ·waitlist… | staff | salon_get | agenda |  |
| GET /agenda/client/appointments·availability | cliente | ctx.client | — | availability = solo orari |
| GET /agenda/public/availability | pubblico | slug | — | rate limit per IP |
| POST /agenda/client/appointments (+move/cancel) | cliente | ctx.client | — | move/cancel espongono la nota staff (10-10) |
| GET/POST/DELETE /agenda/client/waitlist… | cliente | ctx.client | — |  |
| POST /sales/checkout/{id}·/pos | staff | salon_get | sales |  |
| GET /sales/ ·/{id} | staff | ctx.salon/salon_get | sales |  |
| GET /sales/today-summary | staff | ctx.salon | — | senza scope VOLUTO (riquadro agenda) |
| POST /sales/appointments/{id}/charge-no-show·deposit-link | staff | salon_get | sales |  |
| POST /sales/client/setup-intent·/…/deposit-link | cliente | ctx.client | — |  |
| GET/POST/DELETE /sales/stripe/connect… | staff | ctx.salon | titolare (start/callback/disconnect) |  |
| POST /sales/stripe/webhook | pubblico | firma + metadata/account | — | filtri account/salone |
| GET /staff/ | staff | ctx.salon | — | hourly_cost/month_revenue senza sales (10-09) |
| POST/PUT/DELETE /staff/… ·shifts·absences | staff | salon_get | team |  |
| PATCH /staff/{id}/color | staff | salon_get | agenda |  |
| GET /staff/{id}/performance·clients | staff | salon_get | — | incassi/spesa senza sales (10-09) |
| GET /staff/public/operators | pubblico | slug | — | rate limit per IP |
| GET/POST/PUT/DELETE /inventory/products·suppliers·categories·orders… | staff | salon_get | inventory |  |
| POST /inventory/products/{id}/load | staff | salon_get | inventory | fattura non usa stored_upload_name (10-16) |
| GET /inventory/movements·/{id}/movements | staff | ctx.salon | — | invoice_url firmato senza sales (10-09) |
| GET /marketing/coupons·gift-cards | staff | ctx.salon | — | codici al portatore a tutto lo staff (10-06) |
| POST/PUT/DELETE /marketing/coupons·gift-cards·loyalty·communications… | staff | salon_get | marketing |  |
| GET /marketing/loyalty-programs·/{id}/accounts·communications | staff | ctx.salon | — |  |
| GET /marketing/client/wallet, POST /marketing/client/gift-cards·marketing-consent | cliente | ctx.client | — |  |
| GET /automations/ | staff | ctx.salon | — | token mascherati senza marketing |
| POST/PUT/DELETE/toggle /automations/… | staff | salon_get | marketing |  |
| POST /automations/hook/{token} | pubblico | token automazione | — | rate limit per automazione |
| GET /insights/* , POST /insights/ask | staff | ctx.salon | titolare |  |
| GET /integrations/yourang/oauth/start | staff | ctx.salon | titolare |  |
| GET /integrations/yourang/oauth/login/start | pubblico | — | — |  |
| POST /integrations/yourang/oauth/exchange | pubblico | login: identità; connect: sessione staff | connect→titolare | no state (10-02); login collega org di un membro (10-03) |
| GET /integrations/yourang/status | staff | ctx.salon | — |  |
| DELETE /integrations/yourang/connection | staff | ctx.salon | titolare |  |
| POST /integrations/yourang/webhook | pubblico | firma HMAC + org | — |  |
