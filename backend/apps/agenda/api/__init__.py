"""Endpoint agenda: viste giorno/settimana, appuntamenti, pause, waitlist,
disponibilità — sia per la dashboard staff sia per la web app cliente (/client/...).

Un modulo per risorsa, ciascuno con il suo Router SENZA tag: ninja somma i tag
dei router annidati, e «agenda» arriva già da questo. Si montano qui, nell'ordine
in cui le rotte erano registrate. Tutti i metodi di uno stesso percorso stanno
nello stesso modulo: con lo stesso percorso in due Router, Django si fermerebbe
al primo e risponderebbe 405 agli altri metodi. I nomi delle viste sono i nomi
degli URL: non vanno cambiati.

- `agenda_views`: /day, /week, /range, /released;
- `appointments`: /appointments e /appointments/{id}/… (staff);
- `undo_routes`: /undo;
- `pauses`: /pauses, /pauses/{id};
- `waitlist`: /waitlist, /waitlist/{id}/contacted;
- `availability`: /availability (staff);
- `client_app`: /client/… (app cliente) e /public/availability.
Parametri comuni in `params`, forma delle risposte in `..presenters`.
"""

from ninja import Router

# compat refactoring: rimuovere dopo l'integrazione. `apps.agenda.api` esponeva
# anche la serializzazione e l'analisi di `items`: clients (scheda cliente),
# marketing e i test li importano ancora da qui.
from ..presenters import _appointment_out, _client_appointment_out, _item_out, gift_index  # noqa: F401
from ..schemas import MAX_ITEMS_PER_REQUEST  # noqa: F401
from . import agenda_views, appointments, availability, client_app, pauses, undo_routes, waitlist
from .params import _parse_items_param  # noqa: F401

router = Router(tags=["agenda"])
router.add_router("", agenda_views.router)
router.add_router("", appointments.router)
router.add_router("", undo_routes.router)
router.add_router("", pauses.router)
router.add_router("", waitlist.router)
router.add_router("", availability.router)
router.add_router("", client_app.router)
