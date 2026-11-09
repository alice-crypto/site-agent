from rest_framework import serializers

from site_agent.audit.models import AuditEntry


class AuditEntrySerializer(serializers.ModelSerializer[AuditEntry]):
    class Meta:
        model = AuditEntry
        fields = ['id', 'at', 'username', 'action', 'target', 'outcome', 'details', 'ip']
        read_only_fields = fields
