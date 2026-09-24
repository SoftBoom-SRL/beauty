"""Come l'agenda si mostra: la visita per lo staff e per la cliente, i regali che la
coprono, le pause, la lista d'attesa, i gesti da «torna indietro».

Solo lettura e forma dei dati: nessuna regola di dominio (quelle stanno in
`services`). Le usano le rotte dell'agenda e la scheda cliente (clients).
"""

import datetime as dt
from collections import defaultdict

from django.utils import timezone

from . import undo as undo_log
from .services import deposits


def _fmt_min(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _operator_name(operator) -> str:
    return f"{operator.first_name} {operator.last_name}".strip()


def _item_out(item) -> dict:
    return {
        "id": item.id,
        "service_id": item.service_id,
        "service_name": item.service.name_it,
        "operator_id": item.operator_id,
        "operator_name": _operator_name(item.operator),
        "duration_min": item.duration_min,
        "soak_min": item.soak_min,
        "price": item.price,
        "order": item.order,
    }


def gift_index(salon, client_ids) -> dict[int, list]:
    """{client_id: [GiftCard]} delle gift card «a trattamento» attive e pagate.

    Quali carte coprono quale cliente lo decide `services.deposits.spendable_gift_cards`
    (destinataria, o acquirente senza nessun destinatario; scadenza verificata
    in lettura): la stessa regola con cui la caparra esclude i servizi già
    pagati da un regalo. Calcolata una volta per vista, così l'agenda non fa una
    query per appuntamento.
    """
    cards = deposits.spendable_gift_cards(salon, client_ids).select_related(
        "gift_service", "buyer_client"
    )
    index: dict[int, list] = defaultdict(list)
    for card in cards:
        owner = card.recipient_client_id or card.buyer_client_id
        index[owner].append(card)
    return index


# Codici delle gift card: sono denaro al portatore. In agenda li vede interi solo
# chi lavora con quegli strumenti — marketing o cassa (chi fa il conto li usa
# per scalare il regalo) — come negli elenchi del marketing; per gli altri
# restano le ultime quattro cifre. Prima un'operatrice con la sola agenda li
# leggeva tutti dalle viste giorno, settimana e mese. La regola e la maschera
# sono quelle del marketing (`codes_hidden`, `mask_code`).
def _codes_hidden(viewer) -> bool:
    """Vero se chi guarda è staff senza marketing né cassa (la cliente vede i suoi)."""
    from apps.marketing.schemas import codes_hidden  # lazy: regola del marketing

    return bool(codes_hidden(viewer))


def _mask_code(code: str) -> str:
    from apps.marketing.schemas import mask_code  # lazy: stessa maschera del marketing

    return mask_code(code)


def _gifts_out(appointment, gifts_by_client, hide_codes: bool = False) -> list[dict]:
    cards = gifts_by_client.get(appointment.client_id) or []
    if not cards:
        return []
    service_ids = {item.service_id for item in appointment.items.all()}
    return [
        {
            "gift_card_id": card.id,
            "code": _mask_code(card.code) if hide_codes else card.code,
            "service_id": card.gift_service_id,
            "service_name": card.gift_service.name_it,
            "balance": card.balance,
            # «In regalo da…» solo se l'ha comprata qualcun altro: una carta
            # comprata per sé mostrava alla cliente «In regalo da» sé stessa.
            "from_name": (
                card.buyer_client.full_name
                if card.buyer_client_id and card.buyer_client_id != appointment.client_id
                else ""
            ),
        }
        for card in cards
        if card.gift_service_id in service_ids
    ]


def _appointment_out(appointment, gifts_by_client=None, viewer=None) -> dict:
    """La visita come la vede lo staff. `viewer` (il contesto di chi chiede)
    decide se i codici delle gift card escono interi: senza, restano interi."""
    client = appointment.client
    if gifts_by_client is None:
        gifts_by_client = gift_index(appointment.salon, [appointment.client_id])
    return {
        "id": appointment.id,
        "client": {"id": client.id, "full_name": client.full_name, "phone": client.phone},
        "operator_id": appointment.operator_id,
        "location_id": appointment.location_id,
        "start": appointment.start,
        "end": appointment.end,
        "status": appointment.status,
        "deposit_status": appointment.deposit_status,
        "deposit_amount": appointment.deposit_amount,
        "deposit_refunded_amount": appointment.deposit_refunded_amount,
        "deposit_credit": appointment.deposit_credit,
        "deposit_due_at": appointment.deposit_due_at,
        "deposit_payment_link": appointment.deposit_payment_link or "",
        "total_duration_min": appointment.total_duration_min,
        "total_price": appointment.total_price,
        "note": appointment.note,
        "flexible": appointment.flexible,
        "created_via": appointment.created_via,
        "cancel_reason": appointment.cancel_reason,
        "cancelled_late": appointment.cancelled_late,
        "auto_released": appointment.auto_released,
        "forced": appointment.forced,
        "items": [_item_out(item) for item in appointment.items.all()],
        "gifts": _gifts_out(appointment, gifts_by_client, _codes_hidden(viewer)),
        "updated_at": appointment.updated_at,
    }


def _pause_label(action: str, pause) -> str:
    """«Pausa spostata · Laura, 13:00» — la frase che compare in «torna indietro»."""
    return f"{action} · {_operator_name(pause.operator)}, {timezone.localtime(pause.start):%H:%M}"


def _pause_out(pause) -> dict:
    return {
        "id": pause.id,
        "operator_id": pause.operator_id,
        "operator_name": _operator_name(pause.operator),
        "start": pause.start,
        "duration_min": pause.duration_min,
        "note": pause.note,
    }


def _waitlist_out(entry) -> dict:
    return {
        "id": entry.id,
        "client_id": entry.client_id,
        "client_name": entry.client.full_name,
        "service_id": entry.service_id,
        "service_name": entry.service.name_it,
        "operator_id": entry.operator_id,
        "operator_name": _operator_name(entry.operator) if entry.operator else None,
        "preference": entry.preference,
        "exact_days": entry.exact_days,
        "exact_time": entry.exact_time,
        "status": entry.status,
        "created_at": entry.created_at,
    }


def _undo_out(entry) -> dict:
    return {
        "id": entry.id,
        "kind": entry.kind,
        "label": entry.label,
        "created_at": entry.created_at,
        "expires_at": entry.created_at
        + dt.timedelta(minutes=undo_log.UNDO_WINDOW_MINUTES),
    }


def _client_appointment_out(appointment, gifts_by_client=None) -> dict:
    return {
        "id": appointment.id,
        "start": appointment.start,
        "end": appointment.end,
        "status": appointment.status,
        "operator": {
            "id": appointment.operator_id,
            "name": _operator_name(appointment.operator),
        },
        "services": [
            {
                "service_id": item.service_id,
                "operator_id": item.operator_id,
                "name": item.service.name_it,
                "duration_min": item.duration_min,
                "price": item.price,
            }
            for item in appointment.items.all()
        ],
        "total_price": appointment.total_price,
        "deposit_status": appointment.deposit_status,
        "deposit_amount": appointment.deposit_amount,
        "deposit_due_at": appointment.deposit_due_at,
        "deposit_payment_link": appointment.deposit_payment_link or "",
        "auto_released": appointment.auto_released,
        "gifts": _gifts_out(appointment, gifts_by_client or {}),
    }
