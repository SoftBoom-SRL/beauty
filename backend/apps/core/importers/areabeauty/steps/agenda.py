"""Passo «agenda»: dalle righe del planning agli appuntamenti di beauty, più annullati e no-show.

In AreaBeauty ogni servizio prenotato è una riga con i suoi orari; in beauty un
appuntamento è una catena di voci in fila. Per ogni cliente, giorno e stato:

1. DEPOSIT e GIFT CERTIFICATE escono dall'agenda: sono la caparra e il buono
   cartaceo, non trattamenti (restano nelle vendite).
2. Un servizio della stessa operatrice tutto dentro un servizio più lungo è un
   aggiuntivo (rimozione, scrub, nail art): voce a durata 0 subito dopo il
   servizio che lo ospita, con il suo prezzo. L'agenda resta com'era.
3. Il resto si mette in fila solo se un servizio comincia quando finisce il
   precedente E lo fa la stessa operatrice. Con un buco, anche di pochi
   minuti, o con una collega, comincia un altro appuntamento della stessa
   cliente: in AreaBeauty erano blocchi separati, ognuno nella colonna della
   sua operatrice e spostabile da solo. Trasformare il buco in attesa
   inventava una posa che nessuno aveva messo; unire le colleghe metteva la
   visita sotto una sola persona in vista settimana (il titolare, 15/10).
   Chi si accavalla (servizi in parallelo con una collega) è un appuntamento
   a sé, segnato `forced` se l'operatrice è la stessa.
4. Nessuna posa (`soak_min` = 0). La «fine lato cliente» delle righe di
   AreaBeauty non è una posa: è il blocco della cliente allungato a mano, a
   volte di ore (il titolare, 15/10: «nessuno ha messo attese o pose»).

Stato di ogni riga:
- eseguita → `closed` (anche oggi);
- non eseguita, da oggi in poi → `confirmed`;
- passata, non eseguita ma venduta → `no_show`: la cliente aveva pagato e non
  è venuta, l'incasso resta (decisione del titolare, 15/10);
- passata, mai eseguita né venduta → `cancelled`, senza motivo.

Gli annullati di AreaBeauty (riepiloghi delle clienti e lista completa) sono un
servizio solo ciascuno: `cancelled` con il motivo, oppure `no_show` se il
motivo è «non si è presentata».

Rilanciato su un export più recente, il passo rifà da capo gli appuntamenti
ancora aperti che aveva importato (senza conto): nel frattempo in AreaBeauty
possono essere stati spostati, eseguiti o annullati. Quelli chiusi restano.
"""

import datetime as dt
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal

from apps.agenda.models import Appointment, AppointmentService

from ..source import PSEUDO_SERVICE_IDS, local_dt, money, ms_dt
from ..util import clip, norm
from .staff import fallback_operator

S = Appointment.Status
NO_SHOW_MOTIVE_ID = 3


@dataclass
class Row:
    guid: str
    client: str
    op: str
    service: str
    s: dt.datetime
    e: dt.datetime
    price: Decimal
    status: str
    note: str = ""
    online: bool = False
    created: dt.datetime | None = None
    modified: dt.datetime | None = None
    addons: list = field(default_factory=list)


def run(ctx):
    _drop_open_imported(ctx)
    list_prices = {str(s["Id"]): money(s.get("Prezzo")) for s in ctx.source.services}
    groups = defaultdict(list)
    for raw in ctx.source.planning_rows:
        guid = raw.get("id_appuntamentoGuid") or f"id:{raw.get('id_appuntamento')}"
        if ctx.ref("appuntamento", guid):
            ctx.count("righe già importate")
            continue
        if str(raw.get("id_articolo")) in {str(i) for i in PSEUDO_SERVICE_IDS}:
            ctx.count("righe caparra o buono cartaceo, fuori dall'agenda")
            continue
        row = _row(ctx, raw, guid, list_prices)
        if row is None:
            continue
        groups[(row.client, row.s.date(), row.status)].append(row)

    plans = []
    for (client, _day, status), rows in groups.items():
        chains = _chains(rows)
        _mark_forced(chains, plans_for=status)
        for chain, forced in chains:
            plans.append((client, status, chain, forced))
    _create(ctx, plans)
    _cancellations(ctx)


