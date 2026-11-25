import os

# INSECURE: DEBUG enabled in production settings
DEBUG = True
SECRET_KEY = os.environ.get("SECRET_KEY", "fallback")
