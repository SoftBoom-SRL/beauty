"""Catalogo del salone: categorie servizi, servizi (listino) e pacchetti.

Consumato da: staff (Operator.services M2M), agenda (snapshot durata/prezzo negli
appuntamenti), sales/inventory (stima margine via product_cost/supplier_cost),
marketing (LoyaltyProgram.reward_service). FK verso altre app sempre a stringa.
"""

from django.db import models


class ServiceCategory(models.Model):
    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="service_categories"
    )
    name_it = models.CharField(max_length=120)
    name_en = models.CharField(max_length=120, blank=True)
    color = models.CharField(max_length=7, default="#E0E7FF")  # hex pastello
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]
        verbose_name = "categoria servizio"
        verbose_name_plural = "categorie servizio"

    def __str__(self):
        return self.name_it


class Service(models.Model):
    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="services")
    category = models.ForeignKey(
        ServiceCategory, on_delete=models.PROTECT, related_name="services"
    )
    name_it = models.CharField(max_length=120)
    name_en = models.CharField(max_length=120, blank=True)
    duration_min = models.PositiveIntegerField()
    price = models.DecimalField(max_digits=10, decimal_places=2)
    # per stima margine (vedi agenda GET /appointments/{id}/margin)
    product_cost = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    supplier_cost = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    active = models.BooleanField(default=True)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self):
        return self.name_it


class Package(models.Model):
    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="packages")
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return self.name


class PackageItem(models.Model):
    package = models.ForeignKey(Package, on_delete=models.CASCADE, related_name="items")
    service = models.ForeignKey(Service, on_delete=models.PROTECT, related_name="+")
    qty = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return f"{self.service_id} x{self.qty}"
