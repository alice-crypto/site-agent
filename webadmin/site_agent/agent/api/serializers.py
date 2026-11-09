from django.urls import reverse
from rest_framework import serializers

from site_agent.users.api.serializers import SessionUserSerializer

SERVICE = 'site-agent'


class SessionSerializer(serializers.Serializer):
    """Ce que l'interface de l'agent doit savoir au démarrage : qui est connecté et où gérer son compte."""

    service = serializers.SerializerMethodField()
    demo = serializers.SerializerMethodField()
    user = serializers.SerializerMethodField()
    noAccess = serializers.SerializerMethodField()  # noqa: N815
    links = serializers.SerializerMethodField()

    def get_service(self, request):
        return SERVICE

    def get_demo(self, request):
        return False

    def get_user(self, request):
        user = request.user
        if not user.is_authenticated or user.agent_role is None:
            return None
        return SessionUserSerializer(user).data

    def get_noAccess(self, request):  # noqa: N802
        return request.user.is_authenticated and request.user.agent_role is None

    def get_links(self, request):
        links = {'login': reverse('login')}
        if request.user.is_authenticated:
            links.update(password=reverse('password_change'), logout=reverse('logout'))
            if request.user.is_staff:
                links['admin'] = reverse('admin:index')
        return links
