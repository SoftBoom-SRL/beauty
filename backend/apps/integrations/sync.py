"""Sync fra il salone e Yourang: Clienti↔Contatti, Servizi/Pacchetti→Catalogo,
Appuntamenti↔Eventi.

Chiave naturale condivisa per i contatti = telefono in E.164 (l'external API
Yourang impone il telefono univoco per org e offre le rotte `by-phone`
idempotenti). I servizi vengono spinti in un unico catalogo per salone.
"""

import hashlib
import logging
import threading
from dataclasses import dataclass, field

import httpx
from django.db import IntegrityError, transaction
from django.db import connection as db_connection
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.agenda.models import Appointment, AppointmentService
from apps.agenda.services import (
    appointment_event_key,
    free_slot_event,
    lock_salon,
    settle_deposit_refund,
)
from apps.catalog.models import Package, Service, ServiceCategory
from apps.clients.models import Client
from apps.core.services import held_events, log_activity, supersede_events
from apps.staff.models import Operator

from .client import YourangClient
from .models import YourangConnection, YourangEventSync

# Stati evento Yourang (EventStatusEnum, uppercase) → stato Appointment beauty.
_EVENT_STATUS = {
    "confirmed": Appointment.Status.CONFIRMED,
    "approved": Appointment.Status.CONFIRMED,
    "pending": Appointment.Status.CONFIRMED,
    "completed": Appointment.Status.CLOSED,
    "closed": Appointment.Status.CLOSED,
    "no_show": Appointment.Status.NO_SHOW,
    "noshow": Appointment.Status.NO_SHOW,
    "cancelled": Appointment.Status.CANCELLED,
    "canceled": Appointment.Status.CANCELLED,
    "rejected": Appointment.Status.CANCELLED,
    "pending_deletion": Appointment.Status.CANCELLED,
}

# Su un appuntamento GIÀ importato lo stato remoto conta solo per annullare
# un confermato. Yourang conosce confermato/annullato; check-in, servizio in
# corso, conto chiuso e no-show li decide il salone davanti alla cliente. Una
# scala che metteva no-show/chiuso/annullato sopra check-in e «in corso»
# lasciava a Yourang chiudere la visita di una cliente in poltrona: a fine
# servizio la cassa rifiutava l'incasso (no-show) o l'agenda la mostrava chiusa
# senza vendita e senza «Incassa» (11-03). Un «completed» remoto chiudeva allo
# stesso modo anche un confermato non ancora incassato.

# Tetto di pagine sui contatti: un proxy che ignora `offset` rimanderebbe
# all'infinito la stessa pagina e il webhook resterebbe appeso per sempre.
MAX_CONTACT_PAGES = 200

# Nome del servizio segnaposto delle prenotazioni importate (non è un servizio
# del listino: esiste solo perché un evento Yourang non porta un servizio nostro).
PLACEHOLDER_SERVICE_NAME = "Prenotazione Yourang"

logger = logging.getLogger("youty.integrations")


# La normalizzazione dei numeri (E.164, regole sullo 0 interurbano) vive in
# common.phone: è la stessa usata da login, registrazione, form pubblico e
# import CSV, così il telefono che è la chiave naturale dei contatti Yourang
# coincide con quello con cui il cliente accede all'app.
from common.phone import (  # noqa: E402,F401
    COUNTRY_CODES,
    TRUNK_ZERO_KEPT,
    _drop_trunk_zero,
    find_client_by_phone,
    normalize_phone,
    phone_key,
)


def _split_name(full: str) -> tuple[str, str]:
    parts = (full or "").strip().split()
    if not parts:
        return ("Cliente", "")
    return (parts[0], " ".join(parts[1:]))


@dataclass
class SyncReport:
    created: int = 0
    linked: int = 0
    updated: int = 0
    pushed: int = 0
    items: int = 0
    errors: list[str] = field(default_factory=list)


class SyncAborted(Exception):
    """La connessione è sparita o ha cambiato org mentre la sync girava."""


def _ensure_linked(conn: YourangConnection) -> None:
    """Ferma la sync se nel frattempo il salone è stato scollegato o ricollegato.

    La sync lunga gira fuori dalla richiesta (prima sync in background, cron):
    se intanto il titolare scollega e ricollega un'altra org, continuare
    scriverebbe sulle schede i contact-id dell'org VECCHIA, e la sync della
    nuova le salterebbe come «già collegate». Una query indicizzata per giro,
    niente in confronto alla chiamata HTTP che segue.
    """
    if not YourangConnection.objects.filter(
        pk=conn.pk, yourang_org_id=conn.yourang_org_id
    ).exists():
        raise SyncAborted("collegamento Yourang cambiato durante la sincronizzazione: interrotta")


