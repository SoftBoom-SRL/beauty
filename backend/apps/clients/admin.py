from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from .models import Client, ClientCategory, ClientNote, TechnicalSheet


@admin.register(ClientCategory)
class ClientCategoryAdmin(ModelAdmin):
    list_display = ("name", "salon", "color", "order")
    list_filter = ("salon",)
    search_fields = ("name",)


class ClientNoteInline(TabularInline):
    model = ClientNote
    extra = 0
    readonly_fields = ("created_at",)


class TechnicalSheetInline(TabularInline):
    model = TechnicalSheet
    extra = 0
    fields = ("category", "treatment", "created_at")
    readonly_fields = ("category", "treatment", "created_at")
    can_delete = False
    show_change_link = True

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(Client)
class ClientAdmin(ModelAdmin):
    list_display = (
        "full_name",
        "phone",
        "email",
        "salon",
        "reliability",
        "is_active",
    )
    list_filter = ("salon", "is_active", "categories", "lang")
    search_fields = ("first_name", "last_name", "phone", "email")
    filter_horizontal = ("categories",)
    inlines = [ClientNoteInline, TechnicalSheetInline]


@admin.register(ClientNote)
class ClientNoteAdmin(ModelAdmin):
    list_display = ("client", "visibility", "author", "created_at")
    list_filter = ("visibility",)


@admin.register(TechnicalSheet)
class TechnicalSheetAdmin(ModelAdmin):
    """Storico immutabile: i campi restano modificabili solo alla creazione in admin.

    (l'API non espone alcun endpoint di update/delete, vedi apps/clients/api.py)
    """

    list_display = ("client", "category", "treatment", "author", "created_at")
    list_filter = ("category",)
    search_fields = ("treatment", "zone")
    readonly_fields = ("created_at",)
