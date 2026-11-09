from django.contrib.auth.models import AbstractUser
from django.db.models import CharField

from .roles import AGENT_PERMISSIONS, ROLE_PERMISSIONS, Role


class User(AbstractUser):
    """Compte d'une personne de l'équipe.

    Comme dans cookiecutter-django, un seul champ « nom » remplace prénom et nom.
    """

    name = CharField('nom', blank=True, max_length=255)
    first_name = None  # type: ignore[assignment]
    last_name = None  # type: ignore[assignment]

    class Meta(AbstractUser.Meta):
        verbose_name = 'compte'
        verbose_name_plural = 'comptes'
        permissions = AGENT_PERMISSIONS

    @property
    def display_name(self) -> str:
        return self.name or self.get_username()

    @property
    def agent_role(self) -> Role | None:
        """Rôle le plus élevé de la personne, ou None si elle n'a aucun accès à l'agent."""
        if not self.is_active:
            return None
        for role, permission in ROLE_PERMISSIONS:
            if self.has_perm(permission):
                return role
        return None
