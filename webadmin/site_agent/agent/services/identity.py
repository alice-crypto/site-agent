"""Identité transmise à l'agent, signée avec la clé partagée.

L'agent n'écoute que sur la machine elle-même et refuse toute requête sans signature valide :
c'est Django qui décide qui est connecté et avec quel rôle. Le même calcul existe côté agent,
dans src/ui/identity.js.
"""

import hashlib
import hmac
import time
from dataclasses import dataclass
from urllib.parse import quote


@dataclass(frozen=True)
class Identity:
    username: str
    name: str
    role: str


def identity_headers(secret: str, identity: Identity, *, method: str, path: str, now: float | None = None) -> dict:
    timestamp = str(int((now if now is not None else time.time()) * 1000))
    user = quote(identity.username, safe='')
    display = quote(identity.name, safe='')
    message = '\n'.join([timestamp, method, path, user, display, identity.role]).encode('utf-8')
    return {
        'X-Site-Agent-Time': timestamp,
        'X-Site-Agent-User': user,
        'X-Site-Agent-Name': display,
        'X-Site-Agent-Role': identity.role,
        'X-Site-Agent-Signature': hmac.new(secret.encode('utf-8'), message, hashlib.sha256).hexdigest(),
    }
