from rest_framework.permissions import DjangoModelPermissions
from rest_framework.viewsets import ReadOnlyModelViewSet

from site_agent.audit.models import AuditEntry

from .serializers import AuditEntrySerializer


class ViewAuditPermission(DjangoModelPermissions):
    # La lecture aussi exige la permission « view » : le journal n'est pas public au sein de l'équipe.
    perms_map = {**DjangoModelPermissions.perms_map, 'GET': ['%(app_label)s.view_%(model_name)s']}


class AuditEntryViewSet(ReadOnlyModelViewSet):
    serializer_class = AuditEntrySerializer
    queryset = AuditEntry.objects.all()
    permission_classes = [ViewAuditPermission]

    def get_queryset(self):
        queryset = super().get_queryset()
        for field in ('action', 'username', 'target'):
            value = self.request.query_params.get(field)
            if value:
                queryset = queryset.filter(**{field: value})
        return queryset
