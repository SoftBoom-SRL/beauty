"""Passo «clients»: anagrafica, numeri condivisi, note, etichette.

- **Telefono.** `common.phone` come il resto di beauty, più una correzione: 11
  cifre senza «+» che cominciano per 1 sono numeri americani o canadesi (la
  clientela è in buona parte straniera), non italiani da far precedere da +39.
- **Numero condiviso** (madre e figlia, amiche): il numero resta a una scheda
  sola — la prima iscritta — e le altre lo lasciano vuoto e la indicano come
  `contact_client`, così i messaggi arrivano comunque.
- **Clienti già in beauty** con lo stesso numero (prenotate dall'app nel
  frattempo) si collegano invece di farne un doppione. Le schede già importate
  non si riscrivono: in beauty il salone può averle corrette.
- **Lingua** dal prefisso: italiano per +39 e per chi non ha numero, inglese
  per gli altri. **Consensi**: privacy sì (il salone li tratta da anni), marketing
  e addebito su carta no, da raccogliere di nuovo.
- **Compleanno** con anno 1900 = anno non detto.
"""

import datetime as dt
import re
from collections import defaultdict

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

from apps.clients.models import Client, ClientCategory, ClientNote
from common.phone import canonical_phone, phone_key

from ..source import ROME, day, local_dt, ms_dt
from ..util import clip, norm


def import_phone(raw) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    digits = re.sub(r"\D", "", text)
    if len(digits) < 6:
        # «n/d», «-», un numero a metà: niente numero (due schede con lo stesso
        # testo non normalizzabile violerebbero il vincolo sul telefono).
        return ""
    if not text.startswith(("+", "00")) and len(digits) == 11 and digits.startswith("1"):
        text = "+" + digits
    return canonical_phone(text)


def run(ctx):
    details = ctx.source.client_details
    groups = {g["Id"]: clip(g.get("Descrizione"), 60) for g in ctx.source.client_groups}
    rows = []
    for row in ctx.source.clients_list:
        rec = details.get(row["Id"]) or {}
        rows.append(_record(row, rec))

    # Il numero va alla prima iscritta; le altre schede con lo stesso numero lo lasciano.
    by_key = defaultdict(list)
    for r in rows:
        key = phone_key(r["phone"]) if r["phone"] else ""
        if key:
            by_key[key].append(r)
    holder_of = {}
    for same in by_key.values():
        same.sort(key=lambda r: (r["since"] or dt.date.max, r["id"]))
        for r in same[1:]:
            holder_of[r["id"]] = same[0]["id"]
            r["shared_phone"] = r["phone"]
            r["phone"] = ""
        if len(same) > 1:
            ctx.count("numeri condivisi", 1)

    # Numeri già presenti nel salone: quelli di schede non importate si
    # collegano; quelli di schede già importate (un nuovo export con una
    # cliente in più sullo stesso numero) diventano un «contatto tramite».
    linked_ids = set(ctx.refs("cliente").values())
    taken, unlinked = {}, {}
    for c in Client.objects.filter(salon=ctx.salon).exclude(phone_key=""):
        taken[c.phone_key] = c.pk
        if c.pk not in linked_ids:
            unlinked[c.phone_key] = c

    new_refs = []
    late_contacts = []
    for r in rows:
        if ctx.ref("cliente", r["id"]):
            ctx.count("clienti già importate")
            continue
        key = phone_key(r["phone"]) if r["phone"] else ""
        if key and key in unlinked:
            new_refs.append((r["id"], unlinked.pop(key)))
            ctx.count("clienti già in beauty, collegate")
            continue
        if key and key in taken:
            late_contacts.append((r["id"], taken[key]))
            r["shared_phone"], r["phone"] = r["phone"], ""
        client = Client.objects.create(
            salon=ctx.salon,
            first_name=r["first_name"] or "Cliente",
            last_name=r["last_name"],
            phone=r["phone"],
            email=r["email"],
            lang=Client.Lang.IT if not r["phone"] or r["phone"].startswith("+39") else Client.Lang.EN,
            gender=r["gender"],
            birthday=r["birthday"],
            birthday_year_known=r["birthday_year_known"],
            since=r["since"],
            consents={"privacy": True, "marketing": False, "card_charge": False},
        )
        new_refs.append((r["id"], client))
        ctx.count("clienti create")
        if not r["phone"] and not r.get("shared_phone"):
            ctx.count("clienti senza telefono")
        _notes(ctx, client, r)
        if r["group"] and groups.get(r["group"]):
            category, made = ClientCategory.objects.get_or_create(salon=ctx.salon, name=groups[r["group"]])
            client.categories.add(category)
            ctx.count("clienti con etichetta")
            if made:
                ctx.count("etichette create")
    for ext, client in new_refs:
        ctx.link("cliente", ext, client)

    # Chi condivide il numero si contatta tramite la titolare del numero.
    refs = ctx.refs("cliente")
    pairs = [(refs.get(ext), refs.get(holder_ext)) for ext, holder_ext in holder_of.items()]
    pairs += [(refs.get(ext), holder_pk) for ext, holder_pk in late_contacts]
    for pk, holder_pk in pairs:
        if pk and holder_pk and pk != holder_pk:
            if Client.objects.filter(pk=pk, contact_client__isnull=True, phone="").update(contact_client_id=holder_pk):
                ctx.count("schede contattate tramite un'altra")


