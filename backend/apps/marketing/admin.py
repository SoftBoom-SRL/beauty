from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from .models import Communication, Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram


@admin.register(Coupon)
class CouponAdmin(ModelAdmin):
    list_display = ("code", "salon", "client", "kind", "value", "origin", "status", "expires_at")
    list_filter = ("salon", "origin", "status", "kind")
    search_fields = ("code",)


@admin.register(GiftCard)
class GiftCardAdmin(ModelAdmin):
    list_display = (
        "code",
        "salon",
        "initial_value",
        "balance",
        "payment_status",
        "status",
        "created_at",
    )
    list_filter = ("salon", "status", "payment_status")
    search_fields = ("code", "recipient_name")


class LoyaltyAccountInline(TabularInline):
    model = LoyaltyAccount
    extra = 0


@admin.register(LoyaltyProgram)
class LoyaltyProgramAdmin(ModelAdmin):
    list_display = ("name", "salon", "type", "earn_metric", "threshold", "enrollment", "active")
    list_filter = ("salon", "type", "active")
    inlines = [LoyaltyAccountInline]


@admin.register(LoyaltyAccount)
class LoyaltyAccountAdmin(ModelAdmin):
    list_display = ("client", "program", "points", "joined_at")
    list_filter = ("program",)


@admin.register(Communication)
class CommunicationAdmin(ModelAdmin):
    list_display = ("title", "salon", "audience_type", "status", "scheduled_at", "sent_at")
    list_filter = ("salon", "status", "audience_type")
    search_fields = ("title",)
