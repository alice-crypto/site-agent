from rest_framework import serializers

from site_agent.users.models import User


class UserSerializer(serializers.ModelSerializer[User]):
    role = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ['username', 'name', 'email', 'role', 'is_active', 'is_staff', 'last_login']
        read_only_fields = fields

    def get_role(self, user: User) -> str | None:
        return user.agent_role


class SessionUserSerializer(serializers.ModelSerializer[User]):
    """La personne connectée, telle que l'interface de l'agent l'affiche."""

    id = serializers.CharField(source='username')
    name = serializers.CharField(source='display_name')
    role = serializers.CharField(source='agent_role')

    class Meta:
        model = User
        fields = ['id', 'name', 'email', 'role']
        read_only_fields = fields
