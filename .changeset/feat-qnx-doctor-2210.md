---
"secureflow-cli": minor
---

`secureflow doctor` now checks the QNX SDP 8.0 host toolchain (`QNX_HOST`, `QNX_TARGET`, `qcc`, `q++`, SDP version, QEMU or target connection) for QNX projects, with new `--qnx` and `--qnx-target` flags. Status labels are colored when the terminal supports it (#2210).
