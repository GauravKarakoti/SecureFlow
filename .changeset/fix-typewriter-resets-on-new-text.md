---
"secureflow": patch
---

`useTypewriter` restarts when its text is replaced instead of extended. It kept its character index across texts, so a shorter replacement never started typing (the previous text stayed on screen), and a longer one jumped straight to the old position.