def summarize_errors(errors: list[str]) -> str:
    """Riassunto degli errori di sync da mostrare al titolare ("" se tutto bene)."""
    if not errors:
        return ""
    head = "; ".join(errors[:3])
    more = f" (+{len(errors) - 3} altri)" if len(errors) > 3 else ""
    return f"Sincronizzazione parziale: {head}{more}"[:500]


# ---- Clienti ↔ Contatti ----------------------------------------------------


def _list_all_contacts(client: YourangClient, report: SyncReport) -> list[dict]:
    """Tutti i contatti dell'org, con due paracadute sulla paginazione.

    Il ciclo si fermava solo su una pagina corta: un proxy che ignora `offset`
    (o che sbaglia a contarlo) rimandava per sempre la stessa pagina e la sync —
    che gira dentro il webhook — non finiva mai.
    """
    remote: list[dict] = []
    seen_ids: set[str] = set()
    offset = 0
    for _ in range(MAX_CONTACT_PAGES):
        page = client.list_contacts(limit=100, offset=offset)
        if not page:
            break
        fresh = {str(rc.get("id") or "") for rc in page} - {""} - seen_ids
        if not fresh and seen_ids:
            report.errors.append("contatti: pagina già vista, paginazione interrotta")
            break
        seen_ids |= fresh
        remote.extend(page)
        if len(page) < 100:
            break
        offset += 100
    else:
        report.errors.append(f"contatti: oltre {MAX_CONTACT_PAGES} pagine, elenco troncato")
    return remote


def _reconcile_contact(salon, rc: dict, by_id: dict, by_key: dict, report: SyncReport) -> None:
    """Un solo contatto remoto → scheda locale. Gli indici si aggiornano qui
    dentro: due contatti remoti scritti in due modi ma con lo stesso numero
    devono ritrovare la stessa scheda, non crearne una seconda né riscrivere lo
    stesso contact-id (che è unico per salone)."""
    rid = str(rc.get("id") or "")
    raw_phone = rc.get("phone_number", "") or ""
    phone = normalize_phone(raw_phone)
    key = phone_key(raw_phone)
    first = rc.get("first_name") or "Cliente"
    last = rc.get("last_name") or ""
    email = rc.get("email") or ""

    local = by_id.get(rid) if rid else None
    if local is None and key:
        local = by_key.get(key)
        # Si linka solo una scheda ancora libera: se ha già un altro contact-id
        # sovrascriverlo violerebbe il vincolo unico e romperebbe l'altro legame.
        if local is not None and rid and not local.yourang_contact_id:
            local.yourang_contact_id = rid
            local.save(update_fields=["yourang_contact_id"])
            report.linked += 1

    if local is None:
        if not phone:
            return
        local = Client.objects.create(
            salon=salon,
            first_name=first,
            last_name=last,
            phone=phone,
            email=email,
            yourang_contact_id=rid,
            # `since` vuoto di proposito: è una voce della rubrica Yourang, non
            # una cliente acquisita oggi. Con since=oggi il primo collegamento
            # trasformava l'intera rubrica in «nuovi clienti» del giorno (e del
            # mese, del trimestre, dell'anno), e le clienti storiche tornate in
            # salone non risultavano mai «di ritorno» (08-05). Come l'import CSV.
        )
        report.created += 1
    else:
        changed = []
        if local.email != email and email:
            local.email = email
            changed.append("email")
        if local.last_name != last and last:
            local.last_name = last
            changed.append("last_name")
        if changed:
            local.save(update_fields=changed)
            report.updated += 1

    if rid:
        by_id.setdefault(rid, local)
    if key:
        by_key.setdefault(key, local)


def sync_clients(conn: YourangConnection, *, push: bool = True) -> SyncReport:
    """Riconcilia per telefono E.164: linkati→aggiorna, stesso telefono→linka,
    mancanti→crea; i clienti nativi non ancora su Yourang vengono spinti
    (salvo push=False: il webhook riconcilia e basta, il push è del cron)."""
    with YourangClient(conn) as client:
        return _sync_clients(conn, client, push=push)