def _drop_open_imported(ctx):
    """Gli appuntamenti aperti importati da un export precedente si rifanno."""
    ids = set(ctx.refs("appuntamento").values())
    if not ids:
        return
    stale = Appointment.objects.filter(
        salon=ctx.salon, pk__in=ids, status=S.CONFIRMED,
        sale__isnull=True, deposit_sale__isnull=True, paid_in_sale__isnull=True,
    ).values_list("pk", flat=True)
    stale = list(stale)
    if stale:
        Appointment.objects.filter(pk__in=stale).delete()
        ctx.unlink("appuntamento", stale)
        ctx.count("appuntamenti aperti rifatti dall'export nuovo", len(stale))


def _row(ctx, raw, guid, list_prices):
    s, e = local_dt(raw.get("start_date")), local_dt(raw.get("end_date"))
    if s is None or e is None:
        ctx.warn(f"riga {guid}: orari illeggibili, saltata")
        return None
    e = max(e, s)
    sold = bool(str(raw.get("id_transazione") or "").strip())
    done = bool(raw.get("eseguito"))
    if done:
        status = S.CLOSED
    elif s.date() >= ctx.today:
        status = S.CONFIRMED
    elif sold:
        status = S.NO_SHOW
    else:
        status = S.CANCELLED
    paid = raw.get("importo_pagato")
    price = money(paid) if sold and paid is not None else list_prices.get(str(raw.get("id_articolo")), Decimal("0"))
    return Row(
        guid=guid,
        client=raw.get("id_cliente"),
        op=raw.get("id_operatore"),
        service=str(raw.get("id_articolo")),
        s=s,
        e=e,
        price=price,
        status=status,
        note=(raw.get("nota") or "").strip(),
        online=bool(raw.get("isPrenotazioneOnline")),
        created=ms_dt(raw.get("dataCreazione")),
        modified=ms_dt(raw.get("dataModifica")),
    )


def _chains(rows):
    """[(catena di servizi principali, forced)] per le righe di una cliente in un giorno."""
    rows = sorted(rows, key=lambda r: (r.s, -(r.e - r.s)))
    mains = []
    for r in rows:
        host = next(
            (m for m in mains if m.op == r.op and m.s <= r.s and r.e <= m.e and (r.e - r.s) < (m.e - m.s)),
            None,
        )
        if host is not None:
            host.addons.append(r)
        else:
            mains.append(r)
    chains = []
    for m in sorted(mains, key=lambda m: m.s):
        for ch in chains:
            last = ch[-1]
            if m.s == last.e and m.op == last.op:
                ch.append(m)
                break
        else:
            chains.append([m])
    return [[ch, False] for ch in chains]


def _mark_forced(chains, plans_for):
    """Una catena che si accavalla con un'altra della stessa operatrice è «forzata»."""
    if plans_for in (S.CANCELLED, S.NO_SHOW):
        return
    for i, (chain, _) in enumerate(chains):
        for other, _f in chains[:i]:
            if any(a.op == b.op and a.s < b.e and b.s < a.e for a in chain for b in other):
                chains[i][1] = True
                break


