from django.conf import settings
from django.db import models


class AuditEntry(models.Model):
    """Qui a fait quoi : connexions, et chaque action passée à l'agent."""

    at = models.DateTimeField('date', auto_now_add=True, db_index=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, verbose_name='compte', null=True, blank=True, on_delete=models.SET_NULL
    )
    # Conservé même si le compte est supprimé plus tard.
    username = models.CharField('identifiant', max_length=150, blank=True, db_index=True)
    action = models.CharField('action', max_length=64, db_index=True)
    target = models.CharField('cible', max_length=200, blank=True)
    outcome = models.CharField('résultat', max_length=300)
    details = models.JSONField('détails', default=dict, blank=True)
    ip = models.GenericIPAddressField('adresse IP', null=True, blank=True)

    class Meta:
        ordering = ['-at']
        verbose_name = 'entrée du journal'
        verbose_name_plural = "journal d'audit"
        indexes = [models.Index(fields=['action', 'username', 'at'])]

    def __str__(self):
        return f'{self.at:%Y-%m-%d %H:%M} {self.username or "?"} {self.action}'
