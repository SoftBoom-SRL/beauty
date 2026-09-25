"""Import CSV dell'anagrafica: righe già mappate dal gestionale, upsert per telefono.

`import_rows` è la logica dell'endpoint POST /api/clients/import. Riconosce la
stessa persona per telefono (chiave normalizzata) e, solo per le righe senza
numero, per email con il nome che non la contraddice; ogni riga ha il suo
savepoint e il suo esito.
"""

import datetime as dt
import re

from django.db import DataError, IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from common.phone import canonical_phone, normalize_phone, phone_key

from .fields import normalize_gender, parse_birthday
from .models import Client, ClientCategory, ClientNote
from .search import APOSTROPHE_CLASS, strip_accents


def _folded(text: str) -> str:
    """Testo confrontabile: senza accenti né maiuscole, apostrofi e spazi uniformi."""
    # Le stesse varianti dell'apostrofo della ricerca in anagrafica.
    plain = re.sub(APOSTROPHE_CLASS, "'", strip_accents(text or ""))
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
    created = updated = skipped = 0
    errors: list[dict] = []
    warnings: list[dict] = []

    existing = list(
        Client.objects.filter(salon=salon).only(
            "id", "phone", "email", "first_name", "last_name", "is_active"
        )
    )
    # `phone_key` di common.phone: «+39 348 221 0094», «3482210094» e
    # «0039348-2210094» coincidono, con la stessa normalizzazione di login OTP,
    # registrazione, form pubblico e sync Yourang.
    by_phone = {phone_key(c.phone): c for c in existing if phone_key(c.phone)}
    by_email = {c.email.strip().lower(): c for c in existing if c.email}
    category_cache: dict[str, ClientCategory] = {}

    def category_for(name: str) -> ClientCategory:
        # Si cerca, e si tiene in cache, il nome che si crea: troncato ai 60
        # caratteri della colonna. Cercato intero, un nome più lungo non
        # ritrovava l'etichetta già creata (dall'import prima, o da un nome con
        # gli stessi 60 caratteri iniziali), e la nuova creazione urtava il
        # vincolo (salone, nome): ogni riga con quell'etichetta rifiutata.
        label = name.strip()[:60]
        key = label.lower()
        if key not in category_cache:
            cat = ClientCategory.objects.filter(salon=salon, name__iexact=label).first()
            if cat is None:
                cat = ClientCategory.objects.create(salon=salon, name=label)
            category_cache[key] = cat
        return category_cache[key]

    for index, row in enumerate(rows):
        # savepoint per riga: una riga rifiutata dal database non porta
        # via con sé quelle già importate. I contatori e le cache di
        # deduplicazione vengono riportati indietro insieme ai dati, altrimenti
        # il riepilogo conterebbe una riga che non è stata scritta. Anche la
        # cache delle etichette: un'etichetta nata nella riga rifiutata sparisce
        # col savepoint, e la cache la dava alle righe dopo, che il database
        # rifiutava a loro volta (voce 23 dei bug sospetti del 24/09).
        counters = (created, updated, skipped)
        phones_before, emails_before = set(by_phone), set(by_email)
        categories_before = set(category_cache)
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
            for key in set(category_cache) - categories_before:
                category_cache.pop(key, None)
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
