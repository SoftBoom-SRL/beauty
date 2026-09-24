"""Servizi marketing: gift card, coupon, fedeltà, comunicazioni.

`create_gift_card`, `redeem_gift_card`, `accrue_loyalty`, `validate_coupon`,
`coupon_discount` e `mark_coupon_redeemed` sono API interne chiamate anche da
apps.sales.finalize_sale (import lazy lato sales): le firme NON vanno cambiate.
"""

from django.apps import apps as django_apps
from django.db import transaction

from apps.core.services import emit_event

# compat refactoring: rimuovere dopo l'integrazione — i nomi spostati nei
# moduli nuovi restano importabili da qui finché i chiamanti non puntano a loro.
from .codes import unique_code  # noqa: F401
from .coupons import coupon_discount, mark_coupon_redeemed, validate_coupon  # noqa: F401
from .gift_cards import create_gift_card, redeem_gift_card  # noqa: F401
from .communications import (  # noqa: F401
    CANCEL_EVENT,
    SEND_EVENT,
    cancel_pending_send,
    send_communication,
    settle_due_communications,
)
from .loyalty import MAX_REWARDS_PER_SALE, accrue_loyalty  # noqa: F401

# ---- Comunicazioni -----------------------------------------------------------

# Consenso marketing cambiato: {client_id, phone, lang, marketing}. Con
# marketing=false Yourang toglie la cliente anche dagli invii che ha già.
CONSENT_EVENT = "client.marketing_consent"


def drop_from_pending_sends(client) -> int:
    """Toglie la cliente dagli invii marketing non ancora consegnati (07-03).

    I destinatari si fissano quando si preme «Programma»: la cliente che
    revocava il consenso il martedì riceveva comunque il sabato la promozione
    programmata il lunedì (GDPR art. 7.3). Si riscrivono tutti gli invii
    ancora in coda, anche quelli in attesa di un ritentativo: se il primo
    tentativo era arrivato, Yourang scarta il ritentativo per la sua
    Idempotency-Key e togliere un destinatario non cambia niente; se non era
    arrivato, parte senza di lei. Quello che Yourang ha già in mano lo copre
    CONSENT_EVENT. Ritorna quanti invii sono stati toccati.
    """
    OutboxEvent = django_apps.get_model("core", "OutboxEvent")  # lazy: evita cicli
    touched = 0
    with transaction.atomic():
        # Sotto lock: il worker che prende in carico l'evento aspetta la
        # riscrittura, oppure l'ha già preso e qui non compare più.
        events = OutboxEvent.objects.select_for_update().filter(
            salon_id=client.salon_id,
            event_type=SEND_EVENT,
            status=OutboxEvent.Status.PENDING,
        )
        for event in events:
            payload = dict(event.payload or {})
            ids = payload.get("client_ids") or []
            if client.id not in ids:
                continue
            payload["client_ids"] = [cid for cid in ids if cid != client.id]
            langs = dict(payload.get("langs") or {})
            langs.pop(str(client.id), None)
            payload["langs"] = langs
            event.payload = payload
            event.save(update_fields=["payload"])
            touched += 1
    return touched


def marketing_consent_changed(client, accepted: bool) -> None:
    """Da chiamare dopo aver salvato il consenso marketing di una cliente.

    La revoca vale anche per ciò che è già in coda: la cliente esce dagli invii
    non ancora partiti, e Yourang riceve CONSENT_EVENT per quelli che ha già in
    mano. Anche il consenso ridato si notifica, così Yourang toglie il blocco.
    """
    if not accepted:
        drop_from_pending_sends(client)
    emit_event(
        client.salon,
        CONSENT_EVENT,
        {
            "client_id": client.id,
            "phone": client.phone,
            "lang": client.lang,
            "marketing": bool(accepted),
        },
    )


