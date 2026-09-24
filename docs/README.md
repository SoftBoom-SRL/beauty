# Documentazione

| Dove | Cosa |
|---|---|
| [`../README.md`](../README.md) | Cos'è il progetto, come si avvia in locale, dove trovare il resto |
| [`SVILUPPO.md`](SVILUPPO.md) | Architettura e convenzioni: dove sta cosa, come si aggiunge una funzione, come si prova |
| [`../DEPLOY.md`](../DEPLOY.md) | Produzione: servizi Coolify, variabili d'ambiente, job pianificati, controlli dopo il deploy |
| [`../backend/SPEC.md`](../backend/SPEC.md) | Contratto delle API per app (endpoint, regole di dominio) |
| [`../frontend/README.md`](../frontend/README.md) | Convenzioni del frontend: struttura, chiamate API, contesto, date e soldi, test |
| [`manuale-flussi.html`](manuale-flussi.html) | Manuale funzionale dei flussi (riferimento di prodotto) |
| [`prototipo/`](prototipo/) | Il prototipo originale, congelato |
| [`superpowers/`](superpowers/) | Documenti di progetto di alcune funzioni (no-show e cancellazioni, web app cliente) |
| [`storia/`](storia/) | Diari di lavoro chiusi (integrazione del frontend, luglio–settembre 2026) |
| [`refactoring-2026-09-24/`](refactoring-2026-09-24/README.md) | Il refactoring del 24/09: cosa è cambiato e come è stato verificato, i [bug sospetti](refactoring-2026-09-24/BUG-SOSPETTI.md) trovati lungo la strada e corretti subito dopo, la [mappa dei vecchi file di test](refactoring-2026-09-24/MAPPA-TEST.md) |
| [`../tools/smoke/`](../tools/smoke/README.md) | Test di fumo nel browser: confronta due versioni schermata per schermata |

## Audit e cacce ai bug

Ogni tornata ha il suo rapporto; i commenti nel codice citano i reperti con il loro
identificativo, così dal codice si risale al perché di una scelta.

| Tornata | Rapporto | Identificativi nel codice |
|---|---|---|
| Audit del 17/09 | [`AUDIT_2026-09-17.md`](AUDIT_2026-09-17.md), sonde in [`audit-2026-09-17/`](audit-2026-09-17/) | `B01`–`B14` |
| Caccia del 18/09 | [`bug-hunt-2026-09-18/`](bug-hunt-2026-09-18/) (`00-RAPPORTO-UNICO.md` + un file per area) | citati per data e titolo |
| Caccia del 21/09 | [`BUG_HUNT_2026-09-21.md`](BUG_HUNT_2026-09-21.md), sonde in [`bug-hunt-2026-09-21/`](bug-hunt-2026-09-21/) | `B15`–`B27` (la numerazione continua dall'audit) |
| Caccia del 22/09 | [`bug-hunt-2026-09-22/`](bug-hunt-2026-09-22/) (`00-RAPPORTO-UNICO.md`, un file per area, `STATO-CORREZIONI.md`) | `(NN-MM)`: rapporto `NN`, reperto `MM` — per esempio `(13-02)` |
| Contratti fra aree del 22/09 | [`bug-hunt-2026-09-22/CONTRATTI.md`](bug-hunt-2026-09-22/CONTRATTI.md) | «contratto `Cn`» (`C1`–`C23`) |

Le sonde (`probes/`, `*_probes.py`, `*.test.js` dentro `docs/`) sono prove scritte
durante le cacce per riprodurre i difetti: non fanno parte delle suite di test e
non vengono raccolte da nessun runner.
