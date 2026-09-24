"""Scheda cliente: creazione, modifica e archiviazione, con le regole sul telefono.

Il numero è unico per salone comunque sia scritto, e una scheda archiviata con
quel numero non si riattiva né si duplica da sola: `check_phone_unique` la
restituisce e il chiamante la indica (409 alla creazione, 400 in modifica).
Consenso marketing cambiato e scheda disattivata si segnalano al marketing
(`notify_marketing`). api.py controlla i permessi, legge la scheda del salone
e sceglie la risposta.
"""

import logging
from typing import Optional

from django.db import IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import log_activity
from common.phone import find_client_by_phone

from .fields import stamped_consents
from .labels import set_categories
from .models import Client, default_consents

logger = logging.getLogger("youty.clients")

DUPLICATE_PHONE = "Telefono già registrato per un altro cliente"


def archived_phone_message(holder: Client, *, creating: bool = True) -> str:
    if creating:
        return (
            f"Il numero è di una scheda archiviata: {holder.full_name}. "
            "Riattivala invece di crearne un'altra."
        )
    return f"Il numero è già di una scheda archiviata: {holder.full_name}."


def check_phone_unique(ctx, phone: str, *, exclude_id: Optional[int] = None) -> Optional[Client]:
    """Il numero è unico per salone comunque sia scritto (+39 / spazi / 0039).

    Ritorna la scheda ARCHIVIATA che ha già quel numero (il chiamante decide
    come indicarla), solleva 400 se il numero è di una scheda attiva.
    """
    holder = find_client_by_phone(ctx.salon, phone, exclude_id=exclude_id)
    if holder is None:
        return None
    if not holder.is_active:
        return holder
    raise HttpError(400, DUPLICATE_PHONE)


def create_profile(ctx, payload: dict, category_ids: Optional[list[int]]) -> Client:
    """Crea la scheda dal corpo già controllato (`client_payload`, `check_phone_unique`)."""
    # Le date dei consensi le scrive il server, come sul PUT (14-14).
    payload["consents"] = stamped_consents(default_consents(), payload.get("consents") or {})
    if not payload.get("since"):
        # Cliente dal giorno in cui è entrata in rubrica. Nessuna via di
        # creazione la valorizzava e il KPI «nuovi clienti» restava a zero per
        # sempre; chi importa uno storico può sempre correggerla dopo.
        payload["since"] = timezone.localdate()
    try:
        with transaction.atomic():
            client = Client.objects.create(salon=ctx.salon, **payload)
    except IntegrityError:
        # Il controllo di `check_phone_unique` non è atomico: due salvataggi
        # simultanei dello stesso numero lo superano entrambi e a fermarli è il
        # vincolo del database. Meglio il 400 «già registrato» di un 500 sulla
        # violazione.
        raise HttpError(400, DUPLICATE_PHONE)
    set_categories(client, category_ids or [])
    log_activity(
        ctx.salon,
        "client.created",
        f"Cliente creato: {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id},
    )
    return client


def update_profile(ctx, client: Client, payload: dict, category_ids: Optional[list[int]]) -> Client:
    """Applica il corpo del PUT alla scheda riletta sotto lock; scrive solo le colonne cambiate.

    Ritorna la scheda riletta. Il consenso marketing che cambia e la scheda
    disattivata si segnalano al marketing dentro la stessa transazione.
    """
    with transaction.atomic():
        # Riletta sotto lock: i consensi si fondono con quelli salvati, e una
        # revoca arrivata dall'app un istante prima non deve tornare indietro.
        client = Client.objects.select_for_update().get(pk=client.pk)
        marketing_before = bool((client.consents or {}).get("marketing"))
        if "consents" in payload:
            payload["consents"] = stamped_consents(client.consents, payload["consents"])
        changed = [name for name, value in payload.items() if getattr(client, name) != value]
        for name in changed:
            setattr(client, name, payload[name])
        if changed:
            try:
                with transaction.atomic():
                    client.save(update_fields=changed)
            except IntegrityError:
                raise HttpError(400, DUPLICATE_PHONE)
        if category_ids is not None and set_categories(client, category_ids):
            changed.append("category_ids")
        if changed:
            reactivated = "is_active" in changed and client.is_active
            log_activity(
                ctx.salon,
                "client.updated",
                f"Cliente {'riattivato' if reactivated else 'aggiornato'}: {client.full_name}",
                actor=ctx.user,
                payload={"client_id": client.id, "fields": changed},
            )
        # Il consenso marketing tolto dalla scheda vale anche per le campagne
        # già programmate, e una scheda disattivata esce dagli invii in coda
        # (07-03, GDPR art. 7.3): la destinataria fissata al «Programma» di
        # lunedì riceveva comunque la promozione di sabato.
        marketing_after = bool((client.consents or {}).get("marketing"))
        if marketing_after != marketing_before:
            notify_marketing("marketing_consent_changed", client, accepted=marketing_after)
        if payload.get("is_active") is False:
            notify_marketing("drop_from_pending_sends", client)
    return client


def archive_profile(ctx, client: Client) -> None:
    """Disattiva la scheda (resta in archivio con il suo storico) e la toglie dagli invii."""
    with transaction.atomic():
        client.is_active = False
        client.save(update_fields=["is_active"])
        log_activity(
            ctx.salon,
            "client.deleted",
            f"Cliente disattivato: {client.full_name}",
            actor=ctx.user,
            payload={"client_id": client.id},
        )
        # Archiviata = fuori anche dagli invii marketing non ancora partiti (07-03).
        notify_marketing("drop_from_pending_sends", client)


def notify_marketing(name: str, *args, **kwargs) -> None:
    """Chiama `apps.marketing.services.<name>`, se c'è.

    Le due funzioni (marketing_consent_changed, drop_from_pending_sends)
    appartengono al marketing: un'installazione che non le ha ancora non deve
    perdere il salvataggio della scheda, ma deve lasciarne traccia nei log.
    Si cercano a ogni chiamata: i test le sostituiscono o le tolgono dal modulo.
    """
    from apps.marketing import services as marketing_services  # lazy: evita cicli

    try:
        hook = getattr(marketing_services, name)
    except AttributeError:
        logger.warning("clients: apps.marketing.services.%s non disponibile", name)
        return
    hook(*args, **kwargs)
