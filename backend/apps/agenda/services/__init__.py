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
- `deposits`: quanto chiedere di caparra, regali, link di pagamento;
- `messages`: eventi verso Yourang, trattenuti e fusi;
- `freed_slots`: gli annunci `slot.freed` alla lista d'attesa;
- `undo_messages`: i messaggi dopo un «torna indietro»;
- `refunds`: i rimborsi della caparra;
- `deposit_holds`: la caparra con scadenza (sollecito, rilascio, ripristino);
- `appointments`: creazione, modifica, spostamento, stacco;
- `transitions`: check-in, inizio trattamento, no-show, annullamento.

Si importa dai sottomoduli, mai da qui: un `mock.patch("apps.agenda.services.X")`
non patcherebbe il nome che il codice usa davvero, che è quello del sottomodulo.
"""

# compat refactoring: rimuovere dopo l'integrazione. Nomi che il codice e i test
# di altre app (sales, integrations, staff, clients, marketing) cercano ancora
# qui: ciascuno va importato dal sottomodulo accanto.
from apps.core.services import default_location  # noqa: F401

from ..models import Appointment
from .appointments import create_appointment, edit_appointment, move_appointment  # noqa: F401
from .deposit_holds import clear_deposit_hold, mark_deposit_cashed, process_deposit_holds  # noqa: F401
from .deposits import compute_deposit  # noqa: F401
from .freed_slots import free_slot_event  # noqa: F401
from .locking import lock_salon  # noqa: F401
from .messages import appointment_event_key  # noqa: F401
from .refund_ledger import (  # noqa: F401
    REFUND_DONE,
    REFUND_FLOOR_KEY,
    REFUND_GONE,
    REFUND_IN_FLIGHT,
    _refund_sums,
    _refunds_committed_cents,
    _refunds_done_cents,
    _to_cents,
)
from .refunds import mark_deposit_refunded, record_deposit_refund, settle_deposit_refund  # noqa: F401
from .transitions import cancel_appointment  # noqa: F401

# compat refactoring: rimuovere dopo l'integrazione (ora è `Appointment.OPEN_STATUSES`).
OPEN_STATUSES = Appointment.OPEN_STATUSES
