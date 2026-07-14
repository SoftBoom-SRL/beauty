from django.contrib import admin
from unfold.admin import ModelAdmin

from .models import ActivityLog, DepositRule, Location, OutboxEvent, Salon, SalonSettings


@admin.register(Salon)
class SalonAdmin(ModelAdmin):
    list_display = ("name", "slug", "default_lang")
    prepopulated_fields = {"slug": ("name",)}


@admin.register(Location)
class LocationAdmin(ModelAdmin):
    list_display = ("name", "salon", "is_default")
    list_filter = ("salon",)


@admin.register(SalonSettings)
class SalonSettingsAdmin(ModelAdmin):
    list_display = ("salon", "brand_color", "agenda_fill", "slot_recovery")


@admin.register(DepositRule)
class DepositRuleAdmin(ModelAdmin):
    list_display = ("name", "salon", "amount_type", "amount", "priority", "active")
    list_filter = ("salon", "active")


@admin.register(ActivityLog)
class ActivityLogAdmin(ModelAdmin):
    list_display = ("type", "summary", "actor_name", "salon", "created_at")
    list_filter = ("salon", "type")
    search_fields = ("summary",)
    readonly_fields = [f.name for f in ActivityLog._meta.fields]


@admin.register(OutboxEvent)
class OutboxEventAdmin(ModelAdmin):
    list_display = ("event_type", "salon", "status", "attempts", "created_at", "sent_at")
    list_filter = ("status", "event_type")
