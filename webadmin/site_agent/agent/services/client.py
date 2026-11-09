"""Accès HTTP à l'agent Node.js, qui tourne sur la même machine."""

import http.client
import json
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .identity import Identity, identity_headers

AUDIT_HEADER = 'x-site-agent-audit'
# En-têtes de l'agent repris tels quels vers le navigateur ; ceux d'audit sont lus ici et jamais renvoyés.
PASSED_HEADERS = ('content-type', 'content-security-policy', 'cache-control', 'x-content-type-options', 'referrer-policy')


class AgentUnavailable(Exception):
    """L'agent ne répond pas, ou n'a pas encore créé sa clé."""


@dataclass(frozen=True)
class AuditDescription:
    action: str
    outcome: str
    target: str
    details: dict


@dataclass
class AgentResponse:
    status: int
    content: bytes
    headers: dict = field(default_factory=dict)
    audit: AuditDescription | None = None


def _read_audit(response) -> AuditDescription | None:
    action = response.getheader(AUDIT_HEADER)
    if not action:
        return None
    try:
        details = json.loads(unquote(response.getheader(f'{AUDIT_HEADER}-details') or '{}'))
    except ValueError:
        details = {}
    return AuditDescription(
        action=unquote(action),
        outcome=unquote(response.getheader(f'{AUDIT_HEADER}-outcome') or str(response.status)),
        target=unquote(response.getheader(f'{AUDIT_HEADER}-target') or ''),
        details=details if isinstance(details, dict) else {},
    )


class AgentClient:
    def __init__(self, base_url: str, secret_file: Path, timeout: int):
        self.target = urlsplit(base_url)
        self.secret_file = Path(secret_file)
        self.timeout = timeout

    def secret(self) -> str:
        # Relue à chaque fois : un redémarrage de l'agent avec une nouvelle clé est pris en compte aussitôt.
        try:
            value = self.secret_file.read_text(encoding='utf-8').strip()
        except FileNotFoundError:
            value = ''
        if not value:
            raise AgentUnavailable("L'agent n'a pas encore démarré : sa clé partagée est introuvable.")
        return value

    def forward(self, identity: Identity, *, method: str, path: str, body: bytes | None, content_type: str | None, accept: str) -> AgentResponse:
        headers = identity_headers(self.secret(), identity, method=method, path=path)
        headers['Host'] = self.target.netloc
        headers['Accept'] = accept
        if body is not None:
            headers['Content-Length'] = str(len(body))
            if content_type:
                headers['Content-Type'] = content_type

        connection = http.client.HTTPConnection(self.target.hostname, self.target.port or 80, timeout=self.timeout)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            content = response.read()
        except OSError as error:
            raise AgentUnavailable("L'agent ne répond pas. Vérifiez qu'il tourne sur le serveur.") from error
        finally:
            connection.close()

        return AgentResponse(
            status=response.status,
            content=content,
            headers={name: response.getheader(name) for name in PASSED_HEADERS if response.getheader(name)},
            audit=_read_audit(response),
        )
