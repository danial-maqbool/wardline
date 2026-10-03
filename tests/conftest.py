import pytest

from wardline import sim
from wardline.hospital import make_patients


@pytest.fixture(scope="session")
def patients():
    return make_patients()


@pytest.fixture(scope="session")
def runs(patients):
    return {"baseline": sim.run("baseline", patients), "wardline": sim.run("wardline", patients)}
