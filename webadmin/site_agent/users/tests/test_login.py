from django.urls import reverse

from site_agent.audit.models import AuditEntry
from site_agent.users.tests.factories import PASSWORD


def login(client, username, password):
    return client.post(reverse('login'), {'username': username, 'password': password})


def test_login_and_logout_are_recorded(client, operator):
    response = login(client, 'bob', PASSWORD)
    assert response.status_code == 302
    assert response.url == '/'
    client.post(reverse('logout'))
    assert list(AuditEntry.objects.filter(username='bob').values_list('action', flat=True)) == ['logout', 'login']


def test_failures_are_recorded_without_password(client, operator):
    assert login(client, 'bob', 'pas le bon mot de passe').status_code == 200
    entry = AuditEntry.objects.get(action='login.failed')
    assert entry.username == 'bob'
    assert 'pas le bon' not in str(entry.details) + entry.outcome


def test_account_locked_after_five_failures_even_with_right_password(client, operator):
    for _ in range(5):
        login(client, 'bob', 'mauvais mot de passe')
    response = login(client, 'bob', PASSWORD)
    assert response.status_code == 200
    assert 'Trop de tentatives' in response.content.decode()
    assert '_auth_user_id' not in client.session


def test_password_change_keeps_this_session(client, operator):
    client.force_login(operator)
    response = client.post(
        reverse('password_change'),
        {'old_password': PASSWORD, 'new_password1': 'une autre phrase solide', 'new_password2': 'une autre phrase solide'},
    )
    assert response.status_code == 302
    operator.refresh_from_db()
    assert operator.check_password('une autre phrase solide')
    assert client.get(reverse('api:session')).json()['user']['id'] == 'bob'


def test_short_password_refused(client, operator):
    client.force_login(operator)
    response = client.post(reverse('password_change'), {'old_password': PASSWORD, 'new_password1': 'court1', 'new_password2': 'court1'})
    assert response.status_code == 200
    operator.refresh_from_db()
    assert operator.check_password(PASSWORD)
