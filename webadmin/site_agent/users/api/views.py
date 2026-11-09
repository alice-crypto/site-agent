from rest_framework.decorators import action
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin
from rest_framework.response import Response
from rest_framework.viewsets import GenericViewSet

from site_agent.users.models import User

from .serializers import UserSerializer


class UserViewSet(RetrieveModelMixin, ListModelMixin, GenericViewSet):
    """Lecture des comptes. Les modifications se font dans l'administration Django."""

    serializer_class = UserSerializer
    queryset = User.objects.order_by('username')
    lookup_field = 'username'

    def get_queryset(self, *args, **kwargs):
        # Chacun voit son propre compte ; la liste complète est réservée à qui peut gérer les comptes.
        if self.request.user.has_perm('users.view_user'):
            return self.queryset
        return self.queryset.filter(pk=self.request.user.pk)

    @action(detail=False)
    def me(self, request):
        return Response(UserSerializer(request.user, context={'request': request}).data)
