"""Collegamento salone ↔ organizzazione Yourang, comune a «Collega» e «Accedi».

Qui stanno le due regole che il collegamento deve rispettare comunque ci si
arrivi: un'org serve UN solo salone, e un salone già collegato non cambia org
senza una disconnessione esplicita. Prima il connect sovrascriveva l'org anche
su un salone collegato: un codice dell'org di un altro, riscattato con la
sessione del titolare, spingeva l'anagrafica verso quell'org e i webhook di
quella legittima finivano nel nulla.

Qui stanno anche i token e il webhook di una connessione appena collegata
(`attach_tokens`), che servono a entrambi i flussi: il connect li prendeva da
login.py.
"""

import logging

from django.apps import apps as django_apps
from django.conf import settings
from django.db import IntegrityError, transaction

from . import client as yc
from . import crypto
from .models import YourangConnection

logger = logging.getLogger("youty.integrations")

# Eventi a cui si abbona il webhook registrato su Yourang.
WEBHOOK_EVENT_TYPES = ["contact.*", "event.*"]


class OrgConflict(Exception):
    """Collegamento rifiutato: org di un altro salone, o salone di un'altra org."""


ORG_TAKEN = "Questa organizzazione Yourang è già collegata a un altro salone"
SALON_TAKEN = (
    "Il salone è già collegato a un'altra organizzazione Yourang: "
    "scollegalo dalle Impostazioni prima di collegarne una nuova"
)


def reset_remote_refs(salon) -> None:
    """Via i riferimenti remoti (contatti, voci di listino) dai record del salone.

    Appartengono all'org di prima: dopo un cambio di org ogni cliente veniva
    saltato perché «già sincronizzato» e ogni PUT catalogues/items/{id}
    rispondeva 404, cioè il listino non arrivava MAI nel catalogo nuovo. I
    modelli sono di altre app: accesso lazy, come altrove nel progetto.
    """
    django_apps.get_model("clients", "Client").objects.filter(salon=salon).exclude(
        yourang_contact_id=""
    ).update(yourang_contact_id="")
    for model_name in ("Service", "Package"):
        django_apps.get_model("catalog", model_name).objects.filter(salon=salon).exclude(
            yourang_item_id=""
        ).update(yourang_item_id="")


def link_org(salon, org: str, user) -> YourangConnection:
    """Collega il salone all'org (o conferma il collegamento con la stessa org).

    - org già servita da un altro salone → OrgConflict (il webhook risolve il
      salone dall'org: due saloni sulla stessa org si rubano le prenotazioni);
    - salone già collegato a un'org diversa → OrgConflict: si scollega prima;
    - stessa org → ricollegamento (stato e errore azzerati, riferimenti tenuti);
    - org nuova su una riga senza org (liberata dalla migrazione 0004) o su un
      salone senza riga → i riferimenti rimasti sono di un'altra org: via.
    """
    try:
        with transaction.atomic():
            if YourangConnection.objects.filter(yourang_org_id=org).exclude(salon=salon).exists():
                raise OrgConflict(ORG_TAKEN)
            conn = YourangConnection.objects.select_for_update().filter(salon=salon).first()
            if conn is not None and conn.yourang_org_id and conn.yourang_org_id != org:
                raise OrgConflict(SALON_TAKEN)
            if conn is None:
                reset_remote_refs(salon)
                return YourangConnection.objects.create(
                    salon=salon,
                    yourang_org_id=org,
                    connected_by=user,
                    status=YourangConnection.Status.CONNECTED,
                )
            fields = ["yourang_org_id", "connected_by", "status", "last_error", "updated_at"]
            if conn.yourang_org_id != org:
                reset_remote_refs(salon)
                conn.catalogue_id = ""
                fields.append("catalogue_id")
            conn.yourang_org_id = org
            conn.connected_by = user
            conn.status = YourangConnection.Status.CONNECTED
            conn.last_error = ""
            # Solo le colonne del collegamento: un salvataggio completo di questa
            # copia riscriveva anche catalogue_id e last_sync_at scritti nel
            # frattempo dal cron o da una sync in corso.
            conn.save(update_fields=fields)
            return conn
    except IntegrityError as exc:
        # Vincolo unico sull'org: un collegamento concorrente della stessa org
        # a un altro salone ha vinto la corsa fra il controllo e la scrittura.
        raise OrgConflict(ORG_TAKEN) from exc


def same_link(conn):
    """La riga di `conn`, finché è ancora collegata alla stessa org (queryset).

    La sync lunga gira fuori dalla richiesta (prima sync in background, cron):
    se intanto il titolare scollega, o ricollega un'altra org, l'esito di quel
    giro non è più suo. Per questo la sync si ferma quando la riga non c'è più
    (`sync._ensure_linked`) e scrive il suo esito con un UPDATE su questa riga,
    mai con un save() della copia letta all'inizio.
    """
    return YourangConnection.objects.filter(pk=conn.pk, yourang_org_id=conn.yourang_org_id)


def attach_tokens(conn: YourangConnection, token_resp: dict, *, renew_webhook: bool = False) -> None:
    """Token del flusso diretto sulla connessione e, se serve, il webhook.

    Fuori dalla transazione del collegamento: registrare il webhook è una
    chiamata a Yourang, e una rete lenta non deve tenere i lock del salone.
    `renew_webhook`: registrarlo anche se c'è già un segreto (il connect lo fa
    sempre, a una riconnessione il segreto di prima non vale più).
    """
    yc.store_tokens(conn, token_resp)
    fields = ["access_token_enc", "refresh_token_enc", "expires_at", "scope", "updated_at"]
    if settings.YOURANG_WEBHOOK_RECEIVER_URL and (renew_webhook or not conn.webhook_secret_enc):
        try:
            secret = yc.YourangClient(conn).register_webhook(
                settings.YOURANG_WEBHOOK_RECEIVER_URL, WEBHOOK_EVENT_TYPES
            )
            conn.webhook_secret_enc = crypto.encrypt(secret)
            fields.append("webhook_secret_enc")
        except Exception:
            logger.exception("Yourang webhook registration failed")
    conn.save(update_fields=fields)
