from django.contrib import admin
from unfold.admin import ModelAdmin

from .models import Automation


@admin.register(Automation)
class AutomationAdmin(ModelAdmin):
    list_display = ("name", "salon", "event", "trigger_origin", "active", "updated_at")
    list_filter = ("salon", "event", "trigger_origin", "active")
    search_fields = ("name",)
    readonly_fields = ("webhook_token", "message_preview", "created_at", "updated_at")
