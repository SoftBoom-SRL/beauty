from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group
from unfold.admin import ModelAdmin
from unfold.forms import AdminPasswordChangeForm, UserChangeForm, UserCreationForm

from .models import ClientOTP, Invitation, Membership, Role, User

# Group nativo: re-registra con lo stile unfold
admin.site.unregister(Group)


@admin.register(Group)
class GroupAdmin(ModelAdmin):
    list_display = ("name",)
    search_fields = ("name",)
    filter_horizontal = ("permissions",)


@admin.register(User)
class UserAdmin(DjangoUserAdmin, ModelAdmin):
    # form di unfold: widget stilizzati per password/cambio password
    form = UserChangeForm
    add_form = UserCreationForm
    change_password_form = AdminPasswordChangeForm

    ordering = ("email",)
    list_display = ("email", "first_name", "last_name", "is_active", "is_staff")
    search_fields = ("email", "first_name", "last_name")
    list_filter = ("is_active", "is_staff", "is_superuser")
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Anagrafica", {"fields": ("first_name", "last_name")}),
        (
            "Permessi",
            {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")},
        ),
        ("Date", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (None, {"classes": ("wide",), "fields": ("email", "password1", "password2")}),
    )


@admin.register(Role)
class RoleAdmin(ModelAdmin):
    list_display = ("name", "salon", "is_system", "scopes")
    list_filter = ("salon", "is_system")
    search_fields = ("name",)


@admin.register(Membership)
class MembershipAdmin(ModelAdmin):
    list_display = ("user", "salon", "role", "is_owner")
    list_filter = ("salon", "is_owner")
    search_fields = ("user__email",)


@admin.register(Invitation)
class InvitationAdmin(ModelAdmin):
    list_display = ("email", "salon", "role", "status", "expires_at", "created_at")
    list_filter = ("salon", "status")
    search_fields = ("email",)
    readonly_fields = ("token", "created_at")


@admin.register(ClientOTP)
class ClientOTPAdmin(ModelAdmin):
    list_display = ("client", "used", "expires_at", "created_at")
    list_filter = ("used",)
    readonly_fields = ("client", "code", "expires_at", "created_at")
