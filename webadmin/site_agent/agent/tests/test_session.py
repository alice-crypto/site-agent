def test_anonymous_session_points_to_login(client):
    data = client.get('/api/session').json()
    assert data == {'service': 'site-agent', 'demo': False, 'user': None, 'noAccess': False, 'links': {'login': '/comptes/connexion/'}}
    assert 'site_agent_csrf' in client.cookies, 'le jeton CSRF est posé pour les requêtes suivantes'


def test_session_describes_the_person(client, operator):
    client.force_login(operator)
    data = client.get('/api/session').json()
    assert data['user'] == {'id': 'bob', 'name': operator.name, 'email': operator.email, 'role': 'operator'}
    assert 'admin' not in data['links']
    assert data['links']['password'] == '/comptes/mot-de-passe/'


def test_staff_gets_the_administration_link(client, administrator):
    client.force_login(administrator)
    assert client.get('/api/session').json()['links']['admin'] == '/admin/'


def test_account_without_group_has_no_access(client, make_user):
    client.force_login(make_user(username='nouveau'))
    data = client.get('/api/session').json()
    assert data['user'] is None
    assert data['noAccess'] is True
