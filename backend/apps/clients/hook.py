"""Form pubblico di raccolta contatti (/<slug>/hook nell'app cliente).

Senza autenticazione: chi lo compila può essere chiunque. Per questo la
risposta è sempre la stessa (200, vedi `public_hook` in api.py, che fa anche
honeypot e controlli del corpo), il tetto è per IP e per salone, e una scheda
già in rubrica riceve solo i consensi e i campi vuoti, mai i dati digitati da
uno sconosciuto al posto dei suoi.
"""

import logging

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.models import SalonSettings
from apps.core.services import emit_event, log_activity
from common import ratelimit
from common.phone import find_client_by_phone

from .models import Client, ClientCategory
from .profiles import notify_marketing

logger = logging.getLogger("youty.clients")

HOOK_LABEL = "Da form"
HOOK_LABEL_COLOR = "#8B5CF6"
# Soglia per IP e per salone. Non troppo bassa: un salone che fa compilare il
# form da un tablet sul bancone, o clienti sulla stessa rete pubblica, arrivano
# tutti dallo stesso IP. Serve a fermare uno script, non a contare le persone —
# contro lo spam mirato la difesa è l'honeypot.
HOOK_MAX_PER_WINDOW = 20
HOOK_WINDOW_SECONDS = 3600


def record_lead(salon, data, *, first_name: str, phone: str, ip: str) -> None:
    """Registra il contatto del form: scheda nuova, consensi aggiornati o segnalazione.

    Qualunque cosa succeda qui l'endpoint risponde 200 (vedi `public_hook`).
    `first_name` e `phone` arrivano già ripuliti e controllati; `ip` è quello
    del chiamante (`ratelimit.client_ip`), per il tetto per IP e per salone.
    """
    # Il modulo raccoglie anche se il salone non ha configurato l'informativa:
    # bloccarlo spegnerebbe la raccolta contatti alla maggior parte dei saloni
    # attivi, ed è una decisione commerciale, non tecnica. Resta il WARNING qui
    # e l'avviso in dashboard — il consenso senza informativa da leggere è
    # debole, e chi lo raccoglie deve poterlo sapere.
    # values_list().first() e non _settings(): un endpoint pubblico non deve
    # creare righe (get_or_create) su richiesta di uno sconosciuto.
    privacy_url = (
        SalonSettings.objects.filter(salon=salon)
        .values_list("privacy_policy_url", flat=True)
        .first()
    )
    if not privacy_url:
        logger.warning(
            "hook: consenso raccolto senza informativa privacy configurata (salone=%s)", salon.slug
        )

    # Rate limit per IP, sul contatore condiviso di common.ratelimit: è una
    # UPDATE atomica sul database, mentre il vecchio leggi-poi-scrivi sulla
    # cache lasciava passare un flood in parallelo contandolo come una
    # richiesta sola (ogni richiesta qui crea una scheda e un evento).
    key = f"hook:{salon.id}:{ip}"
    if not ratelimit.hit(key, HOOK_MAX_PER_WINDOW, HOOK_WINDOW_SECONDS):
        logger.warning("hook: rate limit superato per %s", key)
        return

    now = timezone.now().isoformat()
    client = find_client_by_phone(salon, phone)

    if client is None:
        try:
            with transaction.atomic():
                lang = (data.lang or "").strip().lower()
                client = Client.objects.create(
                    salon=salon,
                    first_name=first_name,
                    last_name=data.last_name.strip(),
                    phone=phone,
                    email=data.email.strip(),
                    lang=lang if lang in Client.Lang.values else Client.Lang.IT,
                    origin="hook",
                    since=timezone.localdate(),
                    consents={
                        "privacy": True,
                        "privacy_at": now,
                        "marketing": bool(data.marketing),
                        "marketing_at": now if data.marketing else "",
                        "card_charge": False,
                    },
                )
        except IntegrityError:
            # Doppio tocco su «Invia», o due invii in parallelo: il controllo
            # qui sopra non è atomico, il vincolo di unicità sì. Si riprende la
            # scheda appena nata e si prosegue come per chi è già in rubrica —
            # questo endpoint risponde 200 in ogni caso, un 500 racconterebbe a
            # uno sconosciuto che quel numero è cliente del salone.
            client = find_client_by_phone(salon, phone)
            if client is None:
                logger.warning(
                    "hook: creazione rifiutata e scheda non ritrovata (salone=%s)", salon.slug
                )
                return
        else:
            mark_as_hook_lead(salon, client)
            return

    if not client.is_active:
        # Scheda archiviata dallo staff: il modulo la riattivava da solo, con un
        # consenso marketing «fresco» dato da chiunque conoscesse nome e numero
        # — anche la cliente tolta di proposito, o chi ha chiesto di non
        # essere più contattata (10-15). Non si tocca: il salone riceve la
        # segnalazione e decide, come quando la stessa persona prova a entrare
        # dall'app (accounts). Il numero può essere passato a un'altra persona.
        notify_archived_client(salon, client)
        return

    # Cliente già in rubrica: si aggiornano i consensi (è il senso del form) e
    # si riempiono solo i campi vuoti. Sovrascrivere nome o email con quanto
    # digitato da uno sconosciuto rovinerebbe una scheda reale, e l'etichetta
    # "Da form" non va messa a chi è già cliente.
    stored = client.consents or {}
    marketing_before = bool(stored.get("marketing"))
    client.consents = {
        **stored,
        "privacy": True,
        "privacy_at": now,
        "marketing": bool(data.marketing) or marketing_before,
        "marketing_at": now if data.marketing else stored.get("marketing_at", ""),
    }
    if data.marketing:
        client.consents.pop("marketing_revoked_at", None)
    fields = ["consents"]
    if not client.email and data.email.strip():
        client.email = data.email.strip()
        fields.append("email")
    if not client.last_name and data.last_name.strip():
        client.last_name = data.last_name.strip()
        fields.append("last_name")
    client.save(update_fields=fields)
    if bool(client.consents["marketing"]) != marketing_before:
        # Consenso ridato dopo una revoca: Yourang deve togliere il blocco.
        notify_marketing("marketing_consent_changed", client, accepted=True)
    # Con il suo id la scheda aperta in dashboard si ricarica: senza, la
    # reception continuava a vedere i consensi di prima (06-10).
    log_activity(
        salon,
        "client.updated",
        f"Consensi aggiornati dal form: {client.full_name}",
        payload={"client_id": client.id, "fields": fields},
    )


