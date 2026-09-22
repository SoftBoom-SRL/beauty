"""Servizi dell'app clients.

`client_facts` è il dizionario standard usato da `common.conditions.evaluate`
per le regole E/O (deposito in core.DepositRule, filtri delle automazioni).
sales/agenda potrebbero non essere ancora pronte: ogni lettura cross-app è
importata pigramente e degrada a 0/[] senza sollevare eccezioni.
"""

from decimal import Decimal

from .models import Client


def client_stats(client: Client) -> dict:
    """Aggregati derivati dalle vendite (visite, spesa totale, ultima visita).

    Import lazy di `apps.sales`: se l'app non è ancora installata/pronta
    ritorna semplicemente gli zeri di default.
    """
    stats = {"visits": 0, "total_spent": Decimal("0"), "last_visit": None}
    try:
        from apps.sales.models import Sale  # lazy: evita cicli e app non ancora pronte
    except ImportError:
        return stats

    from django.db.models import Count, F, Max, Q, Sum

    sales = Sale.objects.filter(client=client)
    # Una gift card comprata al banco è un incasso, non una visita: chi regala
    # un buono non si è seduto in poltrona. Contarla gonfiava le visite e con
    # esse le regole caparra («sotto le N visite chiedi la caparra»), che
    # vedevano come abituale chi in salone non c'era mai stata. L'incasso
    # invece resta nella spesa totale: quei soldi il salone li ha presi.
    gift_only = (
        sales.annotate(
            lines_total=Count("lines"),
            gift_lines=Count("lines", filter=Q(lines__line_type="gift_card")),
        )
        .filter(lines_total__gt=0, lines_total=F("gift_lines"))
        .values_list("id", flat=True)
    )
    visits = sales.exclude(id__in=list(gift_only)).aggregate(
        visits=Count("id"), last=Max("created_at")
    )
    stats["visits"] = visits["visits"] or 0
    stats["last_visit"] = visits["last"]
    stats["total_spent"] = sales.aggregate(total=Sum("total"))["total"] or Decimal("0")
    return stats


def client_facts(client: Client) -> dict:
    """Facts standard per `common.conditions.evaluate` (regole deposito, automazioni).

    Campi mancanti (app sales/agenda non pronte, nessun dato) → 0/[].
    """
    stats = client_stats(client)
    facts = {
        "reliability": client.reliability,
        "categories": list(
            client.categories.order_by("order", "id").values_list("name", flat=True)
        ),
        "total_spent": stats["total_spent"],
        "visits": stats["visits"],
        "noshow_count": 0,
        "latecancel_count": 0,
        "deposit_always": client.deposit_always,
    }

    try:
        from apps.agenda.models import Appointment  # lazy: evita cicli e app non ancora pronte
    except ImportError:
        return facts

    facts["noshow_count"] = Appointment.objects.filter(
        client=client, status="no_show"
    ).count()
    facts["latecancel_count"] = Appointment.objects.filter(
        client=client, cancelled_late=True
    ).count()
    return facts


import datetime as dt
import re

from django.db import DataError, IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from common.phone import canonical_phone, phone_key as _phone_key


# ---- Compleanno: con o senza anno ----------------------------------------------


def parse_birthday(value) -> tuple[dt.date | None, bool]:
    """Normalizza il compleanno ricevuto dall'API.

    Accetta: None/"" → nessun compleanno; "YYYY-MM-DD" → data completa;
    "--MM-DD" o "MM-DD" (ISO 8601 senza anno) → giorno e mese con anno
    segnaposto BIRTHDAY_YEAR_UNKNOWN e year_known=False.
    Ritorna (date | None, year_known). Solleva 400 se non interpretabile.
    """
    if value in (None, ""):
        return None, True
    if isinstance(value, dt.date):
        return value, True
    raw = str(value).strip()
    m = re.fullmatch(r"-{0,2}(\d{1,2})-(\d{1,2})", raw)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        try:
            return dt.date(Client.BIRTHDAY_YEAR_UNKNOWN, month, day), False
        except ValueError:
            raise HttpError(400, "Compleanno non valido (giorno o mese fuori intervallo)")
    try:
        return dt.date.fromisoformat(raw), True
    except ValueError:
        raise HttpError(400, "Compleanno non valido (atteso YYYY-MM-DD oppure --MM-DD)")


def normalize_gender(value: str) -> str:
    """'female' | 'male' | 'other' | ''. Solleva 400 su valori sconosciuti."""
    v = (value or "").strip().lower()
    if v in ("", "female", "male", "other"):
        return v
    raise HttpError(400, "Genere non valido (female, male, other o vuoto)")


# ---- Import CSV -----------------------------------------------------------------


def phone_key(phone: str) -> str:
    """Chiave di confronto fra numeri scritti in modi diversi (vedi common.phone).

    "+39 348 221 0094", "3482210094" e "0039348-2210094" coincidono: è la stessa
    normalizzazione usata da login OTP, registrazione, form pubblico e sync Yourang.
    """
    return _phone_key(phone)