def _sync_clients(conn: YourangConnection, client: YourangClient, *, push: bool) -> SyncReport:
    report = SyncReport()
    salon = conn.salon

    # 1) scarica tutti i contatti Yourang
    remote = _list_all_contacts(client, report)

    locals_by_id = {
        c.yourang_contact_id: c
        for c in Client.objects.filter(salon=salon).exclude(yourang_contact_id="")
    }
    # L'indice è sulla CHIAVE normalizzata, non sulla stringa: è quella l'identità
    # del cliente (Client.phone_key). Anche i disattivati, perché il vincolo
    # unique (salon, phone) vale comunque e senza di loro un contatto remoto con
    # quel numero farebbe fallire la create.
    locals_by_key = {}
    for c in Client.objects.filter(salon=salon):
        key = phone_key(c.phone)
        if key:
            locals_by_key.setdefault(key, c)

    # 2) Yourang → locale
    for rc in remote:
        _ensure_linked(conn)
        try:
            # Savepoint per contatto: un solo salvataggio che fallisce (telefono
            # duplicato, corsa con un'altra consegna) non deve fermare tutta la
            # riconciliazione. L'errore era deterministico, quindi l'integrazione
            # restava bloccata per sempre: dal webhook 503 a ripetizione, dal cron
            # connessione in ERROR e nessun tentativo capace di riuscire.
            with transaction.atomic():
                _reconcile_contact(salon, rc, locals_by_id, locals_by_key, report)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Yourang: contatto %s non riconciliato: %s", rc.get("id"), exc)
            report.errors.append(f"contatto {rc.get('id') or '?'}: {exc}")

    # 3) locali senza corrispondenza → push su Yourang
    if not push:
        return report
    for local in Client.objects.filter(salon=salon, is_active=True):
        if local.yourang_contact_id:
            continue
        phone = normalize_phone(local.phone)
        if not phone:
            continue
        _ensure_linked(conn)
        try:
            created = client.create_or_get_contact(
                phone,
                {
                    "first_name": local.first_name,
                    "last_name": local.last_name,
                    "email": local.email or None,
                },
            )
        except Exception as exc:  # 403 senza scope contacts:write → degrada
            report.errors.append(f"push {phone}: {exc}")
            continue
        if created.get("id"):
            try:
                # Stesso motivo del ciclo qui sopra: due schede locali scritte in
                # due modi ricevono lo stesso contact-id dal by-phone remoto, e la
                # seconda viola il vincolo unico. Si salta quella, non la sync.
                with transaction.atomic():
                    local.yourang_contact_id = str(created["id"])
                    local.save(update_fields=["yourang_contact_id"])
            except IntegrityError as exc:
                report.errors.append(f"push {phone}: contatto già collegato ({exc})")
                continue
            report.pushed += 1

    return report


def sync_contact(conn: YourangConnection, contact_id: str) -> SyncReport:
    """Webhook contact.*: riconcilia SOLO quel contatto.

    Ogni contact.* rifaceva la sync completa dentro la richiesta: elenco di
    tutti i contatti e push di ogni scheda non collegata. Con lo scope
    contacts:write mancante erano 120 POST rifiutati per 120 schede a OGNI
    webhook, e a raffica un thread di gunicorn occupato per minuti (11-12). Il
    push delle schede locali resta al primo collegamento e al cron.
    """
    report = SyncReport()
    with YourangClient(conn) as client:
        try:
            rc = client.get_contact(contact_id)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code not in (404, 405):
                raise
            # Contatto sparito nel frattempo, o proxy senza la rotta del
            # singolo contatto: riconciliazione completa, ma senza push.
            return _sync_clients(conn, client, push=False)
    if not rc:
        return report
    salon = conn.salon
    rid = str(rc.get("id") or contact_id)
    rc = {**rc, "id": rid}
    by_id, by_key = {}, {}
    linked = Client.objects.filter(salon=salon, yourang_contact_id=rid).first()
    if linked is not None:
        by_id[rid] = linked
    raw_phone = rc.get("phone_number", "") or ""
    key = phone_key(raw_phone)
    if key:
        match = find_client_by_phone(salon, raw_phone)
        if match is not None:
            by_key[key] = match
    _ensure_linked(conn)
    try:
        with transaction.atomic():
            _reconcile_contact(salon, rc, by_id, by_key, report)
    except Exception as exc:  # noqa: BLE001
        # Come nella sync completa: un errore di questo contatto è
        # deterministico, e un 503 farebbe ritentare Yourang all'infinito.
        logger.warning("Yourang: contatto %s non riconciliato: %s", rid, exc)
        report.errors.append(f"contatto {rid}: {exc}")
    return report


