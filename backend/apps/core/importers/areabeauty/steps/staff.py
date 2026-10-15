"""Passo «staff»: operatrici e ferie future.

Le operatrici già in beauty si riconoscono dal nome (e dal cognome, se c'è da
entrambe le parti) e si collegano senza toccarle. Le altre — chi non lavora più
in salone ma ha uno storico — si creano disattivate: appuntamenti e righe di
vendita le vogliono (PROTECT).

Le ferie e le assenze del planning si portano solo da oggi in poi, a giornata
intera: servono a non prenotare chi non c'è. Quelle passate non cambiano niente.
"""

import datetime as dt
from collections import Counter, defaultdict

from apps.staff.models import Absence, Operator

from ..source import local_dt
from ..util import clip, color, norm

FALLBACK_REF = "_non_indicata"
ABSENCE_TYPES = {"ferie": Absence.Type.VACATION, "assenza": Absence.Type.OTHER}


def run(ctx):
    existing = list(Operator.objects.filter(salon=ctx.salon))
    for o in ctx.source.operators:
        ext = o["Id"]
        if ctx.ref("operatore", ext):
            ctx.count("operatrici già collegate")
            continue
        first, last = clip(o.get("Nome"), 80), clip(o.get("Cognome"), 80)
        chosen = (ctx.mapping.get("operatrici") or {}).get(ext)
        match = None
        if chosen:
            # Il nome in beauty, oppure il suo id (per non scrivere nomi nel file).
            match = next(
                (op for op in existing if op.pk == chosen or norm(f"{op.first_name} {op.last_name}") == norm(chosen)),
                None,
            )
            if match is None:
                ctx.warn(f"corrispondenza: operatrice {ext} → nome non trovato in beauty")
        match = match or _match(existing, first, last)
        if match is not None:
            ctx.link("operatore", ext, match)
            ctx.count("operatrici collegate")
            continue
        op = Operator.objects.create(
            salon=ctx.salon,
            first_name=first or "Operatrice",
            last_name=last,
            color=color(o.get("Colore"), "#A5B4FC"),
            active=False,
            order=1000 + int(o.get("PosizionePlanning") or 0),
        )
        ctx.link("operatore", ext, op)
        ctx.count("operatrici create disattivate")
    _absences(ctx)


def _match(existing, first, last):
    nf, nl = norm(first), norm(last)
    candidates = [o for o in existing if norm(o.first_name) == nf]
    if nl:
        exact = [o for o in candidates if norm(o.last_name) == nl]
        if exact:
            return exact[0]
        candidates = [o for o in candidates if not norm(o.last_name)]
    if len(candidates) == 1:
        return candidates[0]
    full = norm(f"{first} {last}")
    by_full = [o for o in existing if norm(f"{o.first_name} {o.last_name}") == full]
    return by_full[0] if len(by_full) == 1 else None


def fallback_operator(ctx) -> Operator:
    """L'operatrice «non indicata»: per gli annullati di AreaBeauty senza operatrice."""
    pk = ctx.ref("operatore", FALLBACK_REF)
    if pk:
        return Operator.objects.get(pk=pk)
    op = Operator.objects.create(
        salon=ctx.salon, first_name="Operatrice", last_name="non indicata", color="#CBD5E1", active=False, order=2000
    )
    ctx.link("operatore", FALLBACK_REF, op)
    ctx.count("operatrice di ripiego creata")
    return op


def _absences(ctx):
    # La colonna del planning («unit») è dell'operatrice che ci lavora più spesso.
    by_unit = defaultdict(Counter)
    for row in ctx.source.planning_rows:
        for unit in row.get("unit") or []:
            by_unit[unit][row.get("id_operatore")] += 1
    unit_op = {u: c.most_common(1)[0][0] for u, c in by_unit.items() if c}

    for p in ctx.source.planning_presence:
        kind = ABSENCE_TYPES.get(norm(p.get("reason")))
        if kind is None:
            continue
        start, end = local_dt(p.get("start_date")), local_dt(p.get("end_date"))
        if start is None or end is None or not p.get("isAllDay"):
            continue
        first = start.date()
        last = (end - dt.timedelta(minutes=1)).date() if end.time() == dt.time(0, 0) else end.date()
        if last < ctx.today:
            continue
        op_pk = ctx.ref("operatore", unit_op.get(p.get("unit")))
        if not op_pk:
            ctx.count("assenze senza operatrice saltate")
            continue
        ext = f"{p.get('unit')}:{p.get('start_date')}:{kind}"
        if ctx.ref("assenza", ext):
            continue
        absence = Absence.objects.create(
            operator_id=op_pk, date_from=max(first, ctx.today), date_to=max(last, first), type=kind, note="Da AreaBeauty"
        )
        ctx.link("assenza", ext, absence)
        ctx.count("ferie e assenze future")
