"""Scheda operatrice, pattern di turno e assenze: le regole di scrittura.

Colore, ciclo e ordine arrivano dal client e finiscono grezzi a database: qui
si controllano (400, non 500) e si scrivono solo le colonne presenti nel corpo.
Turni e pulizia dei turni fuori ciclo passano dallo stesso lock sulla riga
dell'operatrice. api.py controlla i permessi e legge con `salon_get`
l'operatrice su cui si lavora (i test sostituiscono quella lettura per simulare
una modifica concorrente del ciclo).
"""

from typing import Optional

from django.db import transaction
from ninja.errors import HttpError

from apps.accounts.models import Membership
from apps.catalog.models import Service
from apps.core.models import Location
from apps.core.services import log_activity
from common.utils import salon_get
from common.validation import MAX_POSITIVE_INT, require_hex_color

from .models import Absence, Operator, WeeklyShift

# Un ciclo di turni più lungo di un anno non esiste in un salone, e il campo a
# database è PositiveSmallIntegerField: senza tetto (e senza minimo) il valore
# diventava un errore del database (500) invece di un errore della richiesta.
MAX_CYCLE_WEEKS = 52
MAX_OPERATOR_ORDER = MAX_POSITIVE_INT  # limite di PositiveIntegerField


def resolve_user(ctx, user_id: Optional[int]):
    """L'utente staff associato all'operatrice deve appartenere allo stesso team."""
    if not user_id:
        return None
    membership = (
        Membership.objects.filter(salon=ctx.salon, user_id=user_id).select_related("user").first()
    )
    if membership is None:
        raise HttpError(404, "Utente non trovato nel team")
    return membership.user


# Colonne che accettano null nel corpo: nessuna sede, nessun utente collegato.
_NULLABLE_OPERATOR_FIELDS = {"location_id", "user_id"}


def validate_operator_payload(payload: dict) -> None:
    """Colore, ciclo e ordine arrivano dal client e finiscono grezzi a database.

    Senza questi controlli un ciclo a zero o negativo, o un colore che non è un
    esadecimale, non erano un 400 ma un errore del database: 500, e chi compila
    la scheda non sapeva quale campo rifare. Si controllano i campi presenti:
    in modifica il corpo porta solo quelli cambiati.
    """
    for name, value in payload.items():
        if value is None and name not in _NULLABLE_OPERATOR_FIELDS:
            raise HttpError(400, f"Campo obbligatorio: {name}")
    if "color" in payload:
        require_hex_color(payload["color"].strip())
    if "cycle_weeks" in payload and not (1 <= payload["cycle_weeks"] <= MAX_CYCLE_WEEKS):
        raise HttpError(400, f"Settimane di ciclo non valide (da 1 a {MAX_CYCLE_WEEKS})")
    if "order" in payload and not (0 <= payload["order"] <= MAX_OPERATOR_ORDER):
        raise HttpError(400, "Ordine dell'operatrice non valido")
    if "hourly_cost" in payload and payload["hourly_cost"] < 0:
        raise HttpError(400, "Il costo orario non può essere negativo")


def save_operator(operator: Operator, ctx, payload: dict) -> Operator:
    """Applica `payload` (i soli campi da scrivere) e salva.

    In creazione arriva il corpo completo. In modifica solo i campi presenti
    nella richiesta (C19): la scheda costruiva la PUT dal modulo letto
    all'apertura e sostituiva tutto, quindi il colore cambiato dall'agenda o
    l'abilitazione a un servizio data dal listino nel frattempo tornavano
    indietro al primo «Salva» (09-09). Per lo stesso motivo in modifica si
    scrivono solo quelle colonne, e i servizi solo se `service_ids` c'è.
    """
    validate_operator_payload(payload)
    payload = dict(payload)
    creating = operator.pk is None
    service_ids = payload.pop("service_ids", None)
    if "color" in payload:
        payload["color"] = payload["color"].strip().upper()
    fields = []
    if "location_id" in payload:
        location_id = payload.pop("location_id")
        operator.location = salon_get(Location, ctx, location_id) if location_id else None
        fields.append("location")
    if "user_id" in payload:
        user = resolve_user(ctx, payload.pop("user_id"))
        if user is not None:
            # `Operator.user` è OneToOne: collegare a un'operatrice un utente già
            # legato a un'altra faceva saltare l'insert con un 500 anonimo.
            taken = Operator.objects.filter(user=user).exclude(pk=operator.pk).first()
            if taken is not None:
                raise HttpError(400, f"Utente già collegato a {taken.first_name} {taken.last_name}")
        operator.user = user
        fields.append("user")
    for name, value in payload.items():
        setattr(operator, name, value)
        fields.append(name)

    # Abbassare `cycle_weeks` lasciava a database i turni delle settimane
    # scomparse: `_week_index` non li seleziona più da nessuna data, quindi
    # l'operatrice risultava a riposo per metà delle settimane senza che nulla
    # lo mostrasse. Si cancellano nella stessa transazione del salvataggio.
    orphans = 0
    with transaction.atomic():
        if creating:
            operator.salon = ctx.salon
            operator.save()
        else:
            # Stesso lock di `replace_operator_shifts`: la pulizia dei turni
            # fuori ciclo e una sostituzione dei turni in corsa non si incrociano.
            Operator.objects.select_for_update().filter(pk=operator.pk).first()
            if fields:
                operator.save(update_fields=fields)
            if "cycle_weeks" in payload:
                orphans = operator.shifts.filter(week_index__gte=operator.cycle_weeks).delete()[0]
        if service_ids is not None:
            operator.services.set(Service.objects.filter(salon=ctx.salon, id__in=service_ids))
    if orphans:
        log_activity(
            ctx.salon,
            "operator.shifts_updated",
            f"Ciclo turni ridotto a {operator.cycle_weeks} settimane: "
            f"{orphans} righe di turno fuori ciclo rimosse",
            actor=ctx.user,
            payload={"operator_id": operator.id, "removed_shifts": orphans},
        )
    return operator


