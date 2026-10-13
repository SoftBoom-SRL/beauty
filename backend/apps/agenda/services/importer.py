"""Import degli appuntamenti da un altro gestionale: visite già mappate dalla dashboard.

`import_visits` è la logica di POST /api/agenda/appointments/import. Servizi e
operatrici arrivano già abbinati al listino e allo staff del salone; qui si
riconosce la cliente, si rivalida la visita e la si scrive. Ogni visita ha il
suo savepoint e il suo esito, come le righe dell'import clienti.
"""

import re
from collections import defaultdict
from decimal import Decimal

from django.db import DataError, IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.clients.models import Client
from apps.clients.search import APOSTROPHE_CLASS, strip_accents
from common.money import MAX_MONEY
from common.phone import canonical_phone, normalize_phone, phone_key

from ..models import Appointment
from .appointments import _write_items
from .locking import lock_salon
from .resolution import resolve_items_edit

MAX_DURATION_MIN = 12 * 60  # lo stesso tetto della modifica di una visita

FORCED_WARNING = (
    "Fuori turno, fuori orario o sopra un altro appuntamento: importato lo stesso, segnato «forzato»"
)


class _Refused(Exception):
    """La visita non entra: il motivo per chi importa, e la scheda coinvolta se c'è."""

    def __init__(self, reason: str, client_id: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.client_id = client_id


def _name_key(first_name: str, last_name: str) -> tuple:
    """Il nome senza ordine, accenti né maiuscole: «Rossi Maria» è «Maria Rossi».

    Gli altri gestionali esportano la cliente in una colonna sola, e nello
    stesso file il cognome sta a volte prima e a volte dopo.
    """
    plain = re.sub(APOSTROPHE_CLASS, "'", strip_accents(f"{first_name} {last_name}"))
    return tuple(sorted(plain.casefold().split()))


class _Clients:
    """La rubrica del salone, letta una volta: per telefono, per email, per nome."""

    def __init__(self, salon):
        self.salon = salon
        self.by_phone, self.by_email = {}, {}
        self.by_name = defaultdict(list)
        for client in Client.objects.filter(salon=salon).only(
            "id", "phone", "email", "first_name", "last_name", "is_active"
        ):
            self.remember(client)

    def remember(self, client) -> None:
        key = phone_key(client.phone)
        if key:
            self.by_phone[key] = client
        if client.email:
            self.by_email[client.email.strip().lower()] = client
        self.by_name[_name_key(client.first_name, client.last_name)].append(client)

    def find(self, visit: dict):
        """La scheda della cliente della visita, None se va creata. `_Refused` se non si può dire.

        Per telefono, comunque sia scritto. Solo le righe SENZA numero si
        cercano per email e poi per nome, e l'email vale se il nome non la
        contraddice: con l'indirizzo di famiglia l'appuntamento della figlia
        finiva sulla scheda della madre (lo stesso criterio dell'import clienti).
        """
        phone, email = visit["phone"], visit["email"]
        name = _name_key(visit["first_name"], visit["last_name"])
        key = phone_key(phone)
        if phone and not key:
            raise _Refused("Telefono non valido")
        if key:
            client = self.by_phone.get(key)
        else:
            client = self.by_email.get(email.lower()) if email else None
            if client is not None and name != _name_key(client.first_name, client.last_name):
                raise _Refused(
                    f"Riga senza telefono: l'email è di {client.full_name}, un'altra persona",
                    client.id,
                )
            if client is None:
                same_name = self.by_name.get(name, []) if name else []
                if len(same_name) > 1:
                    raise _Refused(
                        f"Riga senza telefono: {len(same_name)} schede con questo nome, aggiungi il numero"
                    )
                if not same_name:
                    raise _Refused(
                        "Riga senza telefono: nessuna scheda con questo nome. Crea prima la cliente in rubrica"
                    )
                client = same_name[0]
        if client is not None and not client.is_active:
            raise _Refused(
                f"Scheda archiviata: {client.full_name}. Riattivala dalla rubrica se è ancora cliente",
                client.id,
            )
        return client

    def create(self, visit: dict):
        if not visit["first_name"]:
            raise _Refused("Nome mancante")
        return Client.objects.create(
            salon=self.salon,
            first_name=visit["first_name"],
            last_name=visit["last_name"],
            email=visit["email"],
            phone=canonical_phone(visit["phone"]),
            origin="Import",
            # Una cliente che il salone aveva già: niente «cliente dal» di oggi,
            # come nell'import della rubrica.
            since=None,
        )


def _resolve(salon, visit: dict, client, location):
    """Le voci della visita con le regole di una modifica dello staff: (voci, forzata).

    Si passa da `resolve_items_edit` perché è la via che accetta una durata
    diversa dal listino. L'idoneità non si forza mai (404 servizio, 400
    operatrice); turni, orari e sovrapposizioni sì, perché l'appuntamento
    esiste già e la cliente lo sa: si riprova forzando solo il 409, e la
    visita resta marcata, come un incastro fatto a mano dal banco.
    """
    items = []
    for item in visit["items"]:
        if not 1 <= item["duration_min"] <= MAX_DURATION_MIN:
            raise _Refused(f"Durata non valida: {item['duration_min']} minuti")
        price = item["price"]
        if price is not None and not Decimal("0") <= price <= MAX_MONEY:
            raise _Refused(f"Prezzo non valido: {price}")
        items.append({
            "service_id": item["service_id"],
            "operator_id": item["operator_id"],
            "duration_min": item["duration_min"],
            # Niente posa: gli orari del file sono già quelli di ogni servizio.
            "soak_min": 0,
        })
    kwargs = {"location": location, "ignore_client_id": client.id if client else None}
    forced = False
    try:
        resolved = resolve_items_edit(salon, items, visit["start"], **kwargs)
    except HttpError as err:
        if err.status_code != 409:
            raise
        resolved = resolve_items_edit(salon, items, visit["start"], force=True, **kwargs)
        forced = True
    priced = [
        row if item["price"] is None else row._replace(price=item["price"])
        for row, item in zip(resolved, visit["items"])
    ]
    return priced, forced


def _import_one(salon, clients: _Clients, visit: dict, location) -> tuple:
    """Scrive una visita. Ritorna (esito, scheda creata o None, forzata); esito = created | duplicate."""
    # Solo da oggi in poi: una visita passata nascerebbe «confermata» e
    # resterebbe aperta in agenda, in attesa di una cassa che non arriverà mai.
    if timezone.localtime(visit["start"]).date() < timezone.localdate():
        raise _Refused("Appuntamento già passato: si importano solo quelli da oggi in poi")
    client = clients.find(visit)
    first = visit["items"][0]
    # Lo stesso file caricato due volte, o ripreso dopo un blocco fallito, non
    # raddoppia l'agenda. Vale anche per una visita poi annullata: il salone
    # l'ha tolta apposta.
    if client is not None and Appointment.objects.filter(
        salon=salon, client=client, start=visit["start"],
        items__service_id=first["service_id"], items__operator_id=first["operator_id"],
    ).exists():
        return "duplicate", None, False
    resolved, forced = _resolve(salon, visit, client, location)
    new_client = None
    if client is None:
        client = new_client = clients.create(visit)
    # Né caparra né conferma: la cliente ha prenotato sull'altro gestionale e lo
    # sa già. Per questo non si passa da `create_appointment`, che applicherebbe
    # le regole della caparra e accoderebbe un messaggio per ogni visita del file
    # (la sync da Yourang, per lo stesso motivo, scrive anche lei direttamente).
    appointment = Appointment.objects.create(
        salon=salon,
        location=location,
        client=client,
        operator=resolved[0].operator,
        start=visit["start"],
        note=visit["note"],
        # ponytail: nessuna origine «import» fra le CreatedVia (vorrebbe una
        # migrazione): da aggiungere se l'agenda dovrà distinguere le importate.
        created_via=Appointment.CreatedVia.DASHBOARD,
        forced=forced,
    )
    _write_items(appointment, resolved)
    return "created", new_client, forced


def import_visits(salon, visits: list[dict], *, location=None) -> dict:
    """Porta in agenda le visite di un altro gestionale, una per savepoint.

    Una visita rifiutata (cliente che non si riconosce, operatrice non
    abilitata al servizio, riga che il database non accetta) finisce in
    `errors` con il suo indice e non porta via le altre. La scheda creata per
    una visita poi rifiutata sparisce col savepoint: entra nella rubrica in
    memoria solo a visita scritta.
    """
    created = duplicates = clients_created = 0
    errors: list[dict] = []
    warnings: list[dict] = []
    clients = _Clients(salon)

    for index, raw in enumerate(visits):
        visit = {
            **raw,
            **{k: (raw.get(k) or "").strip() for k in ("first_name", "last_name", "phone", "email", "note")},
        }
        try:
            with transaction.atomic():
                lock_salon(salon)
                outcome, new_client, forced = _import_one(salon, clients, visit, location)
        except _Refused as exc:
            errors.append({"row": index, "reason": exc.reason, "client_id": exc.client_id})
            continue
        except HttpError as exc:
            errors.append({"row": index, "reason": exc.message})
            continue
        except (IntegrityError, DataError) as exc:
            errors.append({"row": index, "reason": f"Riga rifiutata dal database: {exc}"})
            continue
        if outcome == "duplicate":
            duplicates += 1
            continue
        created += 1
        if new_client is not None:
            clients.remember(new_client)
            clients_created += 1
            if normalize_phone(new_client.phone) is None:
                warnings.append({
                    "row": index,
                    "reason": "Telefono non riconosciuto: scheda creata col numero com'è, da correggere",
                    "client_id": new_client.id,
                })
        if forced:
            warnings.append({"row": index, "reason": FORCED_WARNING})

    return {
        "created": created,
        "duplicates": duplicates,
        "skipped": len(errors),
        "clients_created": clients_created,
        "errors": errors,
        "warnings": warnings,
    }
