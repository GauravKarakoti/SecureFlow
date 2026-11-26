import requests

def fetch_data(url: str):
    # SAFE: verify=True (or omitted default) validates TLS certificates
    response = requests.get(url, verify=True)
    return response.json()
