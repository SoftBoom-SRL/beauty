from django import forms
from django.contrib import admin
from unfold.admin import ModelAdmin

from .models import ActivityLog, DepositRule, Location, OutboxEvent, Salon, SalonSettings
from .services import normalize_opening_hours_week, opening_hours_text


@admin.register(Salon)
class SalonAdmin(ModelAdmin):
    list_display = ("name", "slug", "default_lang", "is_demo")
    prepopulated_fields = {"slug": ("name",)}
    # Lo scrive solo seed_demo: è il permesso di cancellare il salone con --reset.
    readonly_fields = ("is_demo",)


@admin.register(Location)
class LocationAdmin(ModelAdmin):
    list_display = ("name", "salon", "is_default")
    list_filter = ("salon",)


class SalonSettingsAdminForm(forms.ModelForm):
    """Gli orari scritti da /admin/ passano dalla stessa validazione dell'API.

    DEPLOY.md fa creare le Impostazioni da qui: un formato diverso da quello
    atteso (es. {"0": ["09:00-19:00"]}) finiva a database così com'era e
    mandava in errore (500) agenda e disponibilità del salone.
    """

    class Meta:
        model = SalonSettings
        fields = "__all__"
        help_texts = {
            "opening_hours_week": (
                'Es. {"0": [["09:00", "13:00"], ["14:00", "19:00"]], …, "6": []} — '
                "0 = lunedì … 6 = domenica, lista vuota = chiuso; {} = orari non impostati."
            ),
        }

    def clean_opening_hours_week(self):
        value = self.cleaned_data.get("opening_hours_week")
        if not value:
            # {} = orari mai impostati (contano solo i turni): non va trasformato
            # in «chiuso tutti i giorni».
            return {}
        if isinstance(value, dict):
            unknown = sorted(str(k) for k in value if str(k) not in {str(d) for d in range(7)})
            if unknown:
                # normalize le ignorerebbe: {"lun": …} diventava un salone chiuso.
                raise forms.ValidationError(
                    f"Giorni non validi: {', '.join(unknown)}. Usa le chiavi da \"0\" (lunedì) a \"6\" (domenica)."
                )
        try:
            return normalize_opening_hours_week(value)
        except ValueError as exc:
            raise forms.ValidationError(str(exc))

    def clean(self):
        cleaned = super().clean()
        # Come PUT /api/core/settings: il testo per l'app cliente segue gli orari
        # strutturati, salvo che sia stato cambiato anch'esso.
        if (
            "opening_hours_week" in self.changed_data
            and "opening_hours" not in self.changed_data
            and "opening_hours_week" in cleaned
        ):
            cleaned["opening_hours"] = opening_hours_text(cleaned["opening_hours_week"])
        return cleaned


@admin.register(SalonSettings)
class SalonSettingsAdmin(ModelAdmin):
    form = SalonSettingsAdminForm
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
    list_display = (
        "event_type", "salon", "status", "attempts", "created_at", "next_attempt_at", "sent_at",
    )
    list_filter = ("status", "event_type")
    search_fields = ("coalesce_key",)
