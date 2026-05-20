from pathlib import Path

from cryptography.fernet import Fernet

from services.settings import get_settings


KEY_FILE = Path(".agent_secret.key")


def encrypt_text(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_text(value: str) -> str:
    return _fernet().decrypt(value.encode("utf-8")).decode("utf-8")


def _fernet() -> Fernet:
    key = get_settings().agent_secret_key
    if key:
        return Fernet(key.encode("utf-8"))

    if KEY_FILE.exists():
        return Fernet(KEY_FILE.read_bytes().strip())

    generated = Fernet.generate_key()
    KEY_FILE.write_bytes(generated)
    return Fernet(generated)
