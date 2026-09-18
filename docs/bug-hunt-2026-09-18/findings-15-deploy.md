# Deploy e infrastruttura — 2 critici, 4 alti, 6 medi, 5 bassi
Verificato: nessun segreto tracciato in git (.env e *.sqlite3 assenti da git ls-files); lockfile npm versionato e usato da npm ci.

## [N1] DEPLOY.md documenta variabili Yourang che il codice non legge piu, e omette quelle vere — CRITICO
- Dove: DEPLOY.md:96-116, 228-243 vs config/settings.py:211-224
- Cosa: il documento prescrive ENCRYPTION_KEY, YOURANG_ISSUER_URL, YOURANG_CLIENT_ID, YOURANG_CLIENT_SECRET, YOURANG_WEBHOOK_RECEIVER_URL. Nessuna delle cinque esiste nel backend. Servono invece YOURANG_PROXY_URL, YOURANG_PROXY_API_KEY, YOURANG_PROXY_WEBHOOK_SECRET, assenti dal documento.
- Scenario: si configura seguendo la guida alla lettera, il deploy riesce e /healthz risponde. Poi ogni rotta connect/oauth da 503 e ogni webhook in ingresso viene rifiutato. Il sintomo e identico a "non ho configurato niente".
- Fix: riscrivere le sezioni sull'architettura proxy; .env.example e gia corretto.

## [N2] YOURANG_API_URL / YOURANG_API_KEY non sono nell'elenco env: nessun OTP parte mai — CRITICO
- Dove: DEPLOY.md:88-123 vs flush_outbox.py:126-130, 216-218
- Cosa: senza quell'URL il comando conta solo i pendenti. Le due variabili sono citate di sfuggita in prosa a DEPLOY.md:309.
- Scenario: deploy secondo la guida, job flush_outbox attivo. Le clienti chiedono l'OTP, il codice resta in tabella, NESSUNA riesce a entrare. La tabella diagnostica a DEPLOY.md:304 attribuisce il sintomo alla causa sbagliata.

## [N3] CLIENT_APP_ORIGIN non documentata: dopo la caparra la cliente finisce sulla dashboard staff — ALTO
- Dove: config/settings.py:228, stripe_service.py:187-193; assente da DEPLOY.md
- Scenario: pagamento riuscito e la cliente atterra sulla login del gestionale.

## [N4] Default di sicurezza fail-open, nessun fail-fast — ALTO (stesso di S1)
- Dove: config/settings.py:12-14, 198

## [N5] ARG APP=dashboard silenzioso: beauty-client puo pubblicare la dashboard staff — ALTO
- Dove: frontend/Dockerfile:8, 35, 41
- Cosa: VITE_API_URL ha una guardia esplicita, APP no.
- Scenario: se APP resta env di runtime invece che build arg, il build riesce e https://beautyclients... serve il gestionale staff, con healthcheck verde.
- Fix: ARG APP senza default + RUN test -d "apps/$APP".

## [N6] SSE_MAX_CONNECTIONS (40) piu alto dei thread gunicorn (24): il tetto non protegge nulla — ALTO
- Dove: config/settings.py:233-237, core/views.py:33-41, backend/Dockerfile:32-39
- Cosa: il commento dichiara "circa la meta di --threads" ma il default e 40 con --threads 24. Il contatore e per processo e ogni stream tiene un thread fino a 20 minuti.
- Scenario: 24 postazioni sullo stesso worker: il tetto non scatta mai, il 503 che farebbe ripiegare sul polling non arriva, e quel worker smette di servire qualunque richiesta (agenda, POS, /media/) per 20 minuti.
- Fix: default ~12; correggere anche la stima di capacita a DEPLOY.md:319-320.

## [N7] Dipendenze Python non bloccate: la stessa commit puo produrre immagini diverse — MEDIO
- Dove: backend/requirements.txt:1-14. Ogni push su main ricostruisce tutti e tre i servizi e pip risolve le versioni del giorno.

## [N8] .dockerignore non esclude e2e_db.sqlite3: il DB demo finisce nell'immagine — MEDIO
- Dove: backend/.dockerignore:6 (pattern letterale db.sqlite3). 912 KB con clienti, telefoni, hash password.

## [N9] Il container backend gira come root — MEDIO
- Dove: backend/Dockerfile (nessun USER). E l'unica superficie che scrive file forniti dall'esterno.

## [N10] STRIPE_CONNECT_CLIENT_ID e il suo redirect_uri non documentati — MEDIO
- Dove: config/settings.py:207, stripe_service.py:53-60, sales/api.py:369-375

## [N11] Nessun backup del volume dei media — MEDIO
- Dove: DEPLOY.md:62, 79-84. Perso il volume, ogni logo, foto di scheda tecnica e allegato diventa 404.

## [N12] gzip_types di nginx senza text/javascript: i bundle JS non compressi — MEDIO
- Dove: frontend/nginx.conf:13 (nginx >= 1.25.1 usa text/javascript per i .js)

## [N13] CorsMiddleware sotto whitenoise e SecurityMiddleware — BASSO
- Dove: config/settings.py:47-58

## [N14] start-dev.sh: pkill che non combacia e array vuoto con set -u — BASSO
- Dove: start-dev.sh:10-20. Al rilancio strictPort fa fallire i dev server.

## [N15] DEPLOY.md offre un'alternativa per Dockerfile Location che non puo funzionare — BASSO
- Dove: DEPLOY.md:74

## [N16] entrypoint.sh nasconde qualsiasi errore di createsuperuser come "gia presente" — BASSO
- Dove: backend/entrypoint.sh:16-22

## [N17] HEALTHCHECK --start-period=40s con migrate+collectstatic all'avvio — BASSO
- Dove: backend/Dockerfile:26-27, entrypoint.sh:5-12. Finestra reale ~130s: primo deploy su DB vuoto in ciclo di riavvii.

## Verificati e non problematici
- Fallback SPA di nginx corretto, no-store su index.html, copre /oauth-popup/* e /stripe-connect/*.
- Header SSE corretti (X-Accel-Buffering: no); --timeout 60 non uccide gli stream con worker gthread.
- createcachetable eseguito; SECURE_REDIRECT_EXEMPT copre /healthz; load_dotenv non sovrascrive le env di Coolify.
