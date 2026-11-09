from django.contrib.auth.models import Group

from site_agent.users.roles import Role


def test_groups_exist_with_their_permissions():
    names = set(Group.objects.values_list('name', flat=True))
    assert {'Lecteurs', 'Opérateurs', 'Administrateurs'} <= names
    admins = Group.objects.get(name='Administrateurs')
    codenames = set(admins.permissions.values_list('codename', flat=True))
    assert {'view_agent', 'operate_agent', 'administer_agent', 'add_user', 'change_user', 'view_auditentry'} <= codenames
    assert 'delete_user' not in codenames, 'désactiver un compte plutôt que le supprimer garde le journal lisible'


def test_role_comes_from_the_highest_group(make_user):
    assert make_user().agent_role is None
    assert make_user('Lecteurs').agent_role == Role.VIEWER
    assert make_user('Opérateurs').agent_role == Role.OPERATOR
    assert make_user('Lecteurs', 'Administrateurs').agent_role == Role.ADMIN


def test_superuser_is_admin_and_inactive_has_no_role(make_user):
    assert make_user(is_superuser=True).agent_role == Role.ADMIN
    assert make_user('Administrateurs', is_active=False).agent_role is None


def test_display_name_falls_back_to_username(make_user):
    assert make_user(username='zoe', name='').display_name == 'zoe'
    assert make_user(username='yan', name='Yan Le Goff').display_name == 'Yan Le Goff'