def _create(ctx, plans):
    clients = ctx.refs("cliente")
    services = ctx.refs("servizio")
    operators = ctx.refs("operatore")
    fallback = None
    appointments, items_of, rows_of = [], [], []
    for client_ext, status, chain, forced in plans:
        client_pk = clients.get(client_ext)
        if not client_pk:
            ctx.count("appuntamenti di clienti sconosciute saltati")
            continue
        items = []
        order = 0
        for m in chain:
            for r, duration in [(m, m.e - m.s)] + [(a, dt.timedelta(0)) for a in m.addons]:
                service_pk = services.get(r.service)
                if not service_pk:
                    ctx.warn(f"servizio {r.service} sconosciuto: voce {r.guid} saltata")
                    continue
                op_pk = operators.get(r.op)
                if not op_pk:
                    fallback = fallback or fallback_operator(ctx)
                    op_pk = fallback.pk
                items.append(
                    AppointmentService(
                        service_id=service_pk,
                        operator_id=op_pk,
                        duration_min=int(duration.total_seconds() // 60),
                        soak_min=0,
                        price=r.price,
                        order=order,
                    )
                )
                order += 1
                if r is not m:
                    ctx.count("aggiuntivi dentro un servizio")
        if not items:
            continue
        rows = [r for m in chain for r in [m, *m.addons]]
        notes = []
        for r in rows:
            if r.note and r.note not in notes:
                notes.append(r.note)
        created = min((r.created for r in rows if r.created), default=None)
        modified = max((r.modified for r in rows if r.modified), default=None)
        appointments.append(
            Appointment(
                salon=ctx.salon,
                location=ctx.location,
                client_id=client_pk,
                operator_id=items[0].operator_id,
                start=chain[0].s,
                status=status,
                note="\n".join(notes),
                created_via=Appointment.CreatedVia.APP if any(r.online for r in rows) else Appointment.CreatedVia.DASHBOARD,
                forced=forced,
            )
        )
        appointments[-1]._dates = (created, modified or created)
        items_of.append(items)
        rows_of.append(rows)
        ctx.count(f"appuntamenti {status}")
        if forced:
            ctx.count("appuntamenti in parallelo con la stessa operatrice (forzati)")

    _save(ctx, appointments, items_of)
    ctx.link_many("appuntamento", [(r.guid, a) for a, rows in zip(appointments, rows_of) for r in rows])


def _save(ctx, appointments, items_of):
    Appointment.objects.bulk_create(appointments, batch_size=500)
    all_items = []
    for appointment, items in zip(appointments, items_of):
        for item in items:
            item.appointment = appointment
            all_items.append(item)
    AppointmentService.objects.bulk_create(all_items, batch_size=1000)
    dated = []
    for a in appointments:
        created, modified = getattr(a, "_dates", (None, None))
        if created:
            a.created_at, a.updated_at = created, modified or created
            dated.append(a)
    Appointment.objects.bulk_update(dated, ["created_at", "updated_at"], batch_size=500)


def _cancellations(ctx):
    clients = ctx.refs("cliente")
    services = ctx.refs("servizio_mybooker")
    operators = ctx.refs("operatore")
    appointments, items_of, exts = [], [], []
    fallback = None
    for c in ctx.source.cancellations:
        ext = c["IdAppuntamento"]
        if ctx.ref("annullato", ext):
            continue
        client_pk = clients.get(c.get("ClienteId"))
        service_pk = services.get(c.get("ServizioId"))
        start, end = ms_dt(c.get("DataOraInizio")), ms_dt(c.get("DataOraFine"))
        if not client_pk:
            ctx.count("annullati di clienti sconosciute saltati")
            continue
        if not service_pk:
            ctx.count("annullati con servizio sconosciuto saltati")
            continue
        if start is None:
            ctx.count("annullati senza data saltati")
            continue
        op_pk = operators.get(c.get("OperatoreId"))
        if not op_pk:
            fallback = fallback or fallback_operator(ctx)
            op_pk = fallback.pk
            ctx.count("annullati senza operatrice (ripiego)")
        end = end if end and end >= start else start
        motive = c.get("Motivazione") or {}
        motive_text = (motive.get("Descrizione") or "").strip()
        no_show = motive.get("Id") == NO_SHOW_MOTIVE_ID or "non si e presentat" in norm(motive_text)
        reason = " — ".join(x for x in (motive_text, (c.get("NoteAnnullamento") or "").strip()) if x)
        appointment = Appointment(
            salon=ctx.salon,
            location=ctx.location,
            client_id=client_pk,
            operator_id=op_pk,
            start=start,
            status=S.NO_SHOW if no_show else S.CANCELLED,
            cancel_reason=clip(reason, 255),
            note=(c.get("Note") or "").strip(),
            created_via=Appointment.CreatedVia.APP if c.get("isPrenotazioneOnLine") else Appointment.CreatedVia.DASHBOARD,
        )
        created = ms_dt(c.get("DataCreazione"))
        appointment._dates = (created, ms_dt(c.get("DataAnnullamento")) or created)
        appointments.append(appointment)
        items_of.append([
            AppointmentService(
                service_id=service_pk,
                operator_id=op_pk,
                duration_min=int((end - start).total_seconds() // 60),
                soak_min=0,
                price=money(c.get("Prezzo")),
            )
        ])
        exts.append(ext)
        ctx.count("no-show" if no_show else "annullati")
    _save(ctx, appointments, items_of)
    ctx.link_many("annullato", list(zip(exts, appointments)))
