"""Import CSV dell'anagrafica: righe già mappate dal gestionale, upsert per telefono.

`import_rows` è la logica dell'endpoint POST /api/clients/import. Riconosce la
stessa persona per telefono (chiave normalizzata) e, solo per le righe senza
numero, per email con il nome che non la contraddice e poi per nome fra le
schede senza numero; ogni riga ha il suo savepoint e il suo esito. Le righe
senza telefono entrano come schede senza numero; un numero già in rubrica con
il nome di un'altra persona (madre e figlia, coppie) fa nascere una scheda
senza telefono che si contatta tramite chi ha il numero.
"""

import datetime as dt
import re

from django.db import DataError, IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from common.phone import canonical_phone, normalize_phone, phone_key

from .fields import normalize_gender, parse_birthday
from .models import Client, ClientCategory, ClientNote
from .search import APOSTROPHE_CLASS, name_key, strip_accents


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


def _same_holder(first_name: str, last_name: str, holder: Client) -> bool:
    """La riga col numero di `holder` parla di lei, o di un'altra persona con lo stesso numero?

    Il numero è un indizio forte: basta che il nome di battesimo non la
    contraddica. Una riga senza nome, lo stesso nome (anche senza accenti) o
    nome e cognome invertiti («Rossi Maria») sono lei, e un cognome diverso da
    solo pure (il cognome da sposata, un refuso corretto: la scheda lo prende
    dal file, come sempre). Un altro nome di battesimo è un'altra persona: la
    figlia, il marito — prima ne prendeva il posto, rinominando la scheda di
    chi aveva il numero e scrivendole sopra compleanno e note.
    """
    if not first_name or _folded(first_name) == _folded(holder.first_name):
        return True
    return name_key(first_name, last_name) == name_key(holder.first_name, holder.last_name)


def _parse_since(value) -> dt.date | None:
    """«Cliente dal» di una riga importata: 'YYYY-MM-DD', mai nel futuro. Solleva ValueError."""
    raw = str(value or "").strip()
    if not raw:
        return None
    since = dt.date.fromisoformat(raw)
    if since > timezone.localdate():
        raise ValueError(raw)
    return since


class _Rubrica:
    """La rubrica del salone letta una volta, per riconoscere le righe senza query per riga.

    Per telefono (chiave), per email (più schede possono averla: l'indirizzo
    di famiglia) e, per le schede senza numero, per nome. Le schede create da
    una riga si ricordano qui e si dimenticano se il database la rifiuta
    (`forget`), insieme ai dati del suo savepoint.
    """

    def __init__(self, salon):
        self.by_phone: dict[str, Client] = {}
        self.by_email: dict[str, list[Client]] = {}
        self.no_phone: dict[tuple, list[Client]] = {}
        for client in Client.objects.filter(salon=salon).only(
            "id", "phone", "email", "first_name", "last_name", "is_active", "contact_client"
        ).order_by("id"):
            self.remember(client)

    def remember(self, client: Client) -> None:
        # `phone_key` di common.phone: «+39 348 221 0094», «3482210094» e
        # «0039348-2210094» coincidono, con la stessa normalizzazione di login
        # OTP, registrazione, form pubblico e sync Yourang.
        key = phone_key(client.phone)
        if key:
            self.by_phone.setdefault(key, client)
        elif not client.phone:
            self.no_phone.setdefault(name_key(client.first_name, client.last_name), []).append(client)
        if client.email:
            self.by_email.setdefault(client.email.strip().lower(), []).append(client)

    def forget(self, client: Client) -> None:
        for key in [k for k, c in self.by_phone.items() if c is client]:
            del self.by_phone[key]
        for rows in [*self.by_email.values(), *self.no_phone.values()]:
            if client in rows:
                rows.remove(client)

    def refresh(self, cached: Client, saved: Client) -> None:
        """La scheda aggiornata da una riga: le righe dopo la confrontano com'è ora."""
        self.forget(cached)
        for name in ("first_name", "last_name", "email", "contact_client_id"):
            setattr(cached, name, getattr(saved, name))
        self.remember(cached)

    def same_email(self, email: str, first_name: str, last_name: str):
        """(la scheda con questa email che è la stessa persona, la prima scheda con questa email)."""
        found = self.by_email.get(email.lower(), []) if email else []
        match = next((c for c in found if _same_person(first_name, last_name, c)), None)
        return match, (found[0] if found else None)

    def without_phone(self, first_name, last_name, email, *, contact=None, nth=0):
        """La scheda senza numero che è questa riga senza telefono, se l'import l'ha già creata.

        Reimportare lo stesso file non deve raddoppiare le clienti senza
        numero, che non hanno un telefono con cui riconoscerle: si cercano per
        nome. Due omonime senza numero sono due persone, e la riga dice quale
        con `nth`: la prima Maria Rossi del file è la prima scheda Maria Rossi
        senza numero, la seconda la seconda (le schede in ordine di nascita). Un
        nome solo non basta quando l'email li distingue: con email diverse sono
        due persone. Con `contact` vale solo chi passa già da lei, o da nessuno.
        """
        key = name_key(first_name, last_name)
        if not key:
            return None
        found = [
            c for c in self.no_phone.get(key, [])
            if not (email and c.email and c.email.strip().lower() != email.lower())
            and (contact is None or c.contact_client_id in (None, contact.id))
        ]
        return found[nth] if nth < len(found) else None


