from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from .models import Absence, Operator, WeeklyShift


class WeeklyShiftInline(TabularInline):
    model = WeeklyShift
    extra = 0


class AbsenceInline(TabularInline):
    model = Absence
    extra = 0


@admin.register(Operator)
class OperatorAdmin(ModelAdmin):
    list_display = (
        "first_name",
        "last_name",
        "salon",
        "role_title",
        "cycle_weeks",
        "active",
        "order",
    )
    list_filter = ("salon", "active")
    search_fields = ("first_name", "last_name")
    filter_horizontal = ("services",)
    inlines = [WeeklyShiftInline, AbsenceInline]


@admin.register(WeeklyShift)
class WeeklyShiftAdmin(ModelAdmin):
    list_display = ("operator", "week_index", "weekday", "start_min", "end_min")
    list_filter = ("operator__salon", "weekday")


@admin.register(Absence)
class AbsenceAdmin(ModelAdmin):
    list_display = ("operator", "type", "date_from", "date_to")
    list_filter = ("type", "operator__salon")
