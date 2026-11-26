"""Rotte degli appuntamenti per lo staff: creazione, spostamento, stacco, stati, caparra.

Tutti i metodi di `/appointments/{id}` stanno qui (GET e PUT): due Router con lo
stesso percorso risponderebbero 405 al secondo metodo.
"""

from ninja import Router

from apps.core.services import log_activity
from common.auth import staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from ..models import Appointment
from ..presenters import _appointment_out
from ..schemas import (
    AppointmentCreateIn,
    AppointmentHitOut,
    AppointmentImportIn,
    AppointmentImportOut,
    AppointmentOut,
    AppointmentUpdateIn,
    CancelIn,
    DepositCashedIn,
    MarginOut,
    MoveIn,
    MoveStayIn,
    MoveStayOut,
    ReasonIn,
    RestoreIn,
    SplitIn,
    SplitOut,
)
# `appointments` è anche il nome dei queryset: il modulo dei servizi si importa
# col suffisso, come negli altri moduli delle rotte.
from ..services import appointments as appointment_services
from ..services import deposit_holds, deposits, importer, margin, refunds, search, stay, transitions
from .params import _get_location

router = Router()


@router.post("/appointments", auth=staff_auth, response=AppointmentOut)
def create_appointment(request, data: AppointmentCreateIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    if data.deposit_paid is not None:
        # Una caparra già versata entra in cassa: come «Incassata» nel dettaglio.
        require_scope(ctx, "sales")

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
        deposit_paid=data.deposit_paid,
        # Il banco può affidare un servizio a un'operatrice che di solito non
        # lo fa (vedi `resolution._chain_step`); l'app cliente no.
        any_operator=True,
    )
    deposits.send_deposit_link(appointment)
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/import", auth=staff_auth, response=AppointmentImportOut)
def import_appointments(request, data: AppointmentImportIn):
    """Porta in agenda le visite esportate da un altro gestionale.

    Servizi e operatrici arrivano già abbinati a quelli del salone. Nessuna
    conferma parte verso le clienti e nessuna caparra viene chiesta: sono
    appuntamenti che loro hanno già. Ricaricare lo stesso file non li raddoppia.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    location = _get_location(ctx, data.location_id)
    result = importer.import_visits(
        ctx.salon, [visit.dict() for visit in data.visits], location=location
    )
    log_activity(
        ctx.salon,
        "appointment.imported",
        f"Import appuntamenti: {result['created']} creati, {result['duplicates']} già in agenda, "
        f"{result['skipped']} saltati",
        actor=ctx.user,
        location=location,
        payload={k: result[k] for k in ("created", "duplicates", "skipped", "clients_created")},
    )
    return result


def _move_operators(ctx, appointment, data):
    """(operatrice nuova, colonna di partenza) di uno spostamento; (None, None) senza riassegnazione.

    `active=True` vale solo per la NUOVA assegnazione. La colonna di partenza
    può essere di un'operatrice disattivata — l'agenda la mostra apposta, in
    una colonna a parte, per poterne riassegnare gli appuntamenti — e
    pretenderla attiva faceva rispondere 404 a ogni riassegnazione da lì.
    Quando l'operatrice indicata è già quella di partenza non c'è niente da
    riassegnare.
    """
    source_id = data.from_operator_id or appointment.operator_id
    if not data.operator_id or data.operator_id == source_id:
        return None, None
    from apps.staff.models import Operator  # lazy

    operator = salon_get(Operator, ctx, data.operator_id, active=True)
    from_operator = salon_get(Operator, ctx, data.from_operator_id) if data.from_operator_id else None
    return operator, from_operator


@router.post("/appointments/{int:appointment_id}/move", auth=staff_auth, response=AppointmentOut)
def move_appointment(request, appointment_id: int, data: MoveIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    operator, from_operator = _move_operators(ctx, appointment, data)
    appointment = appointment_services.move_appointment(
        appointment, data.start, operator=operator, from_operator=from_operator,
        actor=ctx.user, force=data.force, client_overlap_ok=True, any_operator=True,
    )
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/move-stay", auth=staff_auth, response=MoveStayOut)
def move_appointment_stay(request, appointment_id: int, data: MoveStayIn):
    """Sposta la visita insieme agli altri appuntamenti della sua permanenza (services.stay).

    Tutti dello stesso scarto, ognuno con la sua operatrice; si spostano solo
    quelli ancora da cominciare e non incassati. O tutti o nessuno: uno slot
    occupato (409) lascia tutto com'era, e con `force` si sposta comunque.
    `operator_id`/`from_operator_id` valgono solo per questa visita, come in /move.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    operator, from_operator = _move_operators(ctx, appointment, data)
    appointment, mates = stay.move_stay(
        appointment, data.start, operator=operator, from_operator=from_operator,
        actor=ctx.user, force=data.force,
    )
    return {"appointment": _appointment_out(appointment, viewer=ctx), "moved_ids": [a.pk for a in mates]}


