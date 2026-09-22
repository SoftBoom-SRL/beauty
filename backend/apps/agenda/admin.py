from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from .models import Appointment, AppointmentService, Pause, WaitlistEntry


class AppointmentServiceInline(TabularInline):
    model = AppointmentService
    extra = 0
    # Senza questo l'inline apriva una select con tutti i servizi e tutte le
    # operatrici di tutti i saloni, per ogni riga.
    raw_id_fields = ("service", "operator")


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
    # L'elenco mostra cliente, operatrice e salone: senza il select_related ogni
    # riga faceva tre query in più, e il form caricava in una tendina tutte le
    # clienti di tutti i saloni.
    list_select_related = ("client", "operator", "salon")
    raw_id_fields = ("salon", "location", "client", "operator")


@admin.register(Pause)
class PauseAdmin(ModelAdmin):
    list_display = ("operator", "start", "duration_min", "note", "salon")
    list_filter = ("salon", "operator")
    date_hierarchy = "start"
    list_select_related = ("operator", "salon")
    raw_id_fields = ("salon", "operator")


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
    list_select_related = ("client", "service", "operator", "salon")
    raw_id_fields = ("salon", "client", "service", "operator")