# Una segnalazione al giorno per scheda archiviata. La chiave è la stessa
# delle segnalazioni dell'accesso dall'app (accounts, «archived-notice:<id>»):
# app e modulo nello stesso giorno sono un avviso solo.
ARCHIVED_NOTICE_WINDOW_SECONDS = 24 * 3600


def notify_archived_client(salon, client: Client) -> None:
    """Segnala al salone (feed, scope clienti) la scheda archiviata che si è fatta viva."""
    if not ratelimit.hit(f"archived-notice:{client.id}", 1, ARCHIVED_NOTICE_WINDOW_SECONDS):
        return
    log_activity(
        salon,
        "client.reactivation_requested",
        f"{client.full_name}: scheda archiviata, ha compilato il modulo contatti. "
        "Riattivala se vuoi che entri.",
        payload={"client_id": client.id, "source": "hook"},
    )


def mark_as_hook_lead(salon, client: Client) -> None:
    """Etichetta «Da form», evento SSE e registro: la scheda è un lead nuovo."""
    # Senza badare alle maiuscole, come le etichette scritte dal gestionale
    # (`label_payload`) e dall'import: con «da form» già nel salone, creata o
    # rinominata dal titolare, `get_or_create` sul nome esatto ne creava una
    # seconda «Da form» (il vincolo del database distingue le maiuscole) e i
    # contatti nuovi finivano lì (voce 22 dei bug sospetti del 24/09). Se le due
    # copie ci sono già, si resta su «Da form», dove sono i contatti di prima.
    label = (
        ClientCategory.objects.filter(salon=salon, name=HOOK_LABEL).first()
        or ClientCategory.objects.filter(salon=salon, name__iexact=HOOK_LABEL).order_by("id").first()
    )
    if label is None:
        label, _ = ClientCategory.objects.get_or_create(
            salon=salon, name=HOOK_LABEL, defaults={"color": HOOK_LABEL_COLOR}
        )
    client.categories.add(label)
    emit_event(
        salon,
        "client.created",
        {"client_id": client.id, "name": client.full_name, "phone": client.phone, "source": "hook"},
    )
    log_activity(salon, "client.created", f"Contatto dal form: {client.full_name}")
