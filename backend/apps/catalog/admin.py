from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from .models import Package, PackageItem, Service, ServiceCategory


@admin.register(ServiceCategory)
class ServiceCategoryAdmin(ModelAdmin):
    list_display = ("name_it", "salon", "color", "order")
    list_filter = ("salon",)
    search_fields = ("name_it", "name_en")
    ordering = ("salon", "order")


@admin.register(Service)
class ServiceAdmin(ModelAdmin):
    list_display = ("name_it", "salon", "category", "duration_min", "price", "active", "order")
    list_filter = ("salon", "category", "active")
    search_fields = ("name_it", "name_en")
    ordering = ("salon", "category__order", "order")


class PackageItemInline(TabularInline):
    model = PackageItem
    extra = 1


@admin.register(Package)
class PackageAdmin(ModelAdmin):
    list_display = ("name", "salon", "price", "active")
    list_filter = ("salon", "active")
    search_fields = ("name",)
    inlines = [PackageItemInline]
