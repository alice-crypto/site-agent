import pytest

from site_agent.users.tests.factories import UserFactory


@pytest.fixture(autouse=True)
def _media_and_db(db):
    """Chaque test a sa base PostgreSQL de test, vidée après lui."""


@pytest.fixture
def make_user():
    def make(*groups, **fields):
        return UserFactory(groups=list(groups), **fields)

    return make


@pytest.fixture
def viewer(make_user):
    return make_user('Lecteurs', username='lea')


@pytest.fixture
def operator(make_user):
    return make_user('Opérateurs', username='bob')


@pytest.fixture
def administrator(make_user):
    return make_user('Administrateurs', username='alice', is_staff=True)