def _record(row, rec) -> dict:
    customer = rec.get("customer") or {}
    cust = customer.get("Customer") or {}
    phone_raw = row.get("Phone") or customer.get("Mobile") or ""
    email = (row.get("Email") or customer.get("Email") or "").strip()
    try:
        validate_email(email)
    except ValidationError:
        email = ""
    birthday, year_known = _birthday(row, cust)
    registered = local_dt(row.get("RegistrationDateStr")) or local_dt(cust.get("DataIscrizione"))
    if registered is None and ms_dt(row.get("RegistrationDate")):
        registered = ms_dt(row.get("RegistrationDate")).astimezone(ROME)
    others = []
    primary = re.sub(r"\D", "", phone_raw)
    for c in cust.get("Contatti") or []:
        value = (c.get("Valore") or "").strip()
        if c.get("Tipo") in (1, 2) and value and re.sub(r"\D", "", value) != primary:
            others.append(value)
    for extra in (customer.get("Mobile2"), customer.get("Phone")):
        extra = (extra or "").strip()
        if extra and re.sub(r"\D", "", extra) != primary and extra not in others:
            others.append(extra)
    return {
        "id": row["Id"],
        "first_name": clip(row.get("Name") or cust.get("Nome"), 80),
        "last_name": clip(row.get("Surname") or cust.get("Cognome"), 80),
        "phone": import_phone(phone_raw)[:32],
        "email": email[:254],
        "gender": {1: Client.Gender.FEMALE, 2: Client.Gender.MALE}.get(row.get("Sesso") or cust.get("Sesso"), ""),
        "birthday": birthday,
        "birthday_year_known": year_known,
        "since": registered.date() if registered else None,
        "registered": registered,
        "group": customer.get("IdGruppo"),
        "note": (cust.get("Note") or "").strip(),
        "planning_note": (cust.get("NotePlanning") or customer.get("NotePlanning") or "").strip(),
        "other_phones": others,
        "discount": row.get("ScontoPercentuale") or 0,
    }


def _birthday(row, cust):
    d = day(cust.get("DataNascita")) or day(row.get("DataNascitaStr"))
    if d is None and ms_dt(row.get("DataNascita")):
        d = ms_dt(row.get("DataNascita")).astimezone(ROME).date()
    if d is None:
        return None, True
    if d.year == 1900:
        return d.replace(year=Client.BIRTHDAY_YEAR_UNKNOWN), False
    return d, True


def _notes(ctx, client, r):
    texts = []
    if r["note"]:
        texts.append(("note", r["note"]))
    if r["planning_note"] and norm(r["planning_note"]) != norm(r["note"]):
        texts.append(("planning", f"Nota per l'agenda: {r['planning_note']}"))
    if r["other_phones"] or r.get("shared_phone"):
        numbers = list(r["other_phones"])
        if r.get("shared_phone"):
            numbers.insert(0, f"{r['shared_phone']} (condiviso)")
        texts.append(("recapiti", "Altri numeri in AreaBeauty: " + ", ".join(numbers)))
    if r["discount"]:
        texts.append(("sconto", f"In AreaBeauty aveva uno sconto fisso del {r['discount']}%."))
    for kind, text in texts:
        ext = f"{r['id']}:{kind}"
        if ctx.ref("nota", ext):
            continue
        note = ClientNote.objects.create(client=client, text=text, visibility=ClientNote.Visibility.PRIVATE)
        if r["registered"]:
            ctx.backdate(note, created_at=r["registered"], updated_at=r["registered"])
        ctx.link("nota", ext, note)
        ctx.count("note")
