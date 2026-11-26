import requests

def fetch_data(url: str):
    # INSECURE: verify=False disables TLS certificate validation
    response = requests.get(url, verify=False)
    return response.json()