# ---- Servizi / Pacchetti → Catalogo ----------------------------------------


def sync_services(conn: YourangConnection) -> SyncReport:
    with YourangClient(conn) as client:
        return _sync_services(conn, client)


def _sync_services(conn: YourangConnection, client: YourangClient) -> SyncReport:
    report = SyncReport()
    salon = conn.salon

    if not conn.catalogue_id:
        # Sotto lock sulla riga della connessione: la prima sync in background
        # e il cron possono partire insieme, e due «catalogo mancante» creavano
        # due cataloghi su Yourang, uno dei quali orfano con metà del listino.
        # Una sola chiamata dentro la transazione, e solo la prima volta.
        with transaction.atomic():
            locked = YourangConnection.objects.select_for_update().get(pk=conn.pk)
            if not locked.catalogue_id:
                cat = client.create_catalogue(f"{salon.name} — Servizi")
                if not cat.get("id"):
                    report.errors.append("creazione catalogo fallita")
                    return report
                locked.catalogue_id = str(cat["id"])
                locked.save(update_fields=["catalogue_id", "updated_at"])
            conn.catalogue_id = locked.catalogue_id

    for svc in Service.objects.filter(salon=salon, active=True).select_related("category"):
        _ensure_linked(conn)
        payload = {
            "name": svc.name_it or svc.name_en,
            "sku": f"service-{svc.id}",
            "price": str(svc.price),
            "currency": salon.currency,
            "category": svc.category.name_it if svc.category else "",
            "catalogue_id": conn.catalogue_id,
        }
        try:
            item = client.upsert_catalogue_item(svc.yourang_item_id or None, payload)
        except Exception as exc:
            report.errors.append(f"servizio {svc.id}: {exc}")
            continue
        if item.get("id") and str(item["id"]) != svc.yourang_item_id:
            svc.yourang_item_id = str(item["id"])
            svc.save(update_fields=["yourang_item_id"])
        report.items += 1

    for pkg in Package.objects.filter(salon=salon, active=True):
        _ensure_linked(conn)
        payload = {
            "name": pkg.name,
            "sku": f"package-{pkg.id}",
            "description": pkg.description,
            "price": str(pkg.price),
            "currency": salon.currency,
            "category": "Pacchetti",
            "catalogue_id": conn.catalogue_id,
        }
        try:
            item = client.upsert_catalogue_item(pkg.yourang_item_id or None, payload)
        except Exception as exc:
            report.errors.append(f"pacchetto {pkg.id}: {exc}")
            continue
        if item.get("id") and str(item["id"]) != pkg.yourang_item_id:
            pkg.yourang_item_id = str(item["id"])
            pkg.save(update_fields=["yourang_item_id"])
        report.items += 1

    return report


# ---- Prima sincronizzazione, fuori dalla richiesta --------------------------


def initial_sync(conn_id: int) -> None:
    """Prima sync completa (clienti + listino) di un salone appena collegato.

    L'esito resta scritto sulla connessione, che è ciò che il titolare vede:
    `last_sync_at` a fine giro, `last_error` col riassunto degli errori (o
    l'eccezione che l'ha fermata). Scritture con UPDATE: se nel frattempo la
    connessione è stata tolta non c'è niente da aggiornare, e non si riscrive
    nessun'altra colonna.
    """
    conn = YourangConnection.objects.select_related("salon").filter(pk=conn_id).first()
    if conn is None:
        return
    try:
        clients = sync_clients(conn)
        services = sync_services(conn)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Yourang initial sync failed (salone %s)", conn.salon_id)
        YourangConnection.objects.filter(pk=conn.pk, yourang_org_id=conn.yourang_org_id).update(
            last_error=str(exc)[:500], updated_at=timezone.now()
        )
        return
    YourangConnection.objects.filter(pk=conn.pk, yourang_org_id=conn.yourang_org_id).update(
        last_sync_at=timezone.now(),
        last_error=summarize_errors(clients.errors + services.errors),
        updated_at=timezone.now(),
    )


def _run_in_background(conn_id: int) -> None:
    def run():
        try:
            initial_sync(conn_id)
        except Exception:  # noqa: BLE001
            logger.exception("Yourang initial sync crashed (connessione %s)", conn_id)
        finally:
            # Thread fuori dal ciclo richiesta/risposta: nessuno chiude la sua
            # connessione al database al posto suo.
            db_connection.close()

    threading.Thread(target=run, name=f"yourang-sync-{conn_id}", daemon=True).start()


