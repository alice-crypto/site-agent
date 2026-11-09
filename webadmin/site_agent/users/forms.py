from django.conf import settings
from django.contrib.auth import forms as admin_forms
from django.core.exceptions import ValidationError

from site_agent.audit.services import recent_login_failures

from .models import User


class UserAdminChangeForm(admin_forms.UserChangeForm):
    class Meta(admin_forms.UserChangeForm.Meta):
        model = User


class UserAdminCreationForm(admin_forms.AdminUserCreationForm):
    class Meta(admin_forms.UserCreationForm.Meta):
        model = User
        error_messages = {'username': {'unique': 'Cet identifiant est déjà pris.'}}


class ThrottledAuthenticationForm(admin_forms.AuthenticationForm):
    """Bloque un identifiant après plusieurs échecs rapprochés, pour freiner les essais de mots de passe."""

    def clean(self):
        username = str(self.cleaned_data.get('username') or '').strip().lower()
        if username and recent_login_failures(username, settings.LOGIN_LOCK_MINUTES) >= settings.LOGIN_MAX_FAILURES:
            raise ValidationError(
                f'Trop de tentatives pour ce compte. Réessayez dans {settings.LOGIN_LOCK_MINUTES} minutes.',
                code='throttled',
            )
        return super().clean()
