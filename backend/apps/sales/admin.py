from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from .models import Payment, Sale, SaleLine


class SaleLineInline(TabularInline):
    model = SaleLine
    extra = 0
    raw_id_fields = ("operator", "service", "product", "gift_card")


class PaymentInline(TabularInline):
    model = Payment
    extra = 0
    raw_id_fields = ("gift_card",)


@admin.register(Sale)
class SaleAdmin(ModelAdmin):
    list_display = ("id", "salon", "kind", "client", "total", "deposit_deducted", "created_at")
    list_filter = ("salon", "kind")
    date_hierarchy = "created_at"
    raw_id_fields = ("salon", "location", "appointment", "client", "created_by")
    inlines = [SaleLineInline, PaymentInline]


@admin.register(SaleLine)
class SaleLineAdmin(ModelAdmin):
    list_display = ("sale", "line_type", "operator", "qty", "unit_price", "discount_pct", "is_gift", "amount")
    list_filter = ("line_type", "is_gift")
    raw_id_fields = ("sale", "operator", "service", "product", "gift_card")


@admin.register(Payment)
class PaymentAdmin(ModelAdmin):
    list_display = ("sale", "method", "amount", "gift_card")
    list_filter = ("method",)
    raw_id_fields = ("sale", "gift_card")
