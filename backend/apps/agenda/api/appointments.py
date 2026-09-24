"""Rotte degli appuntamenti per lo staff: creazione, spostamento, stacco, stati, caparra.

Tutti i metodi di `/appointments/{id}` stanno qui (GET e PUT): due Router con lo
stesso percorso risponderebbero 405 al secondo metodo.
"""

from ninja import Router

from common.auth import staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from ..models import Appointment
from ..presenters import _appointment_out
from ..schemas import (
    AppointmentCreateIn,
    AppointmentOut,
    AppointmentUpdateIn,
    CancelIn,
    DepositCashedIn,
    MarginOut,
    MoveIn,
    ReasonIn,
    RestoreIn,
    SplitIn,
    SplitOut,
)
# `appointments` è anche il nome dei queryset: il modulo dei servizi si importa
# col suffisso, come negli altri moduli delle rotte.
from ..services import appointments as appointment_services
from ..services import deposit_holds, deposits, margin, refunds, transitions
from .params import _get_location

router = Router()


@router.post("/appointments", auth=staff_auth, response=AppointmentOut)
def create_appointment(request, data: AppointmentCreateIn):
    ctx = request.auth
    require_scope(ctx, "agenda")

    from apps.clients.models import Client  # lazy

    client = salon_get(Client, ctx, data.client_id, is_active=True)
    appointment = appointment_services.create_appointment(
        ctx.salon,
        client,
        [item.dict() for item in data.items],
        data.start,
        via=Appointment.CreatedVia.DASHBOARD,
        actor=ctx.user,
        flexible=data.flexible,
        note=data.note,
        location=_get_location(ctx, data.location_id),
        force=data.force,
        client_overlap_ok=True,
    )
    deposits.send_deposit_link(appointment)
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/move", auth=staff_auth, response=AppointmentOut)
def move_appointment(request, appointment_id: int, data: MoveIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)

    operator = None
    from_operator = None
    # `active=True` vale solo per la NUOVA assegnazione. La colonna di partenza
    # può essere di un'operatrice disattivata — l'agenda la mostra apposta, in
    # una colonna a parte, per poterne riassegnare gli appuntamenti — e
    # pretenderla attiva faceva rispondere 404 a ogni riassegnazione da lì.
    # Quando l'operatrice indicata è già quella di partenza non c'è niente da
    # riassegnare.
    source_id = data.from_operator_id or appointment.operator_id
    if data.operator_id and data.operator_id != source_id:
        from apps.staff.models import Operator  # lazy

        operator = salon_get(Operator, ctx, data.operator_id, active=True)
        if data.from_operator_id:
            from_operator = salon_get(Operator, ctx, data.from_operator_id)
    appointment = appointment_services.move_appointment(
        appointment, data.start, operator=operator, from_operator=from_operator,
        actor=ctx.user, force=data.force, client_overlap_ok=True,
    )
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/split", auth=staff_auth, response=SplitOut)
def split_appointment(request, appointment_id: int, data: SplitIn):
    """Stacca un servizio da un appuntamento multi-servizio e lo sposta (anche in un altro giorno)."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    operator = None
    if data.operator_id:
        from apps.staff.models import Operator  # lazy

        operator = salon_get(Operator, ctx, data.operator_id, active=True)
    original, created = appointment_services.split_appointment(
        appointment, data.item_id, data.start, operator=operator, actor=ctx.user, force=data.force,
        client_overlap_ok=True,
    )
    return {
        "original": _appointment_out(original, viewer=ctx),
        "created": _appointment_out(created, viewer=ctx),
    }


@router.post("/appointments/{int:appointment_id}/restore", auth=staff_auth, response=AppointmentOut)
def restore_appointment(request, appointment_id: int, data: RestoreIn):
    """Rimette in agenda un appuntamento liberato per caparra non pagata."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    appointment = deposit_holds.restore_released(appointment, actor=ctx.user, force=data.force)
    deposits.send_deposit_link(appointment)
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/check-in", auth=staff_auth, response=AppointmentOut)
def check_in_appointment(request, appointment_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(transitions.check_in(appointment, actor=ctx.user), viewer=ctx)


@router.post("/appointments/{int:appointment_id}/start", auth=staff_auth, response=AppointmentOut)
def start_appointment(request, appointment_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(transitions.start_appointment(appointment, actor=ctx.user), viewer=ctx)


@router.post("/appointments/{int:appointment_id}/no-show", auth=staff_auth, response=AppointmentOut)
def no_show_appointment(request, appointment_id: int, data: ReasonIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(
        transitions.mark_no_show(appointment, reason=data.reason, actor=ctx.user), viewer=ctx
    )


@router.post("/appointments/{int:appointment_id}/cancel", auth=staff_auth, response=AppointmentOut)
def cancel_appointment(request, appointment_id: int, data: CancelIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    # Di norma annulla il salone: nessuna penale, la caparra torna indietro.
    # Con `by_client` la reception registra la disdetta della cliente, con le
    # regole dell'app; resta un gesto della postazione, quindi si può disfare.
    return _appointment_out(
        transitions.cancel_appointment(
            appointment,
            reason=data.reason,
            actor=ctx.user,
            by_client=data.by_client,
            undoable=True,
        ),
        viewer=ctx,
    )


@router.put("/appointments/{int:appointment_id}", auth=staff_auth, response=AppointmentOut)
def update_appointment(request, appointment_id: int, data: AppointmentUpdateIn):
    """Modifica trattamenti e/o nota dell'appuntamento.

    `items` (se presente) è la lista COMPLETA dei servizi desiderati a partire
    da `appointment.start`: aggiungere un servizio = includere una voce senza
    `id`, rimuoverne uno = ometterlo. Ogni voce può forzare `duration_min`
    (da 1 a 720 minuti); se assente vale la durata già sulla visita (o quella
    di listino per le voci nuove). Prezzo e posa delle voci esistenti restano
    quelli concordati con la cliente. Il deposito non si ricalcola: si riduce
    soltanto se la visita è scesa sotto la caparra.

    `force=True`: si prova comunque a scrivere anche se in quella fascia
    l'operatrice risulta occupata o la visita sfora la chiusura (allungare un
    trattamento accanto a un incastro già forzato). L'idoneità al servizio
    resta un limite invalicabile.

    `expected_updated_at` (l'`updated_at` della copia da cui si parte) e gli
    `id` delle voci proteggono dalle copie vecchie: se la visita è cambiata nel
    frattempo, o un id non è più una sua riga, 412 «ricarica e riprova» — mai
    superato da `force`.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    appointment = appointment_services.edit_appointment(
        appointment,
        items=[item.dict() for item in data.items] if data.items is not None else None,
        note=data.note,
        force=data.force,
        actor=ctx.user,
        expected_updated_at=data.expected_updated_at,
        client_overlap_ok=True,
    )
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/deposit-cashed", auth=staff_auth, response=AppointmentOut)
def deposit_cashed(request, appointment_id: int, data: DepositCashedIn):
    """La caparra è stata incassata in salone (contanti o POS al banco).

    Senza questa via l'unico modo di registrarla era il pagamento online: dove
    Stripe non è configurato — o quando la cliente paga al banco — il termine
    scadeva lo stesso e il posto si liberava da solo.
    """
    ctx = request.auth
    require_scope(ctx, "sales")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(
        deposit_holds.mark_deposit_cashed(appointment, method=data.method, actor=ctx.user),
        viewer=ctx,
    )


@router.post("/appointments/{int:appointment_id}/deposit-refunded", auth=staff_auth, response=AppointmentOut)
def deposit_refunded(request, appointment_id: int):
    """Lo staff conferma di aver restituito una caparra «da rimborsare» (rimborso manuale)."""
    ctx = request.auth
    require_scope(ctx, "sales")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(refunds.mark_deposit_refunded(appointment, actor=ctx.user), viewer=ctx)


@router.get("/appointments/{int:appointment_id}/margin", auth=staff_auth, response=MarginOut)
def appointment_margin(request, appointment_id: int):
    """Stima margine: ricavi meno costi fornitore/prodotto (listino corrente) e manodopera."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return margin.appointment_margin(appointment)


# Registrato DOPO le rotte con suffisso letterale (/move, /check-in, .../margin)
# così non le oscura: tutte usano il converter {int:...} e Ninja matcha per
# ordine di registrazione.
@router.get("/appointments/{int:appointment_id}", auth=staff_auth, response=AppointmentOut)
def get_appointment(request, appointment_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(appointment, viewer=ctx)
