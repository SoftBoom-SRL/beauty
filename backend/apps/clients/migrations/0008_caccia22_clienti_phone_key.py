"""Riallinea `Client.phone_key` (e il numero salvato) alla normalizzazione attuale.

La chiave è stata scritta dalla 0006 con l'algoritmo del 17/09 e non è mai più
stata ricalcolata, mentre `normalize_phone` è cambiata due volte (9991cb5 e la
caccia del 22/09). Per «393331234567» salvato grezzo la chiave in archivio è
«39393331234567», quella calcolata oggi «393331234567»: la cliente che chiede
l'OTP non viene trovata, si registra una seconda volta, e archiviare o
correggere la scheda vecchia urta il vincolo unico (18-02). Lo stesso vale per
i numeri che le regole nuove leggono diversamente (+40 0721…, +39 39 333…,
«380501234567» senza «+»).

Qui si ricalcolano tutte le chiavi e, quando il numero salvato è riconoscibile
ma non è in forma E.164 (o è la forma sbagliata del vecchio algoritmo), anche
il numero: l'OTP e i promemoria partono verso `Client.phone`, e una chiave
giusta con un numero sbagliato ritroverebbe la cliente per mandarle un codice
che non le arriva.

I doppioni non fermano la migrazione: una scheda la cui chiave nuova è già di
un'altra scheda dello stesso salone (la stessa persona, due schede) resta con
la chiave e il numero di prima e viene elencata qui sotto; li mostra anche
`manage.py check_phone_duplicates`, che dice come bonificarli.

L'algoritmo è COPIATO da common.phone (23/09/2026), non importato: una
migrazione deve dare lo stesso risultato anche quando il codice vivo cambierà.
"""

import re
import sys

from django.db import migrations

COUNTRY_CODES = (
    "1", "7",
    "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44",
    "45", "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58",
    "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91",
    "92", "93", "94", "95", "98",
    "211", "212", "213", "216", "218", "220", "221", "222", "223", "224", "225",
    "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236",
    "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247",
    "248", "249", "250", "251", "252", "253", "254", "255", "256", "257", "258",
    "260", "261", "262", "263", "264", "265", "266", "267", "268", "269", "290",
    "291", "297", "298", "299",
    "350", "351", "352", "353", "354", "355", "356", "357", "358", "359", "370",
    "371", "372", "373", "374", "375", "376", "377", "378", "379", "380", "381",
    "382", "383", "385", "386", "387", "389",
    "420", "421", "423",
    "500", "501", "502", "503", "504", "505", "506", "507", "508", "509", "590",
    "591", "592", "593", "594", "595", "596", "597", "598", "599",
    "670", "672", "673", "674", "675", "676", "677", "678", "679", "680", "681",
    "682", "683", "685", "686", "687", "688", "689", "690", "691", "692",
    "800", "808", "850", "852", "853", "855", "856", "870", "878", "880", "881",
    "882", "883", "886", "888",
    "960", "961", "962", "963", "964", "965", "966", "967", "968", "970", "971",
    "972", "973", "974", "975", "976", "977", "979", "992", "993", "994", "995",
    "996", "997", "998",
)
TRUNK_ZERO_KEPT = {"39", "378", "379", "225"}
NATIONAL_MAX_DIGITS = 11
_LONGEST_FIRST = sorted(COUNTRY_CODES, key=len, reverse=True)


def _country_code(digits):
    for cc in _LONGEST_FIRST:
        if digits.startswith(cc):
            return cc
    return None


def _normalize(raw):
    if not raw:
        return None
    s = re.sub(r"[^\d+]", "", str(raw).strip())
    if s.startswith("+"):
        digits = s[1:]
    elif s.startswith("00"):
        digits = s[2:]
    elif len(s) > NATIONAL_MAX_DIGITS and _country_code(s) is not None:
        digits = s
    else:
        digits = "39" + s
    cc = _country_code(digits)
    if cc is not None and cc not in TRUNK_ZERO_KEPT and digits[len(cc):].startswith("0"):
        digits = cc + digits[len(cc) + 1:]
    national = digits[2:]
    if digits.startswith("39") and len(national) > NATIONAL_MAX_DIGITS and national.startswith("39"):
        digits = "39" + national[2:]
    if not re.fullmatch(r"[1-9]\d{6,14}", digits):
        return None
    return "+" + digits


