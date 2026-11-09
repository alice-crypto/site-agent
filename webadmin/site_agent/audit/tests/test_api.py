from site_agent.audit.services import record_event


def test_journal_reserved_to_who_may_read_it(client, operator, administrator):
    record_event(None, 'site.add', 'ok', user=operator, target='alpha', details={'name': 'alpha'})

    client.force_login(operator)
    assert client.get('/api/audit').status_code == 403

    client.force_login(administrator)
    [entry] = client.get('/api/audit?action=site.add').json()['results']
    assert entry['username'] == 'bob'
    assert entry['target'] == 'alpha'
    # Le journal ne s'efface pas, même pour un administrateur.
    assert client.delete(f"/api/audit/{entry['id']}").status_code in (403, 405)
    assert client.get(f"/api/audit/{entry['id']}").status_code == 200


def test_forwarded_address_trusted_only_from_local_proxy(rf):
    from site_agent.audit.services import client_ip

    behind_caddy = rf.get('/', HTTP_X_FORWARDED_FOR='203.0.113.9, 10.10.0.5', REMOTE_ADDR='127.0.0.1')
    assert client_ip(behind_caddy) == '10.10.0.5'
    direct = rf.get('/', HTTP_X_FORWARDED_FOR='1.2.3.4', REMOTE_ADDR='10.10.0.7')
    assert client_ip(direct) == '10.10.0.7'
