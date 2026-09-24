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

Chi sta dentro l'agenda importa dai sottomoduli, mai da qui: un
`mock.patch("apps.agenda.services.X")` non patcherebbe il nome che il codice
usa davvero, che è quello del sottomodulo.
"""

# Durante lo spostamento nei sottomoduli: i nomi che api, undo, i test e le altre
# app cercano ancora qui.
from apps.core.services import default_location  # noqa: F401

from ..models import Appointment
from .appointments import create_appointment, edit_appointment, move_appointment, split_appointment  # noqa: F401
from .availability import _slot_is_recommended, get_free_slots, slot_assignment, smart_slots  # noqa: F401
from .deposit_holds import (  # noqa: F401
    clear_deposit_hold,
    mark_deposit_cashed,
    process_deposit_holds,
    released_appointments,
    restore_released,
    schedule_deposit_hold,
)
from .deposits import _close_deposit_link_after_commit, compute_deposit, spendable_gift_cards  # noqa: F401
from .freed_slots import (  # noqa: F401
    _appointment_spans,
    _chain_spans,
    _slot_knowledge,
    _spans_minus,
    _sync_freed_slots,
    free_slot_event,
)
from .locking import _lock_and_reload, lock_salon  # noqa: F401
from .messages import (  # noqa: F401
    MAX_HOLD_FACTOR,
    _event_payload,
    _withdraw_deposit_messages,
    appointment_event_key,
    emit_appointment_event,
)
from .occupancy import _busy_map, bookable_operator_ids  # noqa: F401
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
from .resolution import _validate_segments, resolve_items  # noqa: F401
from .transitions import cancel_appointment, check_in, mark_no_show, start_appointment  # noqa: F401
from .undo_messages import revert_held_events  # noqa: F401

# Stati in cui l'appuntamento è ancora "aperto" e quindi modificabile.
OPEN_STATUSES = Appointment.OPEN_STATUSES