def _key(raw):
    normalized = _normalize(raw)
    if normalized:
        return normalized[1:]
    return re.sub(r"\D", "", raw or "")


def plan_salon(rows):
    """Chiavi e numeri da scrivere per le schede di UN salone.

    `rows`: [(id, phone, phone_key)] in ordine di id. Ritorna
    (key_moves, phone_moves, conflicts): gli spostamenti vanno applicati
    nell'ordine dato, perché una chiave può liberarsi solo dopo che la sua
    scheda ha preso quella nuova (il vincolo unico si controlla riga per riga).
    A parità di chiave vince chi già la possiede, poi l'id più basso.
    """
    current = {cid: key for cid, _, key in rows}
    held = {key: cid for cid, _, key in rows if key}
    wanted = {cid: _key(phone) for cid, phone, _ in rows}
    pending = [cid for cid, _, _ in rows if wanted[cid] != current[cid]]
    key_moves = []
    moved = True
    while pending and moved:
        moved = False
        waiting = []
        for cid in pending:
            target = wanted[cid]
            if target and target in held:
                waiting.append(cid)
                continue
            old = current[cid]
            if old and held.get(old) == cid:
                del held[old]
            if target:
                held[target] = cid
            current[cid] = target
            key_moves.append((cid, target))
            moved = True
        pending = waiting
    conflicts = [(cid, current[cid], wanted[cid], held.get(wanted[cid])) for cid in pending]

    # Il numero si riscrive solo sulle schede con la chiave ormai giusta, se la
    # forma E.164 non è già di un'altra scheda (vincolo unico su salone e
    # numero) e se è stabile: rinormalizzata dà sé stessa, così la chiave che
    # Client.save ricalcolerà domani dal numero nuovo è quella scritta oggi.
    # Un numero con delle parole («333 1234567 (mamma)») resta com'è: la
    # forma E.164 perderebbe l'annotazione.
    stuck = {cid for cid, *_ in conflicts}
    phones = {phone: cid for cid, phone, _ in rows}
    phone_moves = []
    for cid, phone, _ in rows:
        if cid in stuck or re.search(r"[^\d\s+()./-]", phone or ""):
            continue
        canonical = _normalize(phone)
        if not canonical or canonical == phone or _normalize(canonical) != canonical:
            continue
        if canonical in phones:
            continue
        del phones[phone]
        phones[canonical] = cid
        phone_moves.append((cid, canonical))
    return key_moves, phone_moves, conflicts


def recompute(apps, schema_editor):
    Client = apps.get_model("clients", "Client")
    out = sys.stdout
    keys = numbers = 0
    all_conflicts = []
    salon_ids = Client.objects.order_by().values_list("salon_id", flat=True).distinct()
    for salon_id in sorted(set(salon_ids)):
        rows = list(
            Client.objects.filter(salon_id=salon_id)
            .order_by("id")
            .values_list("id", "phone", "phone_key")
        )
        key_moves, phone_moves, conflicts = plan_salon(rows)
        for cid, key in key_moves:
            Client.objects.filter(pk=cid).update(phone_key=key)
        for cid, phone in phone_moves:
            Client.objects.filter(pk=cid).update(phone=phone)
        keys += len(key_moves)
        numbers += len(phone_moves)
        all_conflicts.extend((salon_id, *c) for c in conflicts)
    if not (keys or numbers or all_conflicts):
        return
    left = len(all_conflicts)
    left_text = "1 scheda lasciata com'era" if left == 1 else f"{left} schede lasciate com'erano"
    out.write(
        f"\n  clients.0008: {keys} chiavi telefono ricalcolate, {numbers} numeri riscritti "
        f"in forma E.164, {left_text} (doppioni).\n"
    )
    for salon_id, cid, kept, wanted, holder in all_conflicts:
        out.write(
            f"    salone #{salon_id} · scheda #{cid}: la chiave {wanted} è già della scheda "
            f"#{holder}, resta {kept or '(vuota)'} — vedi check_phone_duplicates\n"
        )


class Migration(migrations.Migration):
    dependencies = [("clients", "0007_client_phone_key_unique")]
    operations = [migrations.RunPython(recompute, migrations.RunPython.noop)]
