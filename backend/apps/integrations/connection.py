"""Collegamento salone ↔ organizzazione Yourang, comune a «Collega» e «Accedi».

Qui stanno le due regole che il collegamento deve rispettare comunque ci si
arrivi: un'org serve UN solo salone, e un salone già collegato non cambia org
senza una disconnessione esplicita. Prima il connect sovrascriveva l'org anche
su un salone collegato: un codice dell'org di un altro, riscattato con la
sessione del titolare, spingeva l'anagrafica verso quell'org e i webhook di
quella legittima finivano nel nulla.
"""

from django.apps import apps as django_apps
from django.db import IntegrityError, transaction

from .models import YourangConnection


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