@router.post("/appointments/{int:appointment_id}/split", auth=staff_auth, response=SplitOut)
def split_appointment(request, appointment_id: int, data: SplitIn):
    """Stacca un servizio da un appuntamento multi-servizio e lo sposta (anche in un altro giorno).

    Il servizio porta con sé gli aggiuntivi che gli vengono dietro (la nail art
    della manicure); un aggiuntivo da solo non si stacca (422).
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    operator = None
    if data.operator_id:
        from apps.staff.models import Operator  # lazy

        operator = salon_get(Operator, ctx, data.operator_id, active=True)
    original, created = appointment_services.split_appointment(
        appointment, data.item_id, data.start, operator=operator, actor=ctx.user, force=data.force,
        client_overlap_ok=True, item_ids=data.item_ids, any_operator=True,
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
def check_in_appointment(request, appointment_id: int, start: bool = False):
    """Check-in della cliente; con `?start=true` parte anche il trattamento,
    in un passo solo (per i centri che non distinguono l'arrivo dall'inizio
    del lavoro).

    `start` sta nell'indirizzo e non nel corpo: un corpo facoltativo vuoto la
    libreria delle API lo rifiuta («Cannot parse request body»), e il check-in
    di sempre arriva senza corpo.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(transitions.check_in(appointment, actor=ctx.user, start=start), viewer=ctx)


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


@router.post("/appointments/{int:appointment_id}/remove-from-agenda", auth=staff_auth, response=AppointmentOut)
def remove_from_agenda(request, appointment_id: int, data: ReasonIn):
    """Toglie dall'agenda un appuntamento già incassato (stato `closed`).

    La visita sparisce dalle viste dell'agenda e lo slot torna libero, ma resta
    chiusa: la vendita rimane nella cassa del giorno, nei report e nello
    storico della cliente. Nessun messaggio alla cliente. Su un appuntamento
    non ancora incassato è un 400: lì si usa `/cancel`.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(
        transitions.remove_from_agenda(appointment, reason=data.reason, actor=ctx.user), viewer=ctx
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

    Aggiuntivi (servizi `is_addon`, come la nail art durante la manicure): la
    loro voce dura 0 minuti, senza posa, qualunque durata arrivi (lo 0 è
    ammesso solo per loro), e va dopo il servizio a cui si appoggia. Una
    visita di soli aggiuntivi, o che comincia con uno, è un 422.

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
        any_operator=True,
    )
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/deposit-cashed", auth=staff_auth, response=AppointmentOut)
def deposit_cashed(request, appointment_id: int, data: DepositCashedIn):
    """La caparra è stata incassata: contanti o POS al banco, bonifico o link Nexi.

    Senza questa via l'unico modo di registrarla era il pagamento online: dove
    Stripe non è configurato — o quando la cliente paga al banco — il termine
    scadeva lo stesso e il posto si liberava da solo. Con `amount` si registra
    quanto ha versato davvero, anche dove le regole una caparra non la chiedevano.
    """
    ctx = request.auth
    require_scope(ctx, "sales")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(
        deposit_holds.mark_deposit_cashed(appointment, method=data.method, amount=data.amount, actor=ctx.user),
        viewer=ctx,
    )


@router.post("/appointments/{int:appointment_id}/deposit-refunded", auth=staff_auth, response=AppointmentOut)
def deposit_refunded(request, appointment_id: int):
    """Lo staff conferma di aver restituito una caparra «da rimborsare» (rimborso manuale)."""
    ctx = request.auth
    require_scope(ctx, "sales")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(refunds.mark_deposit_refunded(appointment, actor=ctx.user), viewer=ctx)


@router.get("/appointments/search", auth=staff_auth, response=list[AppointmentHitOut])
def search_appointments(request, q: str = ""):
    """Appuntamenti delle clienti che rispondono a `q` (nome, cognome o telefono).

    Prima quelli da oggi in poi (dal più vicino), poi i passati (dal più
    recente), al massimo 8 per parte; annullati e tolti dall'agenda esclusi.
    Con meno di 2 caratteri la lista è vuota.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    return [
        {
            "id": a.id,
            "start": a.start,
            "end": a.end,
            "status": a.status,
            "client": {"id": a.client_id, "full_name": a.client.full_name, "phone": a.client.phone},
            "operator_id": a.operator_id,
            "operator_name": a.operator.full_name,
            "services": [it.service.name_it for it in a.items.all()],
        }
        for a in search.search_appointments(ctx.salon, q)
    ]


@router.get("/appointments/{int:appointment_id}/stay", auth=staff_auth)
def appointment_stay(request, appointment_id: int):
    """La permanenza della cliente intorno a questa visita (services.stay): i suoi
    appuntamenti del giorno uno dopo l'altro, questa compresa. Il dettaglio li
    mostra («Stessa permanenza») e da lì si incassa tutto insieme; `bill_id`
    dice quali sono già stati incassati, e in quale conto.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return [
        {
            "id": a.id,
            "start": a.start,
            "end": a.end,
            "status": a.status,
            "operator_id": a.operator_id,
            "total_price": a.total_price,
            "bill_id": stay.bill_id(a),
            "items": [
                {"service_name": it.service.name_it, "operator_id": it.operator_id, "operator_name": it.operator.full_name, "duration_min": it.duration_min}
                for it in a.items.all()
            ],
        }
        for a in stay.stay_of(appointment)
    ]


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
