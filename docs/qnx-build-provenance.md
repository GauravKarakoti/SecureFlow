# QNX 8.0 Build Provenance

`secureflow scan` checks QNX build files for two things: whether a build can be reproduced (tool versions and target architecture are written down) and whether credentials are stored in it.

::: warning What has been verified
The rules are tested against small fixture projects. No QNX SDP was available, so neither the sample workflow nor any QNX command on this page has been run, on QEMU or on hardware.
:::

## Reference configuration

These are the values the sample workflow starts from. Record the ones your build really used.

| Item              | Reference value                                                                        | Confirm with                  |
| ----------------- | -------------------------------------------------------------------------------------- | ----------------------------- |
| SDP               | QNX SDP 8.0, baseline `com.qnx.qnx800`, including the update level (for example 8.0.x) | QNX Software Center           |
| Host              | x86_64 Ubuntu 22.04 or 24.04 LTS ([supported hosts][relnotes])                         | `uname -m`, `/etc/os-release` |
| Compiler          | `qcc` / `q++`, GCC version `12.2.0` (**not confirmed** against an install)             | `qcc -V`                      |
| Target (virtual)  | QEMU, x86_64, `gcc_ntox86_64`, image made with `mkqnximage --type=qemu --arch=x86_64`  | `mkqnximage --options`        |
| Target (hardware) | an AArch64 board with its QNX 8.0 BSP, `gcc_ntoaarch64le`                              | the BSP release notes         |

Nothing in a buildfile says whether an image will run in a virtual machine or on a board, because both can be `x86_64`. SecureFlow checks that the architecture is named. Write down the virtual or hardware target in your project documentation or build record.

A pinned build looks like this ([`qcc`][qcc], [QNX Software Center command line][qsc]):

```bash
qcc -V12.2.0,gcc_ntox86_64 main.c -o app
qnxsoftwarecenter_clt -destination "$HOME/qnx800" -installBaseline com.qnx.qnx800/<version> @credentials.options
```

QNX warns that `-myqnx.password` on the command line is [saved as cleartext in the QNX Software Center log][qsc], so pass it in an options file that is not committed.

## Which files are checked

| Kind            | File names                                                         | Also requires                                                                |
| --------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Image buildfile | `*.build`, `*.bld`                                                 | buildfile attributes, `.bootstrap` or `procnto`                              |
| Makefile        | `Makefile`, `GNUmakefile`, `*.mk`                                  | a QNX tool name or `qconfig.mk` / `qtargets.mk` / `qrules.mk`                |
| Script          | `*.sh`, `*.bash`, `*.zsh`, `*.bat`, `*.cmd`, `*.ps1`, `Dockerfile` | `qcc`, `q++`, `mkifs`, `mkqnximage`, `qnxsoftwarecenter_clt` or `qnxsdp-env` |
| CMake           | `CMakeLists.txt`, `*.cmake`                                        | a QNX tool name or `CMAKE_SYSTEM_NAME QNX`                                   |
| CI              | `.github/workflows/*.yml`, `.gitlab-ci.yml`                        | a QNX tool name                                                              |

Other files are not touched by these rules. They run for every scan mode: staged, `--since <ref>` and `--dir`.

## Rules

| Rule             | Severity | Reports                                                                                                                                                                    |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QNX-BUILD-001`  | LOW      | `-V` or `CMAKE_*_COMPILER_TARGET` names a target without a compiler version                                                                                                |
| `QNX-BUILD-002`  | MEDIUM   | a literal `qcc` / `q++` compile (or `CC = qcc`) in a file that never selects a target, or a CMake file for QNX with neither `CMAKE_SYSTEM_PROCESSOR` nor a compiler target |
| `QNX-BUILD-003`  | MEDIUM   | `-installBaseline` or `-installPackage` without `/version`                                                                                                                 |
| `QNX-BUILD-004`  | MEDIUM   | a bootable buildfile with no `[virtual=x86_64,...]` or `[virtual=aarch64le,...]`. [`mkifs` then falls back][bootstrap] to `PROCESSOR`, or to x86_64                        |
| `QNX-BUILD-005`  | LOW      | `mkqnximage --type=qemu` or `qvm` without [`--arch`][mkqnximage]                                                                                                           |
| `QNX-SECRET-001` | HIGH     | a literal `-myqnx.password`, `-addLicenseKey` or `sshpass -p` value                                                                                                        |
| `QNX-SECRET-002` | CRITICAL | a private key header                                                                                                                                                       |
| `QNX-SECRET-003` | HIGH     | a known token format, or a literal assigned to a password, secret, token or key name                                                                                       |
| `QNX-SECRET-004` | HIGH     | a hash in an inline `etc/shadow` file of a buildfile                                                                                                                       |

Matched credential values are replaced with `[REDACTED]` before a finding is created, so they do not appear in any report format or in the scan cache. Cloud AI scanning is a separate step that sends file contents; use `--local` for repositories that may hold secrets.

```bash
secureflow scan --dir . --local --format sarif -o qnx.sarif
```

To accept a finding:

```bash
# secureflow-ignore[rule=QNX-BUILD-001]: toolchain pinned by the container image
qcc -Vgcc_ntox86_64 main.c -o app
```

## Limits

- Only literal commands are read. `$(CC)`, `$QCC` or values built from variables are not resolved.
- One `-V` target anywhere in a file silences `QNX-BUILD-002` for that file.
- `mkqnximage` saved settings (`local/options`) are not parsed.
- The `etc/shadow` rule assumes colon separated entries. This has not been checked against a QNX image.
- Directory scans skip folders named `build`, `dist` and similar, as they always have.

## Sample workflow

[`.github/workflows/qnx-build-verify.yml`](https://github.com/GauravKarakoti/SecureFlow/blob/main/.github/workflows/qnx-build-verify.yml) scans the repository, builds a small program with a pinned compiler and target, and uploads the SARIF report with a provenance file. It only starts manually and needs a self-hosted runner:

1. Install a licensed QNX SDP 8.0 on an x86_64 Linux runner and add the label `qnx-sdp-8`.
2. Set the repository variable `QNX_SDP_PATH` to the install directory.
3. Run **QNX 8.0 Build Verification** from the Actions tab, using a compiler version that `qcc -V` lists.

It does not boot QEMU or touch hardware.

[relnotes]: https://www.qnx.com/developers/docs/relnotes8.0/com.qnx.doc.release_notes/topic/8.0.5_prod_release_notes/8.0.5_rn.html
[qcc]: https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/q/qcc.html
[qsc]: https://www.qnx.com/developers/docs/qsc/com.qnx.doc.qsc.user_guide/topic/commandline_qsc.html
[bootstrap]: https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.building/topic/buildfiles/nto_bootstrap.html
[mkqnximage]: https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkqnximage.html
