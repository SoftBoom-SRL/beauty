"""Portafoglio della cliente nell'app: le sue gift card, i suoi coupon, i suoi programmi fedeltà.

Stava dentro l'endpoint `client_wallet` di api.py. Le regole su cosa la
cliente vede e cosa può spendere sono le stesse dell'agenda (`gift_index`,
contratto C3).
"""

from django.db.models import Q
from django.utils import timezone

from .codes import not_expired_q
from .models import Coupon, GiftCard, LoyaltyAccount


def client_wallet(salon, client) -> dict:
    """{gift_cards, coupons, loyalty} della cliente nel salone, per `WalletOut`."""
    now = timezone.now()
    # Il portafoglio filtrava solo su status=ACTIVE, ma EXPIRED si scrive
    # soltanto quando qualcuno prova a riscattare: una carta scaduta da mesi
    # continuava a comparire nel «Saldo totale» e la cassa poi la rifiutava
    # davanti alla cliente. La scadenza va quindi verificata in lettura.
    not_expired = not_expired_q(now)
    # Le carte ancora da pagare restano visibili a CHI LE HA COMPRATE (l'app le
    # mostra con l'etichetta «Da pagare in salone»: nasconderle farebbe sparire
    # un acquisto appena fatto), ma non a chi le riceve: annunciare a una
    # destinataria un credito che il salone non ha ancora incassato significa
    # farglielo rifiutare in cassa. È la stessa regola dell'agenda, che tra i
    # regali prenotabili conta solo le carte pagate.
    mine = Q(payment_status=GiftCard.PaymentStatus.PAID) & (
        Q(buyer_client=client) | Q(recipient_client=client)
    ) | Q(payment_status=GiftCard.PaymentStatus.UNPAID, buyer_client=client)
    cards = list(
        GiftCard.objects.filter(salon=salon, status=GiftCard.Status.ACTIVE)
        .filter(not_expired)
        .filter(mine)
        .select_related("gift_service", "buyer_client")
        .order_by("-created_at")
    )
    for card in cards:
        card._received = card.recipient_client_id == client.id
        # Contratto C3, stessa regola di gift_index nell'agenda: pagata, con
        # saldo (attiva e non scaduta la filtra già la query), e sua — ne è la
        # destinataria, oppure l'ha comprata lei senza intestarla a nessuno.
        # Una carta comprata «per Maria» (nome scritto a mano) è di Maria.
        card._spendable = (
            card.payment_status == GiftCard.PaymentStatus.PAID
            and card.balance > 0
            and (
                card._received
                or (
                    card.buyer_client_id == client.id
                    and card.recipient_client_id is None
                    and card.recipient_name == ""
                )
            )
        )
    coupons = (
        Coupon.objects.filter(
            salon=salon, client=client, status=Coupon.Status.ACTIVE
        )
        .filter(not_expired_q(now))
        .order_by("-created_at")
    )
    loyalty = []
    accounts = LoyaltyAccount.objects.filter(
        client=client, program__salon=salon, program__active=True
    ).select_related("program")
    for account in accounts:
        program = account.program
        progress = (
            min(100, int(account.points * 100 / program.threshold))
            if program.threshold
            else 0
        )
        loyalty.append(
            {
                "program_id": program.id,
                "program_name": program.name,
                "type": program.type,
                "color": program.color,
                "points": account.points,
                "threshold": program.threshold,
                "progress_pct": progress,
            }
        )
    return {"gift_cards": list(cards), "coupons": list(coupons), "loyalty": loyalty}
