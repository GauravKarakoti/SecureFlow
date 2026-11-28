# QNX SDP 8.0 Toolchain

How `secureflow doctor` checks a QNX SDP 8.0 / QNX Everywhere host, and how to build and run a program for QNX 8.0.

::: warning What has been verified
The doctor checks are covered by unit tests that use fake SDP directory trees. They have **not** been run against a real QNX SDP install, and the build, QEMU and hardware steps on this page have **not** been run. The commands come from the QNX documentation linked at the bottom. Please open an issue if your install behaves differently.
:::

## Host requirements

The [QNX SDP 8.0.5 release notes][relnotes] list these 64-bit x86 hosts: Windows 11, Ubuntu Desktop 22.04 or 24.04 LTS, and Red Hat Enterprise Linux 9. macOS and ARM hosts are not supported.

For WSL2, install the Linux host tools inside the WSL2 distribution. QNX has a [WSL2 setup guide][wsl].

QNX offers a free non-commercial license through [QNX Everywhere][getqnx].

## Set up the environment

Run the script from your SDP install directory in every terminal where you use the tools ([build environments][buildenv]):

```bash
# Linux and WSL2
source ~/qnx800/qnxsdp-env.sh
```

```bat
:: Windows
qnxsdp-env.bat
```

## Check it with SecureFlow

```bash
secureflow doctor
secureflow doctor --qnx
secureflow doctor --qnx-target 192.168.122.10
```

The QNX checks appear only when at least one of these is true. Other projects see no change.

- `--qnx` or `--qnx-target` is passed
- `QNX_HOST` or `QNX_TARGET` is set
- a QNX build file is found up to three directories deep: a Makefile or `.mk` file that includes `qconfig.mk`, `qtargets.mk` or `qrules.mk` or calls `qcc -V` / `q++ -V`, a `.build` file with a `virtual=x86_64` or `virtual=aarch64le` attribute, or a CMake file with `set(CMAKE_SYSTEM_NAME QNX)`

### Toolchain check

| What is checked                                                         | Problem is reported as      |
| ----------------------------------------------------------------------- | --------------------------- |
| `QNX_HOST` and `QNX_TARGET` are set and are directories                 | error                       |
| `$QNX_HOST/usr/bin/qcc` exists and is executable (`qcc.exe` on Windows) | error                       |
| `$QNX_HOST/usr/bin/q++`                                                 | warning                     |
| `$QNX_HOST/usr/bin` is on `PATH`                                        | warning                     |
| SDP version is 8.x                                                      | warning, error with `--qnx` |
| SDP version cannot be determined                                        | warning                     |
| `QNX_CONFIGURATION_EXCLUSIVE`, or `~/.qnx`, is a directory              | warning                     |
| Host is x86_64 Linux or Windows                                         | warning, error with `--qnx` |

An **error** makes the check `FAIL` (exit code 1) in a QNX project or with `--qnx`. Otherwise it is shown as `WARN`, so an old environment variable does not break `doctor` in an unrelated repository. If neither `QNX_HOST` nor `QNX_TARGET` is set, the result is `WARN`, or `FAIL` with `--qnx`.

The version comes from a numeric `_NTO_VERSION` define in `$QNX_TARGET/usr/include/sys/` if there is one, otherwise from a `qnx800`-style directory name. Both are heuristics: `_NTO_VERSION` is [marked deprecated][manifests], and you can install the SDP into a directory with any name.

No QNX program is executed and no license file is opened, so a `PASS` does **not** mean your license is valid. `qcc` reports license problems [through its exit status][qcc].

### Target check

- With `--qnx-target <host[:port]>`, SecureFlow opens one TCP connection. The default port is 8000, the [default for `qconn`][qconn]. It only shows that something accepts connections there. IPv6 addresses go in brackets, for example `[fe80::1]:8000`.
- Without it, nothing is contacted. The check looks for `qemu-system-x86_64` or `qemu-system-aarch64` on `PATH`.

::: danger
`qconn` lets anyone who can reach it run programs on the target as superuser. QNX says [not to include it on systems deployed to customers][qconn].
:::

## Build for QNX 8.0

Use `qcc` for C and `q++` for C++, and select the target with `-V`. Running `qcc -V` by itself lists what your install supports ([qcc reference][qcc]).

```bash
# x86_64 (QEMU or x86_64 hardware)
qcc -Vgcc_ntox86_64 hello.c -o hello

# AArch64 hardware
qcc -Vgcc_ntoaarch64le hello.c -o hello
```

## Run in QEMU

[`mkqnximage`][mkqnximage] works on the image in the current directory, so start in an empty one. QEMU has to be installed on the host.

```bash
mkdir qnx-vm && cd qnx-vm
mkqnximage --type=qemu --arch=x86_64 --build
mkqnximage --run
```

From a second terminal in the same directory:

```bash
mkqnximage --getip
secureflow doctor --qnx-target <ip>:22   # or the port of the service you want to test
scp hello qnxuser@<ip>:/tmp/
ssh qnxuser@<ip> /tmp/hello
mkqnximage --stop
```

The generated image uses [deliberately simple passwords][mkqnximage] (each password equals the user name), so keep it on a private network.

## Run on hardware

1. Boot the board with a QNX 8.0 image from its board support package.
2. Build for the board's architecture as shown above.
3. Copy the binary over the network (for example with `scp`, if the image runs an SSH server) and run it on the target.
4. Optionally check reachability with `secureflow doctor --qnx-target <ip>:<port>`.

## References

- [Commonly used environment variables][envars]
- [Choosing the OS version for building programs][osversion]
- [Compiling for another platform][cross]

[relnotes]: https://www.qnx.com/developers/docs/relnotes8.0/com.qnx.doc.release_notes/topic/8.0.5_prod_release_notes/8.0.5_rn.html
[wsl]: https://qnx.software/en/blog/2026/using-qnx-sdp-with-wsl2-on-windows
[getqnx]: https://qnx.com/getqnx
[buildenv]: https://www.qnx.com/developers/docs/8.0/com.qnx.doc.hypervisor.user/topic/build/build_env.html
[manifests]: https://qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/manifests.html
[qcc]: https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/q/qcc.html
[qconn]: https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/q/qconn.html
[mkqnximage]: https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkqnximage.html
[envars]: https://qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/envars.html
[osversion]: https://qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.prog/topic/devel_OS_version.html
[cross]: https://qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.prog/topic/devel_SELFORCROSS.html
