"""Cas d'usage des comptes, indépendants des vues."""

from django.contrib.auth.models import Group, Permission

from .roles import ADMIN_GROUP, ADMIN_GROUP_DJANGO_PERMISSIONS, ROLE_GROUPS


def ensure_role_groups(using='default'):
    """Crée ou complète les trois groupes. Ne retire jamais une permission ajoutée à la main."""
    for name, codenames in ROLE_GROUPS.items():
        group, _ = Group.objects.using(using).get_or_create(name=name)
        permissions = list(
            Permission.objects.using(using).filter(content_type__app_label='users', codename__in=codenames)
        )
        if name == ADMIN_GROUP:
            for app_label, model, actions in ADMIN_GROUP_DJANGO_PERMISSIONS:
                permissions += Permission.objects.using(using).filter(
                    content_type__app_label=app_label, codename__in=[f'{action}_{model}' for action in actions]
                )
        group.permissions.add(*permissions)
