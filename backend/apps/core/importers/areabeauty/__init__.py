"""Import da AreaBeauty (Infolan): l'export grezzo in JSON → un salone di beauty.

L'export è la cartella delle risposte di AreaBeauty così come le dava il suo
frontend (vedi `import/esther/raw/INVENTARIO.md` nel repository di chi l'ha
fatto) e la mappa campo per campo è `import/esther/MAPPA_IMPORT.md`.

Regole che valgono per ogni passo (`steps/`):

- **Niente eventi.** Si scrive con l'ORM e mai con i servizi di agenda, cassa
  o marketing: quelli emettono eventi verso Yourang (WhatsApp alle clienti),
  scrivono nel registro attività e muovono fedeltà e magazzino.
- **Date vere.** `created_at` è `auto_now_add` quasi ovunque: si crea e poi si
  riscrive la data con `ctx.backdate` (un UPDATE, che `auto_now_add` non tocca).
- **Rifacibile.** Ogni record di AreaBeauty si collega al suo in beauty con
  `ctx.link(kind, id_areabeauty, oggetto)` (core.ExternalRef) e prima di creare
  si guarda `ctx.ref(kind, id_areabeauty)`: rilanciato su un export più recente
  il comando aggiunge le novità invece di duplicare.
- **Niente dati personali nei messaggi.** Gli avvisi (`ctx.warn`) citano id e
  conteggi, mai nomi, telefoni o note: il rapporto finisce nei log.

I passi girano nell'ordine di `STEPS`: ognuno usa i riferimenti di quelli prima.
"""

# Ordine dei passi: catalogo e staff prima delle clienti, le clienti prima
# dell'agenda, l'agenda prima delle schede (che si agganciano alla visita del
# giorno) e delle vendite; i crediti prima delle vendite, che li usano come
# pagamento; le vendite prima dei movimenti di magazzino, che puntano a loro.
STEPS = (
    "cleanup",      # dati di prova del salone (solo con --purge-test-data)
    "catalog",      # categorie, servizi (collegati a quelli esistenti), pacchetti
    "staff",        # operatrici, ferie future
    "clients",      # anagrafica, contatti, note, etichette
    "inventory",    # fornitori, categorie prodotti, prodotti
    "agenda",       # appuntamenti (catene, aggiuntivi), annullati e no-show
    "sheets",       # schede tecniche
    "credits",      # gift box, servizi già pagati, pacchetti venduti
    "sales",        # vendite, righe, pagamenti, conti da saldare
    "stock",        # movimenti di magazzino e giacenze
)

# Il nome della sorgente nei riferimenti esterni (core.ExternalRef.source).
SOURCE = "areabeauty"
