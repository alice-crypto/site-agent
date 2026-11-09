def test_me_returns_own_account(client, operator):
    client.force_login(operator)
    data = client.get('/api/users/me').json()
    assert data['username'] == 'bob'
    assert data['role'] == 'operator'
    assert 'password' not in data


def test_list_is_restricted_to_who_manages_accounts(client, operator, administrator, viewer):
    client.force_login(operator)
    assert [user['username'] for user in client.get('/api/users').json()['results']] == ['bob']
    assert client.get('/api/users/alice').status_code == 404

    client.force_login(administrator)
    assert {user['username'] for user in client.get('/api/users').json()['results']} == {'alice', 'bob', 'lea'}


def test_api_requires_a_session(client):
    assert client.get('/api/users/me').status_code == 403


def test_accounts_are_read_only_through_the_api(client, administrator):
    client.force_login(administrator)
    assert client.post('/api/users', {}, content_type='application/json').status_code == 405
