"""Logica dell'agenda: disponibilità, depositi, creazione/spostamento/annullamento.

Convenzioni interne:
- tutti i calcoli di disponibilità lavorano in MINUTI DA MEZZANOTTE del giorno
  richiesto, nel fuso del salone (settings.TIME_ZONE);
- le funzioni di staff/clients/sales si importano dentro la funzione che le
  usa, a ogni chiamata: i test le sostituiscono nel loro modulo
  (`apps.staff.services.shift_windows`, `apps.clients.services.client_facts`,
  `apps.sales.stripe_service.*`), e sales a sua volta importa l'agenda;
- le finestre lavorabili arrivano da `staff.services.shift_windows(operator, date)`
  -> list[tuple[int, int]] (minuti), già al netto di pause pranzo e assenze.

I moduli, dai più semplici a quelli che li usano (nessun ciclo):
- `timegrid`: minuti da mezzanotte, intervalli liberi/occupati;
- `locking`: lock salone → riga dell'appuntamento;
- `refund_ledger`: conti dei rimborsi della caparra (li usa anche sales);
- `occupancy`: impegni per operatrice, chi si prenota, fasce di apertura;
- `availability`: la ricerca degli orari liberi e consigliati;
- `resolution`: la conferma di prenotazioni e modifiche (chi fa cosa, se ci sta);
- `messages`: eventi verso Yourang, trattenuti e fusi;
- `deposits`: quanto chiedere di caparra, regali, link di pagamento;
- `freed_slots`: gli annunci `slot.freed` alla lista d'attesa;
- `undo_messages`: i messaggi dopo un «torna indietro»;
- `refunds`: i rimborsi della caparra;
- `deposit_holds`: la caparra con scadenza (sollecito, rilascio, ripristino);
- `appointments`: creazione, modifica, spostamento, stacco;
- `transitions`: check-in, inizio trattamento, no-show, annullamento.

Si importa dai sottomoduli, mai da qui: un `mock.patch("apps.agenda.services.X")`
non patcherebbe il nome che il codice usa davvero, che è quello del sottomodulo.
"""