def import_rows(salon, rows: list[dict], *, update_existing: bool = True, actor=None) -> dict:
    """Upsert massivo per import CSV (righe già mappate e normalizzate dal client).

    Match per telefono (confronto su phone_key, tollerante a spazi e prefisso).
    L'email è solo la rete di sicurezza per le righe SENZA telefono: una riga
    che il suo numero ce l'ha e non corrisponde a nessuno è una persona nuova,
    non la stessa scheda trovata per indirizzo. Cercare per email anche in quel
    caso fondeva in una sola scheda tutte le righe di un file esportato con lo
    stesso indirizzo di servizio (`info@salone.it`) — o madre e figlia — e
    l'import rispondeva «249 aggiornati» senza un solo errore. E anche la riga
    senza telefono trovata per email vale solo se il nome non è di un'altra
    persona: con l'indirizzo di famiglia la figlia senza numero rinominava la
    scheda della madre e le scriveva sopra compleanno e note (06-08).

    Righe senza telefono (o con un «telefono» senza una cifra: «n/d», «-»):
    non trovate per email, si cercano per nome fra le schede senza numero
    (`_Rubrica.without_phone`, con `name_index` per le omonime) e altrimenti
    entrano come schede senza numero. Prima venivano scartate: un salone
    arrivato da un altro gestionale perdeva le 114 clienti senza un numero
    valido.

    Numero già in rubrica con il nome di un'altra persona (`_same_holder`):
    la riga entra senza telefono e si contatta tramite chi ha il numero
    (`contact_client`), con un avviso e il conteggio in `linked`. Due schede
    non possono avere lo stesso numero (è l'identità per l'accesso all'app), e
    prima la seconda persona rinominava la prima. Se chi ha il numero non può
    fare da contatto (archiviata, o passa a sua volta da un'altra) la scheda
    entra senza numero e senza contatto, con l'avviso.

    Con update_existing=False i clienti già presenti non vengono toccati. Una
    scheda archiviata non si aggiorna né si riattiva da qui: la riga lo dice e
    indica la scheda (06-02), riattivarla è una scelta dello staff.
    Campi facoltativi: gender, birthday ('YYYY-MM-DD' | '--MM-DD'), origin,
    lang, note (nota privata), categories (nomi etichetta, create se mancanti),
    since ('YYYY-MM-DD', «cliente dal»), name_index. Un campo facoltativo
    illeggibile non fa perdere la riga: la cliente entra senza, e l'avviso
    finisce in `warnings` (06-13). Sulle schede esistenti si scrivono solo le
    colonne che cambiano (18-07).

    Ogni riga è scritta dentro il proprio savepoint: se il database la rifiuta
    (per esempio una scheda con la chiave telefono salvata da un algoritmo
    vecchio, 18-02) viene annullata da sola e finisce fra gli errori. Senza, il
    primo rifiuto interrompeva l'import a metà lasciando scritto quello che era
    già passato e un conteggio che non corrispondeva a niente.
    """
    created = updated = skipped = linked = 0
    errors: list[dict] = []
    warnings: list[dict] = []
    rubrica = _Rubrica(salon)
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
        counters = (created, updated, skipped, linked)
        categories_before = set(category_cache)
        warnings_before = len(warnings)
        born = touched = None
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
                try:
                    nth = max(0, int(row.get("name_index") or 0))
                except (TypeError, ValueError):
                    nth = 0

                key = phone_key(phone)
                if phone and not key:
                    # «n/d», «-», «da chiedere»: phone_key non ricava nemmeno
                    # una cifra. Tutte queste righe condividevano la chiave
                    # vuota e finivano l'una sopra l'altra sulla stessa scheda;
                    # poi venivano scartate. Sono righe senza numero.
                    warnings.append({
                        "row": index,
                        "reason": f"Telefono «{phone[:32]}» senza cifre: importata senza numero",
                    })
                    phone = ""

                client = None      # la scheda che la riga aggiorna
                contact = None     # chi ha già il numero della riga, se è un'altra persona
                note_for_new = ""  # l'avviso da dare se la scheda nasce ora
                by_email_only = False
                holder = rubrica.by_phone.get(key) if key else None
                if holder is not None and _same_holder(first_name, last_name, holder):
                    client = holder
                elif holder is not None:
                    # Lo stesso numero, un'altra persona: la scheda resta senza
                    # telefono (il numero è l'identità per l'app: uno per
                    # scheda) e i messaggi vanno a chi lo ha.
                    if holder.is_active and not holder.contact_client_id:
                        contact = holder
                        note_for_new = f"Il numero è di {holder.full_name}: importata senza telefono, si contatta tramite lei"
                    else:
                        why = "archiviata" if not holder.is_active else "passa a sua volta da un'altra cliente"
                        note_for_new = f"Il numero è di {holder.full_name} ({why}): importata senza telefono"
                    phone = ""
                    client = rubrica.without_phone(first_name, last_name, email, contact=contact)
                else:
                    if not phone:
                        client, email_holder = rubrica.same_email(email, first_name, last_name)
                        by_email_only = client is not None
                        if client is None and email_holder is not None:
                            # L'indirizzo di famiglia: la figlia senza numero
                            # non è la madre (06-08), è una scheda sua.
                            note_for_new = (
                                f"Senza telefono e con l'email di {email_holder.full_name}: "
                                "importata come scheda a parte"
                            )
                    if client is None and not phone:
                        client = rubrica.without_phone(first_name, last_name, email, nth=nth)

                if client is not None and not client.is_active:
                    errors.append({
                        "row": index,
                        "reason": f"Scheda archiviata: {client.full_name}. Riattivala dalla rubrica se è ancora cliente",
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
                    cached, client = client, Client.objects.get(pk=client.pk)  # istanza completa
                    values = {}
                    # Trovata per email, il nome della scheda resta il suo: la
                    # riga lo ha solo confermato (anche scritto senza accenti).
                    # Lo stesso se la riga ha le stesse parole del nome in un
                    # altro ordine o senza accenti («Rossi Maria», «nicolo»):
                    # la scheda tiene come è scritta.
                    same_words = name_key(first_name, last_name) == name_key(client.first_name, client.last_name)
                    if first_name and not by_email_only and not same_words:
                        values["first_name"] = first_name
                    if last_name and not same_words and (not by_email_only or not client.last_name):
                        values["last_name"] = last_name
                    if email:
                        values["email"] = email
                    # Il telefono non si riscrive mai: qui si arriva o con lo
                    # stesso numero della scheda (match per telefono) o senza
                    # numero (match per email o per nome). Prima veniva
                    # sostituito, e il contatto della scheda finiva per essere
                    # quello dell'ultima riga del file.
                    if contact is not None and not client.contact_client_id and not client.phone:
                        values["contact_client_id"] = contact.id
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
                        touched = (cached, client)
                    if "contact_client_id" in changed:
                        linked += 1
                    updated += 1
                else:
                    if not first_name:
                        errors.append({"row": index, "reason": "Nome mancante"})
                        skipped += 1
                        del warnings[warnings_before:]
                        continue
                    if phone and normalize_phone(phone) is None:
                        # «348 221 0094 / 06 1234567», «3,93482E+11» di Excel: la
                        # scheda nasce col testo com'è, ma OTP e promemoria non
                        # partiranno finché qualcuno non lo corregge (14-15).
                        warnings.append({"row": index, "reason": "Telefono non riconosciuto: salvato com'è, da correggere"})
                    client = born = Client.objects.create(
                        salon=salon,
                        first_name=first_name,
                        last_name=last_name,
                        email=email,
                        phone=canonical_phone(phone),
                        contact_client=contact,
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
                    rubrica.remember(client)
                    created += 1
                    if contact is not None:
                        linked += 1
                    if note_for_new:
                        warnings.append({"row": index, "reason": note_for_new, "client_id": client.id})

                if categories:
                    client.categories.add(*[category_for(name) for name in categories])
                # Reimportare lo stesso file non duplica le note (06-15).
                if note and not ClientNote.objects.filter(client=client, text=note).exists():
                    ClientNote.objects.create(client=client, text=note, author=actor)
            # Solo a riga scritta: se il database la rifiuta, la scheda resta com'era.
            if touched is not None:
                rubrica.refresh(*touched)
        except (IntegrityError, DataError) as exc:
            created, updated, _, linked = counters
            if born is not None:
                rubrica.forget(born)
            for key in set(category_cache) - categories_before:
                category_cache.pop(key, None)
            del warnings[warnings_before:]
            errors.append({"row": index, "reason": f"Riga rifiutata dal database: {exc}"})
            skipped = counters[2] + 1

    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "linked": linked,
        "errors": errors,
        "warnings": warnings,
    }
