"""Servizi dell'app clients.

`client_facts` è il dizionario standard usato da `common.conditions.evaluate`
per le regole E/O (deposito in core.DepositRule, filtri delle automazioni).
sales/agenda potrebbero non essere ancora pronte: ogni lettura cross-app è
importata pigramente e degrada a 0/[] senza sollevare eccezioni.
"""

import datetime as dt
import re
import unicodedata
from decimal import Decimal

from django.db import DataError, IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from common.phone import canonical_phone, normalize_phone, phone_key as _phone_key

from .models import Client


def client_stats(client: Client) -> dict:
    """Aggregati della cliente: visite, spesa totale, ultima visita.

    Visite = appuntamenti chiusi (la cliente è passata in poltrona e il conto
    è chiuso; contano anche quelli arrivati chiusi da Yourang, che una vendita
    non ce l'hanno) più i passaggi al banco, cioè le vendite senza
    appuntamento. Spesa = conti delle visite e vendite al banco.

    Dal 18/09 caparra e addebito no-show sono vendite anche loro, e venivano
    contate come tali: servizio da 100 con caparra da 30 dava 2 visite e 130 €
    spesi, la caparra rimborsata di una prenotazione annullata una visita mai
    fatta, il no-show addebitato una visita. Le regole caparra leggono questi
    numeri (`client_facts`): «Prima visita» (visite < 1) smetteva di chiedere
    la caparra dopo la prima caparra pagata, a chi in salone non era ancora
    venuta. Le due vendite restano nella cassa e nello storico; qui no.

    Import lazy di `apps.sales`/`apps.agenda`: se le app non sono ancora
    installate/pronte ritorna semplicemente gli zeri di default.
    """
    stats = {"visits": 0, "total_spent": Decimal("0"), "last_visit": None}
    try:
        from apps.agenda.models import Appointment  # lazy: evita cicli e app non ancora pronte
        from apps.sales.models import Sale  # lazy: evita cicli e app non ancora pronte
    except ImportError:
        return stats

    from django.db.models import Count, F, Max, Q, Sum

    billed = (
        Sale.objects.filter(client=client)
        # La vendita-caparra è l'anticipo di un conto che, al checkout, la
        # contiene già per intero (`deposit_deducted`): sommarla la conta due
        # volte. Se la visita non c'è stata, non è comunque una spesa per
        # servizi ricevuti.
        .filter(deposit_appointment__isnull=True)
        # L'addebito no-show è l'unica vendita al banco agganciata a un
        # appuntamento (sales.services._money_sale): una penale, non un conto.
        .exclude(kind=Sale.Kind.POS, appointment__isnull=False)
    )
    stats["total_spent"] = billed.aggregate(total=Sum("total"))["total"] or Decimal("0")

    counter = billed.filter(appointment__isnull=True)
    # Una gift card comprata al banco è un incasso, non una visita: chi regala
    # un buono non si è seduto in poltrona. Contarla gonfiava le visite e con
    # esse le regole caparra («sotto le N visite chiedi la caparra»), che
    # vedevano come abituale chi in salone non c'era mai stata. L'incasso
    # invece resta nella spesa totale: quei soldi il salone li ha presi.
    gift_only = (
        counter.annotate(
            lines_total=Count("lines"),
            gift_lines=Count("lines", filter=Q(lines__line_type="gift_card")),
        )
        .filter(lines_total__gt=0, lines_total=F("gift_lines"))
        .values_list("id", flat=True)
    )
    at_counter = counter.exclude(id__in=list(gift_only)).aggregate(
        visits=Count("id"), last=Max("created_at")
    )
    closed = Appointment.objects.filter(
        client=client, status=Appointment.Status.CLOSED
    ).aggregate(visits=Count("id"), last=Max("start"))
    stats["visits"] = (closed["visits"] or 0) + (at_counter["visits"] or 0)
    seen = [d for d in (closed["last"], at_counter["last"]) if d is not None]
    stats["last_visit"] = max(seen) if seen else None
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


