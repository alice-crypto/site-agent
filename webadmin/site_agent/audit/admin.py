from django.contrib import admin

from .models import AuditEntry


@admin.register(AuditEntry)
class AuditEntryAdmin(admin.ModelAdmin):
    list_display = ('at', 'username', 'action', 'target', 'outcome', 'ip')
    list_filter = ('action', 'at')
    search_fields = ('username', 'action', 'target', 'outcome')
    date_hierarchy = 'at'
    readonly_fields = [field.name for field in AuditEntry._meta.fields]

    # Le journal ne se modifie pas : on le consulte.
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
