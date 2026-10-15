"""Scheda cliente: creazione, modifica e archiviazione, con le regole sul telefono.

Il numero è unico per salone comunque sia scritto, e una scheda archiviata con
quel numero non si riattiva né si duplica da sola: `phone_holder` la
restituisce e il chiamante la indica (409 alla creazione, 400 in modifica).
Il numero di una scheda attiva si può usare come contatto: la nuova scheda
resta senza telefono e passa da lei (`resolve_contact`, «si contatta
tramite»). Consenso marketing cambiato e scheda disattivata si segnalano al
marketing (`notify_marketing`). api.py controlla i permessi, legge la scheda
del salone e sceglie la risposta.
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
from .search import name_key

logger = logging.getLogger("youty.clients")

DUPLICATE_PHONE = "Telefono già registrato per un altro cliente"


def archived_phone_message(holder: Client, *, creating: bool = True) -> str:
    if creating:
        return (
            f"Il numero è di una scheda archiviata: {holder.full_name}. "
            "Riattivala invece di crearne un'altra."
        )
    return f"Il numero è già di una scheda archiviata: {holder.full_name}."


def phone_holder(ctx, phone: str, *, exclude_id: Optional[int] = None) -> Optional[Client]:
    """La scheda del salone che ha già questo numero, comunque sia scritto (+39 / spazi / 0039).

    Attiva o archiviata: il chiamante decide come indicarla. None se il
    numero è libero, o vuoto (le schede senza numero sono tante e nessuna
    «ha» il numero vuoto).
    """
    if not (phone or "").strip():
        return None
    return find_client_by_phone(ctx.salon, phone, exclude_id=exclude_id)


def contact_allowed(holder: Client, client: Optional[Client] = None) -> bool:
    """`holder` (che ha il numero) può fare da contatto a `client` (None = scheda nuova)?

    Le stesse regole di `resolve_contact`: lo diciamo prima, così la dashboard
    offre «Usa il numero di Laura come contatto» solo quando poi funziona.
    """
    if not holder.is_active or not holder.phone or holder.contact_client_id:
        return False
    if client is None:
        return True
    return holder.id != client.id and not client.dependents.exists()


def resolve_contact(ctx, contact_id: Optional[int], client: Optional[Client] = None) -> Optional[Client]:
    """La scheda indicata come «si contatta tramite», controllata. None = nessun contatto.

    Un livello solo, come legge `Client.contact_phone`: chi fa da contatto ha
    un numero suo e non passa a sua volta da un'altra, e chi passa da un'altra
    non fa da contatto a nessuno. Con una catena (la nonna tramite la figlia
    che passa dalla nipote) i messaggi della nonna andrebbero a un numero
    vuoto senza che nessuno se ne accorga. `client` è la scheda che si sta
    modificando (None alla creazione).
    """
    if contact_id is None:
        return None
    contact = Client.objects.filter(salon=ctx.salon, pk=contact_id).first()
    if contact is None:
        raise HttpError(400, "La cliente scelta come contatto non esiste")
    if client is not None and contact.id == client.id:
        raise HttpError(400, "Una cliente non può fare da contatto a sé stessa")
    if not contact.is_active:
        raise HttpError(400, f"{contact.full_name} è archiviata: non può fare da contatto")
    if not contact.phone:
        raise HttpError(400, f"{contact.full_name} non ha un numero suo: non può fare da contatto")
    if contact.contact_client_id:
        raise HttpError(
            400,
            f"{contact.full_name} si contatta a sua volta tramite un'altra cliente: "
            "scegli direttamente chi ha il numero",
        )
    if client is not None and client.dependents.exists():
        raise HttpError(
            400,
            f"{client.full_name} fa già da contatto per altre clienti: non può passare a sua volta da un'altra",
        )
    return contact


def dependent_named(holder: Client, first_name: str, last_name: str = "") -> Optional[Client]:
    """La scheda attiva che si contatta tramite `holder` e ha questo nome, se c'è.

    La mamma prenota per la figlia (da Yourang, al telefono con l'agente
    vocale) e il numero della prenotazione è il suo: il nome dice per chi è.
    Solo un nome uguale (senza ordine, accenti, maiuscole: `name_key`); in
    ogni altro caso la prenotazione resta a chi ha il numero, come prima.
    """
    key = name_key(first_name, last_name)
    if not key or name_key(holder.first_name, holder.last_name) == key:
        return None
    for dependent in holder.dependents.filter(is_active=True).order_by("id"):
        if name_key(dependent.first_name, dependent.last_name) == key:
            return dependent
    return None


def _apply_contact(ctx, payload: dict, client: Optional[Client] = None) -> None:
    """`contact_client_id` del corpo → id controllato (o None), in `payload`."""
    if "contact_client_id" in payload:
        contact = resolve_contact(ctx, payload["contact_client_id"], client)
        payload["contact_client_id"] = contact.id if contact else None


def create_profile(ctx, payload: dict, category_ids: Optional[list[int]]) -> Client:
    """Crea la scheda dal corpo già controllato (`client_payload`, `phone_holder`)."""
    _apply_contact(ctx, payload)
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
        if payload.get("contact_client_id") != client.contact_client_id:
            _apply_contact(ctx, payload, client)
        if "phone" in payload and not payload["phone"] and client.phone:
            # Chi fa da contatto deve avere un numero: senza, conferme e
            # promemoria della figlia partirebbero verso il vuoto.
            names = [d.full_name for d in client.dependents.order_by("first_name", "last_name", "id")[:3]]
            if names:
                raise HttpError(
                    400,
                    f"{client.full_name} fa da contatto per {', '.join(names)}: "
                    "il numero non si può togliere finché sono collegate",
                )
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


def archive_profile(ctx, client: Client) -> list[Client]:
    """Disattiva la scheda (resta in archivio con il suo storico) e la toglie dagli invii.

    Chi si contattava tramite lei perde il collegamento, come farebbe il
    SET_NULL della chiave se la scheda sparisse davvero: una scheda archiviata
    può non essere più cliente, e il suo numero passare a un'altra persona, a
    cui arriverebbero i promemoria della figlia. Ritorna le schede scollegate,
    che il chiamante dice a chi archivia (restano senza numero di contatto).
    """
    with transaction.atomic():
        client.is_active = False
        client.save(update_fields=["is_active"])
        unlinked = list(client.dependents.order_by("first_name", "last_name", "id"))
        payload = {"client_id": client.id}
        if unlinked:
            Client.objects.filter(contact_client=client).update(contact_client=None)
            payload["unlinked_dependents"] = [d.id for d in unlinked]
        log_activity(
            ctx.salon,
            "client.deleted",
            f"Cliente disattivato: {client.full_name}",
            actor=ctx.user,
            payload=payload,
        )
        for dependent in unlinked:
            dependent.contact_client = None
            # La scheda della figlia aperta altrove si rilegge (e non dice più «tramite»).
            log_activity(
                ctx.salon,
                "client.updated",
                f"{dependent.full_name} non si contatta più tramite {client.full_name} (archiviata)",
                actor=ctx.user,
                payload={"client_id": dependent.id, "fields": ["contact_client_id"]},
            )
        # Archiviata = fuori anche dagli invii marketing non ancora partiti (07-03).
        notify_marketing("drop_from_pending_sends", client)
    return unlinked


def notify_marketing(name: str, *args, **kwargs) -> None:
    """Chiama `apps.marketing.consent.<name>`, se c'è.

    Le due funzioni (marketing_consent_changed, drop_from_pending_sends)
    appartengono al marketing: un'installazione che non le ha ancora non deve
    perdere il salvataggio della scheda, ma deve lasciarne traccia nei log.
    Si cercano a ogni chiamata: i test le sostituiscono o le tolgono dal modulo.
    """
    from apps.marketing import consent as marketing_consent  # lazy: evita cicli

    try:
        hook = getattr(marketing_consent, name)
    except AttributeError:
        logger.warning("clients: apps.marketing.consent.%s non disponibile", name)
        return
    hook(*args, **kwargs)
