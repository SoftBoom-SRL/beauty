"""Consenso marketing: registrarlo quando la cliente lo dà o lo revoca, e farlo valere sugli invii.

La revoca vale anche per quello che è già in coda (GDPR art. 7.3): la
cliente esce dagli invii non ancora partiti e Yourang riceve CONSENT_EVENT per
quelli che ha già in mano. La scheda cliente (clients) chiama
`marketing_consent_changed` e `drop_from_pending_sends` attraverso
`apps.marketing.services`, che li ri-esporta. Stava in services.py e, per la
registrazione dall'app, dentro l'endpoint di api.py.
"""

from django.db import transaction
from django.utils import timezone

from apps.core.models import OutboxEvent
from apps.core.services import emit_event, log_activity

from .communications import SEND_EVENT

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


def record_marketing_consent(salon, client, accepted: bool) -> None:
    """La cliente dà o revoca il consenso marketing dall'app: lo si scrive con la data e lo si notifica."""
    now = timezone.now().isoformat()
    consents = dict(client.consents or {})
    was_accepted = bool(consents.get("marketing"))
    consents["marketing"] = bool(accepted)
    # Si tiene traccia di QUANDO: il consenso va dimostrato, e la revoca pure.
    if accepted:
        consents["marketing_at"] = now
        consents.pop("marketing_revoked_at", None)
    else:
        consents["marketing_revoked_at"] = now
        consents["marketing_at"] = ""
    client.consents = consents
    client.save(update_fields=["consents"])
    # La revoca vale anche per le campagne già programmate o in coda (07-03):
    # si ripete a ogni revoca, perché la cliente può essere finita in un invio
    # anche quando il consenso era stato tolto da un'altra parte.
    if not accepted or not was_accepted:
        marketing_consent_changed(client, bool(accepted))
    log_activity(
        salon,
        "client.consent_updated",
        f"{client.full_name}: consenso marketing "
        + ("concesso" if accepted else "revocato"),
        payload={"client_id": client.id, "marketing": bool(accepted)},
    )