def schedule_initial_sync(conn: YourangConnection) -> None:
    """Avvia la prima sync DOPO il commit, in un thread, e ritorna subito.

    Dentro la richiesta un salone con qualche migliaio di clienti faceva
    migliaia di chiamate HTTP in fila (download dei contatti, push di ogni
    scheda non collegata, listino): «Accedi con Yourang» restava appeso per
    minuti e occupava un thread di gunicorn. Il giro in background è
    idempotente: se il processo si ferma a metà (deploy) lo completa il cron
    `sync_yourang`.
    """
    conn_id = conn.pk
    # lambda e non partial: _run_in_background si risolve al momento del
    # commit (i test lo sostituiscono per eseguirlo in linea).
    transaction.on_commit(lambda: _run_in_background(conn_id))


# ---- Appuntamenti ↔ Eventi -------------------------------------------------


def _default_operator(salon) -> Operator:
    op = Operator.objects.filter(salon=salon, active=True).order_by("order", "id").first()
    if op is None:
        # ponytail: un evento Yourang non porta un'operatrice → una di default,
        # così le prenotazioni in ingresso hanno sempre dove atterrare.
        op = Operator.objects.create(salon=salon, first_name="Yourang", last_name="", active=True)
    return op


def _yourang_service(salon) -> Service:
    svc = Service.objects.filter(salon=salon, name_it=PLACEHOLDER_SERVICE_NAME).first()
    if svc is None:
        cat = (
            ServiceCategory.objects.filter(salon=salon).order_by("order", "id").first()
            or ServiceCategory.objects.create(salon=salon, name_it="Yourang")
        )
        # active=False di proposito: è un segnaposto tecnico, non un servizio del
        # salone. Attivo finirebbe nel listino pubblico (/catalog/public/services),
        # prenotabile dall'app a 0 €, e verrebbe pure rispinto su Yourang a 0 €.
        svc = Service.objects.create(
            salon=salon,
            category=cat,
            name_it=PLACEHOLDER_SERVICE_NAME,
            duration_min=60,
            price=0,
            active=False,
        )
    # Idoneo per OGNI operatrice del salone. Nasceva senza: l'idoneità non si
    # forza mai, quindi la prenotazione restava inchiodata sulla prima
    # operatrice attiva — niente trascinamento su un'altra colonna, niente
    # allungamento, niente stacco (11-04, 01-09). signals.py tiene la regola per
    # le operatrici create o modificate dopo; qui si ripara quel che fosse
    # sfuggito (righe tolte dall'admin), con una query quando è tutto a posto.
    missing = list(Operator.objects.filter(salon=salon).exclude(services=svc).only("id"))
    if missing:
        svc.operators.add(*missing)
    return svc


# Prefisso del telefono segnaposto delle clienti senza numero (vedi sotto).
PHONELESS_PREFIX = "n/d yourang "


def _phoneless_phone(first: str, last: str) -> str:
    """Telefono segnaposto, stabile sul nome, di una prenotazione senza numero.

    Il vincolo unico (salone, telefono) ammette UNA sola scheda col telefono
    vuoto: tutte le prenotazioni Yourang senza numero finivano sulla stessa,
    col nome, le note e lo storico della prima (11-17, H12 del 18/09). Una
    stringa senza cifre non ha chiave telefonica: non si confonde con nessun
    numero vero, non riceve messaggi di nessun altro, e la stessa persona
    (stesso nome) ritrova la sua scheda. «n/d» come lo scrive già lo staff.
    """
    name = " ".join(f"{first} {last}".lower().split())
    digest = hashlib.sha256(name.encode()).digest()
    return PHONELESS_PREFIX + "".join(chr(ord("a") + byte % 26) for byte in digest[:10])


def _client_for_event(salon, data: dict) -> Client:
    """Scheda cliente dell'evento importato, deduplicata sulla CHIAVE del
    telefono (non sulla stringa grezza: «348 221 0094» e «+39 348 2210094» sono
    la stessa cliente, e due schede spaccherebbero storico, fedeltà e caparre).
    """
    first, last = _split_name(data.get("client_full_name", ""))
    phone = normalize_phone(data.get("client_phone_number", "") or "") or ""
    defaults = {
        "first_name": first or "Cliente",
        "last_name": last,
        # Prima visita nota: senza `since` la scheda risulta senza storia. Qui
        # la scheda nasce da una prenotazione vera, non da un'importazione di
        # rubrica: è davvero una cliente nuova di oggi.
        "since": timezone.localdate(),
    }

    if not phone:
        # get_or_create sul telefono segnaposto: gestisce da sé la corsa fra
        # due consegne (il vincolo unico fa perdere una delle due create).
        client_obj, _ = Client.objects.get_or_create(
            salon=salon, phone=_phoneless_phone(first, last), defaults=defaults
        )
        return client_obj

    existing = find_client_by_phone(salon, phone)
    if existing is not None:
        return existing
    try:
        # Savepoint: due consegne dello stesso evento in parallelo, o il vincolo
        # di unicità su (salon, phone_key), fanno perdere la corsa a una delle
        # due — che deve rileggere la scheda dell'altra, non esplodere.
        with transaction.atomic():
            return Client.objects.create(salon=salon, phone=phone, **defaults)
    except IntegrityError:
        existing = find_client_by_phone(salon, phone)
        if existing is None:
            raise
        return existing


