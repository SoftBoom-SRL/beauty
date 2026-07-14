from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from .models import (
    Product,
    ProductCategory,
    PurchaseOrder,
    PurchaseOrderLine,
    StockMovement,
    Supplier,
)


@admin.register(Supplier)
class SupplierAdmin(ModelAdmin):
    list_display = ("name", "salon", "email", "phone", "order_method")
    list_filter = ("salon", "order_method")
    search_fields = ("name", "email")


@admin.register(ProductCategory)
class ProductCategoryAdmin(ModelAdmin):
    list_display = ("name", "salon", "order")
    list_filter = ("salon",)


@admin.register(Product)
class ProductAdmin(ModelAdmin):
    list_display = (
        "name",
        "sku",
        "brand",
        "salon",
        "supplier",
        "usage",
        "stock_qty",
        "min_threshold",
        "stock_state",
        "active",
    )
    list_filter = ("salon", "usage", "active", "category", "supplier")
    search_fields = ("name", "sku", "brand")
    readonly_fields = ("stock_qty",)  # si muove SOLO via apply_movement


@admin.register(StockMovement)
class StockMovementAdmin(ModelAdmin):
    list_display = ("product", "kind", "qty", "reason", "salon", "author", "created_at")
    list_filter = ("salon", "kind")
    search_fields = ("product__name", "reason")
    readonly_fields = [f.name for f in StockMovement._meta.fields]

    def has_add_permission(self, request):
        return False  # i movimenti nascono solo da services.apply_movement

    def has_change_permission(self, request, obj=None):
        return False


class PurchaseOrderLineInline(TabularInline):
    model = PurchaseOrderLine
    extra = 0


@admin.register(PurchaseOrder)
class PurchaseOrderAdmin(ModelAdmin):
    list_display = ("id", "supplier", "salon", "status", "sent_method", "sent_at", "created_at")
    list_filter = ("salon", "status")
    inlines = [PurchaseOrderLineInline]
