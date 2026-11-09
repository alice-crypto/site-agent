"""La passerelle face au vrai agent Node.js : la signature produite ici doit être acceptée là-bas."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from django.test import Client

from site_agent.audit.models import AuditEntry

REPO = Path(__file__).resolve().parents[4]
AGENT_SCRIPT = """
import { createUiServer } from './src/ui/server.js';
import { Registry } from './src/registry.js';
const server = await createUiServer(new Registry(process.argv[1]), { port: 0, log: () => {} });
const { origin } = await server.listen();
console.log(origin);
process.stdin.on('end', () => server.close().then(() => process.exit(0)));
process.stdin.resume();
"""


@pytest.fixture
def agent(tmp_path, settings):
    """Un agent Node.js réel, dans un dossier vide, branché sur ce Django."""
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js introuvable')
    (tmp_path / 'agent.defaults.json').write_text('{}', encoding='utf-8')
    process = subprocess.Popen(
        [node, '--input-type=module', '-e', AGENT_SCRIPT, str(tmp_path)],
        cwd=REPO,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    origin = process.stdout.readline().strip()
    assert origin.startswith('http://127.0.0.1:'), origin
    settings.SITE_AGENT_AGENT_URL = origin
    settings.SITE_AGENT_PROXY_SECRET_FILE = tmp_path / '.site-agent' / 'proxy-secret'
    yield origin
    process.stdin.close()
    process.wait(timeout=10)


def csrf_client(user):
    client = Client(enforce_csrf_checks=True)
    client.force_login(user)
    client.get('/api/session')
    return client, client.cookies['site_agent_csrf'].value


def test_anonymous_is_sent_to_login(client):
    response = client.get('/')
    assert response.status_code == 302
    assert response.url.startswith('/comptes/connexion/')
    assert client.get('/api/sites').status_code == 401


def test_interface_and_reading_go_through(agent, client, viewer):
    client.force_login(viewer)
    page = client.get('/')
    assert page.status_code == 200
    assert b'Site Agent' in page.content
    assert "frame-ancestors 'none'" in page['Content-Security-Policy']
    sites = client.get('/api/sites')
    assert sites.status_code == 200
    assert sites.json() == {'watching': False, 'sites': []}


def test_agent_enforces_the_role_given_by_django(agent, viewer, administrator):
    client, token = csrf_client(viewer)
    refused = client.post('/api/watch', json.dumps({'enabled': False}), content_type='application/json', HTTP_X_CSRFTOKEN=token)
    assert refused.status_code == 403

    client, token = csrf_client(administrator)
    allowed = client.post('/api/watch', json.dumps({'enabled': False}), content_type='application/json', HTTP_X_CSRFTOKEN=token)
    assert allowed.status_code == 200
    assert 'x-site-agent-audit' not in {name.lower() for name in allowed.headers}, 'les en-têtes internes ne sortent pas'


def test_actions_are_written_to_the_journal(agent, administrator):
    client, token = csrf_client(administrator)
    client.post('/api/watch', json.dumps({'enabled': False}), content_type='application/json', HTTP_X_CSRFTOKEN=token)
    client.post('/api/sites/absent/mode', json.dumps({'live': True}), content_type='application/json', HTTP_X_CSRFTOKEN=token)

    watch, failed = AuditEntry.objects.filter(username='alice').exclude(action='login').order_by('at')
    assert (watch.action, watch.outcome, watch.details) == ('watch', 'ok', {'enabled': False})
    assert failed.action == 'site.mode'
    assert failed.target == 'absent'
    assert failed.outcome.startswith('refusé : ')


def test_changes_require_the_csrf_token(agent, administrator):
    client, _ = csrf_client(administrator)
    response = client.post('/api/watch', json.dumps({'enabled': True}), content_type='application/json')
    assert response.status_code == 403
    assert not AuditEntry.objects.filter(action='watch').exists()


def test_account_without_group_never_reaches_the_agent(agent, client, make_user):
    client.force_login(make_user(username='nouveau'))
    assert client.get('/').status_code == 403
    assert client.get('/api/sites').status_code == 403


def test_agent_down_gives_a_clear_message(client, viewer, settings, tmp_path):
    secret = tmp_path / 'proxy-secret'
    secret.write_text('cle', encoding='utf-8')
    settings.SITE_AGENT_PROXY_SECRET_FILE = secret
    settings.SITE_AGENT_AGENT_URL = 'http://127.0.0.1:9'
    client.force_login(viewer)
    response = client.get('/api/sites')
    assert response.status_code == 502
    assert "L'agent ne répond pas" in response.json()['error']
    assert client.get('/').status_code == 502


def test_agent_not_started_yet(client, viewer, settings, tmp_path):
    settings.SITE_AGENT_PROXY_SECRET_FILE = tmp_path / 'absente'
    client.force_login(viewer)
    assert 'clé partagée' in client.get('/api/sites').json()['error']
