"""Démarre l'administration en service : migrations, fichiers statiques, puis Waitress.

Lancée par l'agent lui-même (node src/cli.js serve ou ui), qui lui passe l'adresse d'écoute.
"""

from django.core.management import call_command
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Sert l'administration de Site Agent avec Waitress."

    def add_arguments(self, parser):
        parser.add_argument('--host', default='127.0.0.1')
        parser.add_argument('--port', type=int, default=8000)

    def handle(self, *args, host, port, **options):
        # La base est mise à jour à chaque démarrage : une nouvelle version s'installe d'un simple git pull.
        call_command('migrate', interactive=False, verbosity=0)
        call_command('collectstatic', interactive=False, verbosity=0)

        from waitress import serve

        from config.wsgi import application

        self.stdout.write(f'Administration Django prête sur http://{host}:{port}')
        self.stdout.flush()
        # Waitress n'écoute que sur la machine : seul Caddy, sur place, transmet X-Forwarded-Proto.
        serve(application, host=host, port=port, threads=8, ident='site-agent', clear_untrusted_proxy_headers=False)