def _event_duration_min(data: dict, start) -> int:
    end = parse_datetime(data.get("ending_date") or "")
    if end:
        if timezone.is_naive(end):
            end = timezone.make_aware(end)
        mins = int((end - start).total_seconds() // 60)
        if mins > 0:
            return mins
    return 60


def _remote_client_key(data: dict) -> str:
    """Chi è la cliente secondo l'evento: telefono normalizzato e nome."""
    phone = normalize_phone(data.get("client_phone_number", "") or "") or ""
    name = " ".join(str(data.get("client_full_name") or "").split())
    return f"{phone}|{name}"[:255]


def _log_event(appt: Appointment, event_type: str, summary: str, event_id: str, **extra) -> None:
    """Riga nel registro attività, che è ciò che leggono SSE e polling.

    Import e annullamenti Yourang non ne scrivevano nessuna: l'agenda aperta
    sulle altre postazioni restava vuota in quella fascia, la reception ci
    metteva un'altra cliente e il 409 veniva ritentato con force — doppia
    prenotazione senza avviso (11-06).
    """
    log_activity(
        appt.salon,
        event_type,
        summary,
        payload={
            "appointment_id": appt.id,
            "source": "yourang",
            "yourang_event_id": event_id,
            **extra,
        },
    )


def _cancel_from_remote(appt: Appointment, event_id: str) -> bool:
    """Annulla un appuntamento perché su Yourang è stato annullato o cancellato.

    Va chiamata sotto `lock_salon`, con l'appuntamento appena riletto. Prima un
    UPDATE nudo annullava qualunque cosa (anche la visita già incassata, se su
    Yourang si faceva pulizia degli eventi passati), senza registro, senza
    lista d'attesa e senza toccare `updated_at` (11-05, 18-13). Ora:
    - solo un appuntamento CONFERMATO: check-in, in corso, chiuso e no-show li
      ha decisi il salone e restano come sono;
    - registro attività, messaggi ancora trattenuti per la cliente sostituiti
      (uno spostamento appena fatto al banco non deve partire dopo la disdetta)
      e slot annunciato alla lista d'attesa se è nel futuro;
    - caparra pagata → «da rimborsare», come un annullamento del salone in
      tempo: non sappiamo chi ha annullato, quindi niente penale.
    Non è `agenda.services.cancel_appointment`, di proposito: quello rimanda a
    Yourang `appointment.cancelled` (la cliente riceverebbe un secondo avviso
    di una disdetta fatta proprio lì — l'import, allo stesso modo, non rimanda
    la conferma) e mette l'annullamento nello storico «torna indietro» della
    postazione, che non l'ha fatto.
    Ritorna True se ha annullato.
    """
    if appt.status != Appointment.Status.CONFIRMED:
        return False
    appt.status = Appointment.Status.CANCELLED
    appt.cancel_reason = "Annullato su Yourang"
    fields = ["status", "cancel_reason", "updated_at"]
    if appt.deposit_status == Appointment.DepositStatus.PAID:
        appt.deposit_status = Appointment.DepositStatus.REFUND_DUE
        fields.append("deposit_status")
    appt.save(update_fields=fields)
    supersede_events(list(held_events(appt.salon, appointment_event_key(appt.id), lock=True)))
    _log_event(
        appt,
        "appointment.cancelled",
        f"Appuntamento di {appt.client.full_name} annullato su Yourang",
        event_id,
    )
    if appt.start > timezone.now():
        free_slot_event(appt)
    return True


def _create_from_event(salon, event_id: str, data: dict, remote: dict, remote_status, placeholder):
    client_obj = _client_for_event(salon, data)
    try:
        with transaction.atomic():
            appt = Appointment.objects.create(
                salon=salon,
                yourang_event_id=event_id,
                client=client_obj,
                operator=_default_operator(salon),
                start=remote["remote_start"],
                status=remote_status or Appointment.Status.CONFIRMED,
                created_via=Appointment.CreatedVia.YOURANG,
                note="Prenotazione da Yourang",
            )
    except IntegrityError:
        # Rete di sicurezza: il lock serializza già le consegne dello stesso
        # evento, ma se una create ha perso comunque si aggiorna la riga vinta.
        return None
    # ponytail: nessun mapping affidabile Evento→Servizio locale → una riga
    # segnaposto "Prenotazione Yourang" con la durata reale dell'evento, così
    # l'appuntamento è visibile in agenda (la durata deriva dagli items).
    AppointmentService.objects.create(
        appointment=appt,
        service=placeholder,
        operator=appt.operator,
        duration_min=remote["remote_duration_min"],
        soak_min=0,
        price=0,
    )
    _log_event(
        appt, "appointment.created", f"Prenotazione da Yourang per {client_obj.full_name}", event_id
    )
    return appt


def _update_from_event(
    appt: Appointment, event_id: str, data: dict, remote: dict, remote_status, placeholder
) -> bool:
    """Applica una ri-consegna. Ritorna True se ha annullato l'appuntamento.

    Si riscrive solo ciò che su Yourang è cambiato DAVVERO rispetto all'ultimo
    evento visto (YourangEventSync): prima orario e cliente tornavano al valore
    remoto a ogni consegna, anche per una semplice approvazione, e annullavano
    in silenzio lo spostamento fatto in salone — sopra la cliente messa nel
    frattempo in quello slot — o la scheda corretta a mano (11-07). Gli eventi
    importati prima di questa traccia non hanno un «prima»: per loro vale come
    cambiato, cioè il comportamento di sempre, una volta sola.

    Orario, cliente e durata si seguono solo finché l'appuntamento è
    confermato: dal check-in in poi (e su una visita chiusa o annullata) sono
    storia del salone. Lo stato remoto conta solo per annullare un confermato.
    """
    snap = YourangEventSync.objects.filter(appointment=appt).first()

    def changed(name: str) -> bool:
        return snap is None or getattr(snap, name) != remote[name]

    if remote_status == Appointment.Status.CANCELLED and changed("remote_status"):
        return _cancel_from_remote(appt, event_id)

    fields = []
    old_start = appt.start
    items = list(appt.items.select_related("service"))
    duration_changed = False
    if appt.status == Appointment.Status.CONFIRMED:
        if changed("remote_client"):
            client_obj = _client_for_event(appt.salon, data)
            if appt.client_id != client_obj.id:
                appt.client = client_obj
                fields.append("client")
        if changed("remote_start") and appt.start != remote["remote_start"]:
            appt.start = remote["remote_start"]
            fields.append("start")
        if (
            changed("remote_duration_min")
            and len(items) == 1
            # Solo se è ancora il segnaposto: se il salone l'ha sostituito con il
            # servizio vero, la durata è quella del listino e non la riscrive Yourang.
            and items[0].service_id == placeholder.id
            and items[0].duration_min != remote["remote_duration_min"]
        ):
            # L'evento è stato allungato o accorciato su Yourang: la riga
            # segnaposto segue, altrimenti l'agenda mostrerebbe ancora la durata
            # della prima importazione.
            items[0].duration_min = remote["remote_duration_min"]
            items[0].save(update_fields=["duration_min"])
            duration_changed = True
    if not items:
        # Appuntamento rimasto senza righe (import interrotto prima di questa
        # versione, quando non era atomico): senza durata non si vede in agenda.
        AppointmentService.objects.create(
            appointment=appt,
            service=placeholder,
            operator=appt.operator,
            duration_min=remote["remote_duration_min"],
            soak_min=0,
            price=0,
        )
        duration_changed = True
    if fields:
        appt.save(update_fields=fields + ["updated_at"])
    if "start" in fields:
        _log_event(
            appt,
            "appointment.moved",
            f"Prenotazione Yourang di {appt.client.full_name} spostata su Yourang",
            event_id,
            old_start=old_start.isoformat(),
        )
    elif fields or duration_changed:
        _log_event(
            appt,
            "appointment.updated",
            f"Prenotazione Yourang di {appt.client.full_name} aggiornata su Yourang",
            event_id,
        )
    return False


def import_event(conn: YourangConnection, event_id: str) -> Appointment | None:
    """Scarica un evento Yourang e fa upsert dell'Appointment (idempotente su id).

    La chiamata HTTP sta fuori dalla transazione; tutto il resto dentro, sotto
    il lock dell'agenda del salone — lo stesso delle mutazioni della dashboard.
    Due consegne dello stesso evento in parallelo vedevano entrambe
    l'appuntamento senza righe e creavano due segnaposto (120' invece di 60',
    e da lì la durata non seguiva più Yourang) (11-16); ora la seconda aspetta
    la prima e trova il lavoro fatto. Lo stesso lock impedisce a una
    ri-consegna di incrociarsi con uno spostamento fatto al banco.
    """
    salon = conn.salon
    event_id = str(event_id)
    data = YourangClient(conn).get_event(event_id)
    if not data:
        return None

    start = parse_datetime(data.get("starting_date") or "")
    if start is None:
        return None
    if timezone.is_naive(start):
        start = timezone.make_aware(start)

    raw_status = str(data.get("status", "")).lower()
    remote_status = _EVENT_STATUS.get(raw_status)
    if remote_status is None and raw_status:
        # Enum remota cambiata: non si indovina. In creazione l'appuntamento
        # nasce confermato (meglio visibile in agenda che perso), in
        # aggiornamento lo stato locale NON si tocca — un "cancelled" scritto
        # in un modo nuovo non deve diventare un confermato che occupa lo slot.
        logger.warning("Yourang: stato evento sconosciuto %r (evento %s)", raw_status, event_id)

    remote = {
        "remote_start": start,
        "remote_client": _remote_client_key(data),
        "remote_duration_min": _event_duration_min(data, start),
        # Lo stato MAPPATO: «pending» → «approved» è sempre un confermato, e
        # non deve contare come cambiamento.
        "remote_status": (remote_status or raw_status)[:32],
    }

    cancelled = False
    with transaction.atomic():
        lock_salon(salon)
        # Prima di leggere l'appuntamento: tutto ciò che si legge da qui in poi
        # è quello che una consegna parallela ha già committato.
        placeholder = _yourang_service(salon)
        appt = (
            Appointment.objects.select_related("client")
            .filter(salon=salon, yourang_event_id=event_id)
            .first()
        )
        if appt is None:
            appt = _create_from_event(salon, event_id, data, remote, remote_status, placeholder)
            if appt is None:
                appt = (
                    Appointment.objects.select_related("client")
                    .filter(salon=salon, yourang_event_id=event_id)
                    .first()
                )
                if appt is None:
                    raise RuntimeError(f"Evento Yourang {event_id}: appuntamento non creato")
                cancelled = _update_from_event(
                    appt, event_id, data, remote, remote_status, placeholder
                )
        else:
            cancelled = _update_from_event(appt, event_id, data, remote, remote_status, placeholder)
        YourangEventSync.objects.update_or_create(appointment=appt, defaults=remote)
    if cancelled and appt.deposit_status == Appointment.DepositStatus.REFUND_DUE:
        # Fuori dalla transazione: è una chiamata a Stripe.
        settle_deposit_refund(appt)
    return appt


def cancel_event(conn: YourangConnection, event_id: str) -> None:
    # Guardia obbligatoria: `yourang_event_id` è blank=True default="" su TUTTI
    # gli appuntamenti nativi (il vincolo unico è parziale, esclude ""). Con un
    # event_id vuoto — payload senza `resource_id`, o campo rinominato di nuovo
    # dal proxy — il filtro cadrebbe su tutti quanti e annullerebbe l'intera
    # agenda del salone, passata e futura.
    if not str(event_id or "").strip():
        logger.warning(
            "Yourang: event.deleted senza resource_id, ignorato (salone %s)", conn.salon_id
        )
        return
    event_id = str(event_id)
    with transaction.atomic():
        lock_salon(conn.salon)
        appt = (
            Appointment.objects.select_related("client")
            .filter(salon=conn.salon, yourang_event_id=event_id)
            .first()
        )
        if appt is None:
            return
        cancelled = _cancel_from_remote(appt, event_id)
        # L'evento non esiste più: per le ri-consegne che arrivassero dopo è
        # un annullato, e un salone che l'ha rimesso in agenda resta sovrano.
        YourangEventSync.objects.update_or_create(
            appointment=appt, defaults={"remote_status": Appointment.Status.CANCELLED}
        )
    if cancelled and appt.deposit_status == Appointment.DepositStatus.REFUND_DUE:
        settle_deposit_refund(appt)
