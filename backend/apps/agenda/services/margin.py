"""Margine stimato di una visita: ricavi meno costi fornitore/prodotto e manodopera."""

from decimal import Decimal

from common.money import CENT


def appointment_margin(appointment) -> dict:
    """Ricavi (prezzi concordati) meno costi fornitore/prodotto (listino corrente) e manodopera.

    La manodopera è la durata attiva di ogni servizio al costo orario di chi lo fa.
    """
    revenue = supplier_cost = product_cost = labor_cost = Decimal("0")
    for item in appointment.items.select_related("service", "operator"):
        revenue += item.price
        supplier_cost += item.service.supplier_cost
        product_cost += item.service.product_cost
        labor_cost += Decimal(item.duration_min) / Decimal("60") * item.operator.hourly_cost
    labor_cost = labor_cost.quantize(CENT)
    margin = revenue - supplier_cost - product_cost - labor_cost
    margin_pct = (
        (margin / revenue * Decimal("100")).quantize(Decimal("0.1"))
        if revenue
        else Decimal("0")
    )
    return {
        "revenue": revenue,
        "supplier_cost": supplier_cost,
        "product_cost": product_cost,
        "labor_cost": labor_cost,
        "margin": margin,
        "margin_pct": margin_pct,
    }
