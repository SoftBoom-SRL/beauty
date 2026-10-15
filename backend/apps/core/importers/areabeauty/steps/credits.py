"""Passo «credits»: gift box, servizi già pagati da fare, gift card a pacchetto.

- **Gift box** (i «coupon» di AreaBeauty): un servizio, un utilizzo, 180 giorni.
  Diventano `GiftCard` regalo con `gift_service` e lo STESSO codice stampato
  sulla scatola (`CodiceShort`), così la cliente che si presenta con la gift
  box viene riconosciuta. Usate → esaurite; annullate o oltre la validità →
  scadute.
- **Servizi già pagati** (righe di vendita «Da eseguire» / «Prenotato» non
  eseguite): la cliente li ha pagati e deve ancora farli. Diventano carte
  `prepaid` intestate a lei, una per vendita e servizio, con tante sedute
  quante le righe. Ci sono quelli mai prenotati e quelli già in agenda nei
  prossimi giorni: la visita mostrerà «Già pagato». Le righe di visite passate
  non fatte non sono crediti: sono no-show (vedi «agenda»).
- **Gift card a pacchetto** (pacchetti fuori listino «GIFT CARD …»): le sedute
  non ancora usate diventano carte regalo, scadute se la validità è passata.

Rilanciato su un export più recente, il passo crea le carte nuove e aggiorna
quelle già importate: una gift box usata nel frattempo diventa esaurita, una
seduta già pagata e poi fatta in AreaBeauty scala la sua carta.
"""

import datetime as dt
from collections import defaultdict
from decimal import ROUND_DOWN, Decimal

from django.utils import timezone

from apps.marketing.models import GiftCard
from common.utils import human_code

from ..source import CENT, ROME, local_dt, money, ms_dt
from ..util import clip

G = GiftCard.Status


def run(ctx):
    codes = set(GiftCard.objects.filter(salon=ctx.salon).values_list("code", flat=True))
    _gift_boxes(ctx, codes)
    _prepaid(ctx, codes)


def _now(ctx):
    return dt.datetime.combine(ctx.today, dt.time(0, 0), tzinfo=ROME)


# --- gift box -----------------------------------------------------------------
def _gift_boxes(ctx, codes):
    clients = ctx.refs("cliente")
    services = ctx.refs("servizio")
    uses = ctx.source.coupon_uses
    for c in ctx.source.coupons:
        ext = int(c["IdCoupon"])
        used = int(c.get("NrUtilizzi") or 0) > 0 or bool(uses.get(ext))
        expires = ms_dt(c.get("ValidoAl"))
        if used:
            status = G.REDEEMED
        elif c.get("FlagAnnullato") or (expires and expires < _now(ctx)):
            status = G.EXPIRED
        else:
            status = G.ACTIVE
        value = money(c.get("TotaleListinoVendita"))
        pk = ctx.ref("coupon", ext)
        if pk:
            n = GiftCard.objects.filter(pk=pk).exclude(status=status).update(
                status=status,
                balance=Decimal("0") if used else value,
                sessions_left=0 if used else 1,
            )
            ctx.count("gift box aggiornate" if n else "gift box già importate")
            continue
        code = _code(c.get("CodiceShort"), codes)
        service_id = services.get(str(c.get("IdArticoloGiftbox"))) if c.get("IdArticoloGiftbox") else None
        card = GiftCard.objects.create(
            salon=ctx.salon,
            kind=GiftCard.Kind.GIFT,
            code=code,
            initial_value=value,
            balance=Decimal("0") if used else value,
            gift_service_id=service_id,
            sessions_total=1,
            sessions_left=0 if used else 1,
            buyer_client_id=clients.get(c.get("IdClienteVendita")),
            recipient_client_id=clients.get(c.get("IdCliente")),
            recipient_name=clip(c.get("NominativoCliente"), 120),
            payment_status=GiftCard.PaymentStatus.PAID,
            paid_at=ms_dt(c.get("DataCreazione")),
            expires_at=expires,
            status=status,
        )
        created = ms_dt(c.get("DataCreazione"))
        if created:
            ctx.backdate(card, created_at=created)
        ctx.link("coupon", ext, card)
        ctx.count(f"gift box {status}")


def _code(wanted, codes) -> str:
    """Il codice della gift box se è libero; altrimenti uno nuovo (mai due uguali nel salone)."""
    wanted = (wanted or "").strip().upper()[:16]
    if wanted and wanted not in codes:
        codes.add(wanted)
        return wanted
    while True:
        code = human_code(12)
        if code not in codes:
            codes.add(code)
            return code