def import_rows(salon, rows: list[dict], *, update_existing: bool = True, actor=None) -> dict:
    """Upsert massivo per import CSV (righe già mappate e normalizzate dal client).

    Match per telefono (confronto su phone_key, tollerante a spazi e prefisso).
    L'email è solo la rete di sicurezza per le righe SENZA telefono: una riga
    che il suo numero ce l'ha e non corrisponde a nessuno è una persona nuova,
    non la stessa scheda trovata per indirizzo. Cercare per email anche in quel
    caso fondeva in una sola scheda tutte le righe di un file esportato con lo
    stesso indirizzo di servizio (`info@salone.it`) — o madre e figlia — e
    l'import rispondeva «249 aggiornati» senza un solo errore.
    Una riga senza telefono che non trova corrispondenza viene saltata (il
    telefono è obbligatorio per creare un cliente). Con
    update_existing=False i clienti già presenti non vengono toccati.
    Campi facoltativi: gender, birthday ('YYYY-MM-DD' | '--MM-DD'), origin,
    lang, note (nota privata), categories (nomi etichetta, create se mancanti).

    Ogni riga è scritta dentro il proprio savepoint: se il database la rifiuta
    (per esempio due righe dello stesso file con lo stesso telefono) viene
    annullata da sola e finisce fra gli errori. Senza, il primo rifiuto
    interrompeva l'import a metà lasciando scritto quello che era già passato e
    un conteggio che non corrispondeva a niente.
    """
    from .models import ClientCategory, ClientNote

    created = updated = skipped = 0
    errors: list[dict] = []

    existing = list(Client.objects.filter(salon=salon).only("id", "phone", "email"))
    by_phone = {phone_key(c.phone): c for c in existing if phone_key(c.phone)}
    by_email = {c.email.strip().lower(): c for c in existing if c.email}
    category_cache: dict[str, ClientCategory] = {}

    def category_for(name: str) -> ClientCategory:
        key = name.strip().lower()
        if key not in category_cache:
            cat = ClientCategory.objects.filter(salon=salon, name__iexact=name.strip()).first()
            if cat is None:
                cat = ClientCategory.objects.create(salon=salon, name=name.strip()[:60])
            category_cache[key] = cat
        return category_cache[key]

    for index, row in enumerate(rows):
        # savepoint per riga: una riga rifiutata dal database non porta
        # via con sé quelle già importate. I contatori e le cache di
        # deduplicazione vengono riportati indietro insieme ai dati, altrimenti
        # il riepilogo conterebbe una riga che non è stata scritta.
        counters = (created, updated, skipped)
        phones_before, emails_before = set(by_phone), set(by_email)
        try:
            with transaction.atomic():
                phone = (row.get("phone") or "").strip()
                email = (row.get("email") or "").strip()
                first_name = (row.get("first_name") or "").strip()
                last_name = (row.get("last_name") or "").strip()
                try:
                    gender = normalize_gender(row.get("gender") or "")
                    birthday, year_known = parse_birthday(row.get("birthday") or "")
                except HttpError as exc:
                    errors.append({"row": index, "reason": exc.message})
                    skipped += 1
                    continue
                lang = (row.get("lang") or "").strip().lower()
                lang = lang if lang in ("it", "en") else ""
                origin = (row.get("origin") or "").strip()[:60]
                note = (row.get("note") or "").strip()
                categories = [c for c in (row.get("categories") or []) if str(c).strip()]

                key = phone_key(phone)
                if phone and not key:
                    # «n/d», «-», «da chiedere»: phone_key non ricava nemmeno
                    # una cifra. Senza questo controllo tutte queste righe
                    # condividevano la chiave vuota e finivano l'una sopra
                    # l'altra sulla stessa scheda.
                    errors.append({"row": index, "reason": "Telefono non valido"})
                    skipped += 1
                    continue

                client = by_phone.get(key) if key else None
                if client is None and not phone and email:
                    client = by_email.get(email.lower())

                if client is not None:
                    if not update_existing:
                        skipped += 1
                        continue
                    client = Client.objects.get(pk=client.pk)  # istanza completa
                    if first_name:
                        client.first_name = first_name
                    if last_name:
                        client.last_name = last_name
                    if email:
                        client.email = email
                    # Il telefono non si riscrive mai: qui si arriva o con lo
                    # stesso numero della scheda (match per telefono) o senza
                    # numero (match per email). Prima veniva sostituito, e il
                    # contatto della scheda finiva per essere quello dell'ultima
                    # riga del file.
                    if gender:
                        client.gender = gender
                    if birthday:
                        client.birthday, client.birthday_year_known = birthday, year_known
                    if lang:
                        client.lang = lang
                    if origin and not client.origin:
                        client.origin = origin
                    client.save()
                    updated += 1
                elif phone:
                    if not first_name:
                        errors.append({"row": index, "reason": "Nome mancante"})
                        skipped += 1
                        continue
                    client = Client.objects.create(
                        salon=salon,
                        first_name=first_name,
                        last_name=last_name,
                        email=email,
                        phone=canonical_phone(phone),
                        gender=gender,
                        birthday=birthday,
                        birthday_year_known=year_known,
                        lang=lang or Client.Lang.IT,
                        origin=origin or "Import",
                        # Cliente dal giorno dell'import: senza `since` il KPI
                        # «nuovi clienti» resta a zero per sempre.
                        since=timezone.localdate(),
                    )
                    by_phone[key] = client
                    if email:
                        by_email[email.lower()] = client
                    created += 1
                else:
                    errors.append({"row": index, "reason": "Telefono mancante e nessuna corrispondenza per email"})
                    skipped += 1
                    continue

                if categories:
                    client.categories.add(*[category_for(name) for name in categories])
                if note:
                    ClientNote.objects.create(client=client, text=note, author=actor)
        except (IntegrityError, DataError) as exc:
            created, updated, _ = counters
            for key in set(by_phone) - phones_before:
                by_phone.pop(key, None)
            for key in set(by_email) - emails_before:
                by_email.pop(key, None)
            errors.append({"row": index, "reason": f"Riga rifiutata dal database: {exc}"})
            skipped = counters[2] + 1

    return {"created": created, "updated": updated, "skipped": skipped, "errors": errors}