def _folded(text: str) -> str:
    """Testo confrontabile: senza accenti né maiuscole, apostrofi e spazi uniformi."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    plain = re.sub(r"[’‘ʼ`´]", "'", plain)
    return " ".join(plain.casefold().split())


def _same_person(first_name: str, last_name: str, client: Client) -> bool:
    """Il nome della riga non contraddice quello della scheda."""
    if first_name and _folded(first_name) != _folded(client.first_name):
        return False
    if last_name and client.last_name and _folded(last_name) != _folded(client.last_name):
        return False
    return True


def _parse_since(value) -> dt.date | None:
    """«Cliente dal» di una riga importata: 'YYYY-MM-DD', mai nel futuro. Solleva ValueError."""
    raw = str(value or "").strip()
    if not raw:
        return None
    since = dt.date.fromisoformat(raw)
    if since > timezone.localdate():
        raise ValueError(raw)
    return since


def import_rows(salon, rows: list[dict], *, update_existing: bool = True, actor=None) -> dict:
    """Upsert massivo per import CSV (righe già mappate e normalizzate dal client).

    Match per telefono (confronto su phone_key, tollerante a spazi e prefisso).
    L'email è solo la rete di sicurezza per le righe SENZA telefono: una riga
    che il suo numero ce l'ha e non corrisponde a nessuno è una persona nuova,
    non la stessa scheda trovata per indirizzo. Cercare per email anche in quel
    caso fondeva in una sola scheda tutte le righe di un file esportato con lo
    stesso indirizzo di servizio (`info@salone.it`) — o madre e figlia — e
    l'import rispondeva «249 aggiornati» senza un solo errore. E anche la riga
    senza telefono trovata per email si ferma se il nome è di un'altra persona:
    con l'indirizzo di famiglia la figlia senza numero rinominava la scheda
    della madre e le scriveva sopra compleanno e note (06-08).
    Una riga senza telefono che non trova corrispondenza viene saltata (il
    telefono è obbligatorio per creare un cliente). Con
    update_existing=False i clienti già presenti non vengono toccati. Una
    scheda archiviata non si aggiorna né si riattiva da qui: la riga lo dice e
    indica la scheda (06-02), riattivarla è una scelta dello staff.
    Campi facoltativi: gender, birthday ('YYYY-MM-DD' | '--MM-DD'), origin,
    lang, note (nota privata), categories (nomi etichetta, create se mancanti),
    since ('YYYY-MM-DD', «cliente dal»). Un campo facoltativo illeggibile non
    fa perdere la riga: la cliente entra senza, e l'avviso finisce in
    `warnings` (06-13). Sulle schede esistenti si scrivono solo le colonne che
    cambiano (18-07).

    Ogni riga è scritta dentro il proprio savepoint: se il database la rifiuta
    (per esempio due righe dello stesso file con lo stesso telefono) viene
    annullata da sola e finisce fra gli errori. Senza, il primo rifiuto
    interrompeva l'import a metà lasciando scritto quello che era già passato e
    un conteggio che non corrispondeva a niente.
    """
    from .models import ClientCategory, ClientNote

    created = updated = skipped = 0
    errors: list[dict] = []
    warnings: list[dict] = []

    existing = list(
        Client.objects.filter(salon=salon).only(
            "id", "phone", "email", "first_name", "last_name", "is_active"
        )
    )
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
        warnings_before = len(warnings)
        try:
            with transaction.atomic():
                phone = (row.get("phone") or "").strip()
                email = (row.get("email") or "").strip()
                first_name = (row.get("first_name") or "").strip()
                last_name = (row.get("last_name") or "").strip()
                # Un dato facoltativo che non si legge non costa la cliente:
                # il 29/02 di un anno non bisestile scartava l'intera riga.
                try:
                    gender = normalize_gender(row.get("gender") or "")
                except HttpError as exc:
                    gender = ""
                    warnings.append({"row": index, "reason": f"{exc.message}: importata senza genere"})
                try:
                    birthday, year_known = parse_birthday(row.get("birthday") or "")
                except HttpError as exc:
                    birthday, year_known = None, True
                    warnings.append({"row": index, "reason": f"{exc.message}: importata senza compleanno"})
                try:
                    since = _parse_since(row.get("since"))
                except ValueError:
                    since = None
                    warnings.append({
                        "row": index,
                        "reason": "«Cliente dal» non valido (atteso YYYY-MM-DD, non nel futuro): importata senza",
                    })
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
                    del warnings[warnings_before:]
                    continue

                client = by_phone.get(key) if key else None
                by_email_only = False
                if client is None and not phone and email:
                    client = by_email.get(email.lower())
                    by_email_only = client is not None

                if client is not None and not client.is_active:
                    errors.append({
                        "row": index,
                        "reason": f"Scheda archiviata: {client.full_name}. Riattivala dalla rubrica se è ancora cliente",
                        "client_id": client.id,
                    })
                    skipped += 1
                    del warnings[warnings_before:]
                    continue
                if by_email_only and not _same_person(first_name, last_name, client):
                    errors.append({
                        "row": index,
                        "reason": f"Riga senza telefono: l'email è di {client.full_name}, un'altra persona",
                        "client_id": client.id,
                    })
                    skipped += 1
                    del warnings[warnings_before:]
                    continue

                if client is not None:
                    if not update_existing:
                        skipped += 1
                        del warnings[warnings_before:]
                        continue
                    client = Client.objects.get(pk=client.pk)  # istanza completa
                    values = {}
                    # Trovata per email, il nome della scheda resta il suo: la
                    # riga lo ha solo confermato (anche scritto senza accenti).
                    if first_name and not by_email_only:
                        values["first_name"] = first_name
                    if last_name and (not by_email_only or not client.last_name):
                        values["last_name"] = last_name
                    if email:
                        values["email"] = email
                    # Il telefono non si riscrive mai: qui si arriva o con lo
                    # stesso numero della scheda (match per telefono) o senza
                    # numero (match per email). Prima veniva sostituito, e il
                    # contatto della scheda finiva per essere quello dell'ultima
                    # riga del file.
                    if gender:
                        values["gender"] = gender
                    if birthday and not (
                        # «--03-15» nel file e 15/03/1990 nella scheda: è lo
                        # stesso compleanno, e l'anno già noto non si perde (06-14).
                        not year_known
                        and client.birthday
                        and client.birthday_year_known
                        and (client.birthday.month, client.birthday.day) == (birthday.month, birthday.day)
                    ):
                        values["birthday"], values["birthday_year_known"] = birthday, year_known
                    if lang:
                        values["lang"] = lang
                    if origin and not client.origin:
                        values["origin"] = origin
                    # «Cliente dal» vale la data più vecchia che si conosce.
                    if since and (client.since is None or since < client.since):
                        values["since"] = since
                    changed = [name for name, value in values.items() if getattr(client, name) != value]
                    for name in changed:
                        setattr(client, name, values[name])
                    if changed:
                        client.save(update_fields=changed)
                    updated += 1
                elif phone:
                    if not first_name:
                        errors.append({"row": index, "reason": "Nome mancante"})
                        skipped += 1
                        del warnings[warnings_before:]
                        continue
                    if normalize_phone(phone) is None:
                        # «348 221 0094 / 06 1234567», «3,93482E+11» di Excel: la
                        # scheda nasce col testo com'è, ma OTP e promemoria non
                        # partiranno finché qualcuno non lo corregge (14-15).
                        warnings.append({"row": index, "reason": "Telefono non riconosciuto: salvato com'è, da correggere"})
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
                        # Il «cliente dal» del file, oppure niente: è una
                        # cliente che il salone aveva già. Con la data
                        # dell'import ogni scheda storica diceva «cliente dal
                        # 2026» e l'intera rubrica contava fra le nuove (06-07,
                        # 08-05).
                        since=since,
                    )
                    by_phone[key] = client
                    if email:
                        by_email[email.lower()] = client
                    created += 1
                else:
                    errors.append({"row": index, "reason": "Telefono mancante e nessuna corrispondenza per email"})
                    skipped += 1
                    del warnings[warnings_before:]
                    continue

                if categories:
                    client.categories.add(*[category_for(name) for name in categories])
                # Reimportare lo stesso file non duplica le note (06-15).
                if note and not ClientNote.objects.filter(client=client, text=note).exists():
                    ClientNote.objects.create(client=client, text=note, author=actor)
        except (IntegrityError, DataError) as exc:
            created, updated, _ = counters
            for key in set(by_phone) - phones_before:
                by_phone.pop(key, None)
            for key in set(by_email) - emails_before:
                by_email.pop(key, None)
            del warnings[warnings_before:]
            errors.append({"row": index, "reason": f"Riga rifiutata dal database: {exc}"})
            skipped = counters[2] + 1

    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "warnings": warnings,
    }
