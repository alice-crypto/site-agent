from django.contrib.auth.models import Group
from factory import Faker, post_generation
from factory.django import DjangoModelFactory

from site_agent.users.models import User

PASSWORD = 'un mot de passe solide'


class UserFactory(DjangoModelFactory[User]):
    username = Faker('user_name')
    email = Faker('email')
    name = Faker('name')

    class Meta:
        model = User
        django_get_or_create = ['username']
        skip_postgeneration_save = True

    @post_generation
    def password(self, create, extracted, **kwargs):
        self.set_password(extracted or PASSWORD)
        if create:
            self.save()

    @post_generation
    def groups(self, create, extracted, **kwargs):
        # UserFactory(groups=['Opérateurs']) : les groupes sont créés par la migration.
        if create and extracted:
            self.groups.add(*Group.objects.filter(name__in=extracted))
