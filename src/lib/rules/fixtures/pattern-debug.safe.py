import os

# SAFE: DEBUG disabled by default in production settings
DEBUG = False
SECRET_KEY = os.environ.get("SECRET_KEY", "fallback")
