"""Vendite, righe, pagamenti e link caparra come li restituiscono le API.

Dict pronti per gli schemi di risposta (schemas.py). Stavano in api.py come
funzioni private, e lo storico della scheda cliente (clients) importava
`_sale_out` da lì: qui sono pubbliche e non dipendono dalla richiesta HTTP.
"""

from decimal import Decimal

from .models import Sale, SaleLine


def operator_name(operator) -> str:
    if operator is None:
        return ""
    return operator.full_name


def line_out(line: SaleLine) -> dict:
    return {
        "id": line.id,
        "line_type": line.line_type,
        "operator_id": line.operator_id,
        "operator_name": operator_name(line.operator),
        "service_id": line.service_id,
        # Nome del servizio (C14): lo storico mostrava «Servizio #12».
        "service_name": line.service.name_it if line.service_id else "",
        "product_id": line.product_id,
        "product_name": line.product.name if line.product_id else "",
        "package_id": line.package_id,
        "package_name": line.package.name if line.package_id else "",
        "gift_card_code": line.gift_card.code if line.gift_card_id else None,
        "qty": line.qty,
        "unit_price": line.unit_price,
        "discount_pct": line.discount_pct,
        "is_gift": line.is_gift,
        "amount": line.amount,
        "coupon_share": line.coupon_share,
    }


def payment_out(payment) -> dict:
    return {
        "id": payment.id,
        "method": payment.method,
        "amount": payment.amount,
        "gift_card_code": payment.gift_card.code if payment.gift_card_id else None,
        "created_at": payment.created_at,
    }


def sale_out(sale: Sale) -> dict:
    return {
        "id": sale.id,
        "kind": sale.kind,
        "appointment_id": sale.appointment_id,
        "deposit_appointment_id": sale.deposit_appointment_id,
        "client_id": sale.client_id,
        "client_name": sale.client.full_name if sale.client_id else "",
        "location_id": sale.location_id,
        "total": sale.total,
        "coupon_discount": sale.coupon_discount,
        "deposit_deducted": sale.deposit_deducted,
        "amount_due": sale.amount_due,
        "receipt_issued": sale.receipt_issued,
        "created_at": sale.created_at,
    }


def sale_detail(sale: Sale) -> dict:
    return {
        **sale_out(sale),
        "lines": [
            line_out(line)
            for line in sale.lines.select_related("operator", "gift_card", "product", "service", "package")
        ],
        "payments": [payment_out(p) for p in sale.payments.select_related("gift_card")],
        "covered_appointment_ids": list(
            sale.covered_appointments.order_by("start", "id").values_list("id", flat=True)
        ),
    }


def operator_breakdown(sale: Sale) -> list[dict]:
    """Incassato per operatrice (righe senza operatrice raggruppate a parte)."""
    per_operator: dict = {}
    for line in sale.lines.select_related("operator"):
        entry = per_operator.setdefault(
            line.operator_id,
            {
                "operator_id": line.operator_id,
                "operator_name": operator_name(line.operator) or "Senza operatrice",
                "amount": Decimal("0.00"),
            },
        )
        entry["amount"] += line.amount
    return list(per_operator.values())


def deposit_link_out(appointment) -> dict:
    return {
        "url": appointment.deposit_payment_link,
        "amount": appointment.deposit_amount,
        "due_at": appointment.deposit_due_at,
    }