def validate_shift_row(operator: Operator, row) -> None:
    if row.weekday not in range(7):
        raise HttpError(400, "Giorno della settimana non valido")
    if not (0 <= row.week_index < (operator.cycle_weeks or 1)):
        raise HttpError(400, "Settimana del ciclo non valida per questa operatrice")
    if not (0 <= row.start_min < row.end_min <= 1440):
        raise HttpError(400, "Orario di turno non valido")
    if (row.break_start_min is None) != (row.break_end_min is None):
        raise HttpError(400, "La pausa richiede sia l'inizio sia la fine")
    if row.break_start_min is not None:
        if not (row.start_min <= row.break_start_min < row.break_end_min <= row.end_min):
            raise HttpError(400, "Orario di pausa non valido")


def reject_overlapping_shifts(rows) -> None:
    """Due righe dello stesso giorno e della stessa settimana non si sovrappongono.

    Righe contigue (9–13 e 13–18) restano ammesse: sono lo stesso turno spezzato.
    Sovrapporle invece non significa nulla — quale delle due pause vale? — e
    faceva sparire la pausa pranzo dalle finestre lavorabili.
    """
    by_day: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for row in rows:
        by_day.setdefault((row.week_index, row.weekday), []).append((row.start_min, row.end_min))
    for spans in by_day.values():
        spans.sort()
        for (_, previous_end), (start, _) in zip(spans, spans[1:]):
            if start < previous_end:
                raise HttpError(400, "Due righe di turno si sovrappongono nello stesso giorno")


def replace_operator_shifts(operator: Operator, rows):
    """Sostituisce tutto il pattern di turno. Ritorna (operatrice riletta sotto lock, righe create)."""
    with transaction.atomic():
        # Cancella-e-ricrea sotto lock sulla riga dell'operatrice: su PostgreSQL
        # il DELETE del secondo di due salvataggi simultanei non vedeva le righe
        # appena inserite dal primo, e restavano entrambe le serie sovrapposte —
        # proprio ciò che `reject_overlapping_shifts` vieta (18-14). Le righe si
        # validano sull'operatrice riletta sotto lock: il ciclo ridotto nel
        # frattempo non lascia turni fuori ciclo.
        operator = Operator.objects.select_for_update().get(pk=operator.pk)
        for row in rows:
            validate_shift_row(operator, row)
        reject_overlapping_shifts(rows)
        operator.shifts.all().delete()
        shifts = WeeklyShift.objects.bulk_create(
            [
                WeeklyShift(
                    operator=operator,
                    week_index=row.week_index,
                    weekday=row.weekday,
                    start_min=row.start_min,
                    end_min=row.end_min,
                    break_start_min=row.break_start_min,
                    break_end_min=row.break_end_min,
                )
                for row in rows
            ]
        )
    return operator, shifts


def validate_absence(data) -> None:
    """Tipo fra quelli del modello e intervallo non rovesciato (400 altrimenti)."""
    if data.type not in Absence.Type.values:
        raise HttpError(400, "Tipo di assenza non valido")
    if data.date_from > data.date_to:
        raise HttpError(400, "L'intervallo di assenza non è valido")


def absence_or_404(operator: Operator, absence_id: int) -> Absence:
    """L'assenza di QUESTA operatrice, o 404."""
    absence = operator.absences.filter(pk=absence_id).first()
    if absence is None:
        raise HttpError(404, "Assenza non trovata")
    return absence
