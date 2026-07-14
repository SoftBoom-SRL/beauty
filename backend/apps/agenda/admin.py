from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from .models import Appointment, AppointmentService, Pause, WaitlistEntry


class AppointmentServiceInline(TabularInline):
    model = AppointmentService
    extra = 0


@admin.register(Appointment)
class AppointmentAdmin(ModelAdmin):
    list_display = (
        "id",
        "client",
        "operator",
        "start",
        "status",
        "deposit_status",
        "deposit_amount",
        "created_via",
        "salon",
    )
    list_filter = ("salon", "status", "deposit_status", "created_via")
    search_fields = ("client__first_name", "client__last_name", "client__phone")
    date_hierarchy = "start"
    inlines = [AppointmentServiceInline]


@admin.register(Pause)
class PauseAdmin(ModelAdmin):
    list_display = ("operator", "start", "duration_min", "note", "salon")
    list_filter = ("salon", "operator")
    date_hierarchy = "start"


@admin.register(WaitlistEntry)
class WaitlistEntryAdmin(ModelAdmin):
    list_display = (
        "client",
        "service",
        "operator",
        "preference",
        "status",
        "created_at",
        "salon",
    )
    list_filter = ("salon", "status", "preference")