# --- servizi già pagati e gift card a pacchetto ------------------------------
def _open_lines(ctx):
    """{(vendita, servizio, pacchetto): [righe]} delle righe pagate e non ancora fatte.

    Esclude le righe la cui visita in agenda è già passata: fatte (consumate) o
    mancate (no-show, l'incasso resta al salone).
    """
    rows = {r.get("id_appuntamentoGuid"): r for r in ctx.source.planning_rows if r.get("id_appuntamentoGuid")}
    out = defaultdict(list)
    for tx, sale in ctx.source.sales.items():
        for line in sale.get("Servizi") or []:
            if line.get("Stato") != 12:
                continue
            row = rows.get(line.get("IdAppuntamento"))
            if row is not None:
                start = local_dt(row.get("start_date"))
                if row.get("eseguito") or start is None or start.date() < ctx.today:
                    continue
            key = (tx, int(line["IdServizio"]), int(line.get("IdPacchetto") or 0))
            out[key].append(line)
    return out


def _prepaid(ctx, codes):
    clients = ctx.refs("cliente")
    services = ctx.refs("servizio")
    packages = {int(p["Id"]): p for p in ctx.source.packages}
    open_lines = _open_lines(ctx)
    open_refs = {f"{tx}:{line['IdOperazione']}" for (tx, _s, _p), lines in open_lines.items() for line in lines}

    # Carte già importate: le righe nel frattempo fatte in AreaBeauty scalano le sedute.
    by_card = defaultdict(list)
    for ext, pk in ctx.refs("prepagato").items():
        by_card[pk].append(ext)
    for card in GiftCard.objects.filter(pk__in=list(by_card)):
        left = sum(1 for ext in by_card[card.pk] if ext in open_refs)
        if left < card.sessions_left:
            per = (card.initial_value / card.sessions_total).quantize(CENT, rounding=ROUND_DOWN) if card.sessions_total else Decimal("0")
            card.sessions_left = left
            card.balance = per * left if left else Decimal("0")
            card.status = G.REDEEMED if left == 0 else card.status
            card.save(update_fields=["sessions_left", "balance", "status"])
            ctx.count("crediti già importati scalati")

    for (tx, service_ab, package_ab), lines in open_lines.items():
        exts = [f"{tx}:{line['IdOperazione']}" for line in lines]
        if any(ctx.ref("prepagato", e) for e in exts):
            continue
        sale = ctx.source.sales[tx]
        client_pk = clients.get(sale.get("IdCliente"))
        service_pk = services.get(str(service_ab))
        if not client_pk or not service_pk:
            ctx.warn(f"vendita {tx}: credito senza cliente o servizio, saltato")
            continue
        value = sum((money(line.get("TotaleScontato")) for line in lines), Decimal("0"))
        sold_at = _sale_datetime(sale)
        expires = None
        kind = GiftCard.Kind.PREPAID
        if package_ab:
            kind = GiftCard.Kind.GIFT
            days = (packages.get(package_ab) or {}).get("GiorniValidita")
            if days and sold_at:
                expires = sold_at + dt.timedelta(days=int(days))
        if expires is None and ms_dt(sale.get("DataScadenza")):
            expires = ms_dt(sale.get("DataScadenza"))
        status = G.EXPIRED if (expires and expires < _now(ctx)) or sale.get("Scaduta") else G.ACTIVE
        card = GiftCard.objects.create(
            salon=ctx.salon,
            kind=kind,
            code=_code("", codes),
            initial_value=value,
            balance=value,
            gift_service_id=service_pk,
            sessions_total=len(lines),
            sessions_left=len(lines),
            package_id=ctx.ref("pacchetto", package_ab) if package_ab else None,
            buyer_client_id=client_pk,
            recipient_client_id=client_pk,
            payment_status=GiftCard.PaymentStatus.PAID,
            paid_at=sold_at,
            expires_at=expires,
            status=status,
        )
        if sold_at:
            ctx.backdate(card, created_at=sold_at)
        ctx.link_many("prepagato", [(e, card) for e in exts])
        label = "gift card a pacchetto" if package_ab else "servizi già pagati"
        ctx.count(f"{label} ({status})")
        ctx.count(f"{label}, sedute", len(lines))


def _sale_datetime(sale):
    """Data e ora della vendita, ora del salone."""
    when = local_dt(f"{(sale.get('DataTransazione') or '')[:10]} {sale.get('OraTransazione') or '12:00'}")
    return when or (local_dt(sale.get("DataTransazione")) if sale.get("DataTransazione") else None) or timezone.now()
