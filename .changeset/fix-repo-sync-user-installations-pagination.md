---
"secureflow": patch
---

Look through every page of the signed-in user's GitHub App installations when resolving the installation from their OAuth token. Only the first 10 were read, so a user in more than ten organisations could be told the app was not installed and get no repositories synced.
