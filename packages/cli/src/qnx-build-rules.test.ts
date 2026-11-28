import { describe, it, expect } from "vitest";
import { classifyQnxBuildFile, scanQnxBuildFile } from "./qnx-build-rules.js";
import { maskSecrets, REDACTION_PLACEHOLDER } from "./secret-masker.js";
import { scanFile, formatScanResults } from "./scanner.js";

const source = (...lines: string[]) => lines.join("\n");
const hits = (path: string, ...lines: string[]) =>
  scanQnxBuildFile(path, source(...lines)).map((v) => [v.ruleId, v.line]);

// Built from parts so this file holds nothing that looks like a live credential
const FAKE_PASSWORD = ["not", "a", "real", "pw", "93"].join("-");

describe("classifyQnxBuildFile (#2212)", () => {
  it.each([
    ["images/ifs.build", "[virtual=x86_64,multiboot] .bootstrap = {", "buildfile"],
    ["system.build", "[uid=0 gid=0 perms=0755] /usr/bin/app", "buildfile"],
    ["common.mk", "include $(MKFILES_ROOT)/qtargets.mk", "makefile"],
    ["Makefile", "app:\n\tqcc -Vgcc_ntox86_64 app.c -o app", "makefile"],
    ["scripts/deploy.sh", "source ~/qnx800/qnxsdp-env.sh", "script"],
    ["build.bat", "call qnxsdp-env.bat", "script"],
    ["Dockerfile", "RUN mkifs ifs.build ifs.bin", "script"],
    ["cmake/qnx.cmake", "set(CMAKE_SYSTEM_NAME QNX)", "cmake"],
    [".github/workflows/qnx.yml", "run: qcc -V", "ci"],
  ])("recognises %s", (path, content, kind) => {
    expect(classifyQnxBuildFile(path, content)).toBe(kind);
  });

  it.each([
    ["BUILD.build", "load('//tools:defs.bzl', 'rule')"],
    ["Makefile", "app:\n\tgcc app.c -o app"],
    ["scripts/deploy.sh", "echo deploying"],
    [".github/workflows/ci.yml", "run: npm test"],
    ["notes.md", "run qcc -V"],
    ["src/qcc.ts", "const qcc = 1;"],
  ])("ignores %s without QNX content", (path, content) => {
    expect(classifyQnxBuildFile(path, content)).toBeNull();
  });
});

describe("target architecture and version pinning", () => {
  it("flags a target selected without a compiler version", () => {
    expect(hits("build.sh", "qcc -Vgcc_ntox86_64 main.c -o main")).toEqual([["QNX-BUILD-001", 1]]);
    expect(hits("build.sh", "q++ -V gcc_ntoaarch64le -c main.cpp")).toEqual([["QNX-BUILD-001", 1]]);
  });

  it.each([
    "qcc -V12.2.0,gcc_ntox86_64 main.c -o main",
    "qcc -Vgcc/12.2.0,gcc_ntoaarch64le main.c -o main",
    'qcc -V"$QCC_VERSION,$QCC_TARGET" main.c -o main',
    "qcc -V$(TARGET) main.c -o main",
    "qcc -V",
    "echo Installing qcc",
    "# qcc main.c -o main",
  ])("accepts %s", (command) => {
    expect(hits("build.sh", "source qnxsdp-env.sh", command)).toEqual([]);
  });

  it("flags a compile without any target", () => {
    expect(hits("build.sh", "qcc -o main main.c")).toEqual([["QNX-BUILD-002", 1]]);
    expect(hits("Makefile", "CC = qcc", "app: app.o", "\t$(CC) -o app app.o")).toEqual([
      ["QNX-BUILD-002", 1],
    ]);
  });

  it("accepts CC = qcc when the target comes from CFLAGS", () => {
    expect(hits("Makefile", "CC = qcc", "CFLAGS += -V12.2.0,gcc_ntox86_64")).toEqual([]);
  });

  it("follows line continuations and reports the right line", () => {
    expect(hits("build.sh", "qcc -Wall \\", "  -Vgcc_ntox86_64 \\", "  main.c -o main")).toEqual([
      ["QNX-BUILD-001", 2],
    ]);
  });

  it("checks CMake toolchain files", () => {
    expect(hits("qnx.cmake", "set(CMAKE_SYSTEM_NAME QNX)")).toEqual([["QNX-BUILD-002", 1]]);
    expect(
      hits(
        "qnx.cmake",
        "set(CMAKE_SYSTEM_NAME QNX)",
        "set(CMAKE_C_COMPILER_TARGET gcc_ntoaarch64le)",
      ),
    ).toEqual([["QNX-BUILD-001", 2]]);
    expect(
      hits(
        "qnx.cmake",
        "set(CMAKE_SYSTEM_NAME QNX)",
        "set(CMAKE_C_COMPILER_TARGET 12.2.0,gcc_ntoaarch64le)",
      ),
    ).toEqual([]);
  });

  it("requires versions for QNX Software Center packages", () => {
    expect(
      hits(
        "install.sh",
        "qnxsoftwarecenter_clt -destination ~/qnx800 \\",
        "  -installBaseline com.qnx.qnx800",
        "qnxsoftwarecenter_clt -installPackage com.example.a/1.0,com.example.b",
      ),
    ).toEqual([
      ["QNX-BUILD-003", 2],
      ["QNX-BUILD-003", 3],
    ]);
    expect(
      hits("install.sh", "qnxsoftwarecenter_clt -installBaseline com.qnx.qnx800/8.0.0"),
    ).toEqual([]);
  });

  it("requires an architecture on bootable buildfiles only", () => {
    expect(hits("ifs.build", "[virtual=bios] .bootstrap = {", "  procnto-smp-instr", "}")).toEqual([
      ["QNX-BUILD-004", 1],
    ]);
    expect(
      hits("ifs.build", "[virtual=aarch64le,raw] .bootstrap = {", "  procnto-smp-instr", "}"),
    ).toEqual([]);
    expect(hits("data.build", "[uid=0 gid=0 perms=0644] /etc/motd = motd.txt")).toEqual([]);
  });

  it("requires --arch when mkqnximage creates a virtual target", () => {
    expect(hits("vm.sh", "mkqnximage --type=qemu --build")).toEqual([["QNX-BUILD-005", 1]]);
    expect(hits("vm.sh", "mkqnximage --type=qemu --arch=aarch64le --build")).toEqual([]);
    expect(hits("vm.sh", "mkqnximage --run")).toEqual([]);
  });
});

describe("credentials and masking", () => {
  const scanned = (path: string, ...lines: string[]) => scanFile(path, source(...lines)).violations;

  it.each([
    `qnxsoftwarecenter_clt -myqnx.user dev -myqnx.password ${FAKE_PASSWORD}`,
    `qnxsoftwarecenter_clt -addLicenseKey "${FAKE_PASSWORD}"`,
    `sshpass -p '${FAKE_PASSWORD}' scp app qnxuser@target:/tmp/ # qcc build`,
  ])("flags and masks %s", (command) => {
    const [violation] = scanned("deploy.sh", "source qnxsdp-env.sh", command);
    expect(violation?.ruleId).toBe("QNX-SECRET-001");
    expect(violation?.text).toContain(REDACTION_PLACEHOLDER);
    expect(violation?.text).not.toContain(FAKE_PASSWORD);
    expect(maskSecrets(command)).not.toContain(FAKE_PASSWORD);
  });

  it.each([
    'qnxsoftwarecenter_clt -myqnx.password "$MYQNX_PASSWORD"',
    "qnxsoftwarecenter_clt -myqnx.password ${{ secrets.MYQNX_PASSWORD }}",
    "qnxsoftwarecenter_clt @options_file",
    "MYQNX_PASSWORD=$1",
    "id-token: write",
    "TOKEN_FILE=/run/secrets/token",
  ])("accepts %s", (command) => {
    expect(scanned("deploy.sh", "source qnxsdp-env.sh", command)).toEqual([]);
  });

  it("flags hardcoded values, also inside comments", () => {
    const violations = scanned(
      "deploy.sh",
      "source qnxsdp-env.sh",
      `TARGET_PASSWORD=${FAKE_PASSWORD}`,
      `# old: api_key = "${FAKE_PASSWORD}"`,
    );
    expect(violations.map((v) => v.ruleId)).toEqual(["QNX-SECRET-003", "QNX-SECRET-003"]);
    expect(JSON.stringify(violations)).not.toContain(FAKE_PASSWORD);
  });

  it("flags private keys and password hashes in buildfiles", () => {
    const hash = ["@S@", "abcdefABCDEF0123456789"].join("");
    const violations = scanned(
      "ifs.build",
      "[virtual=x86_64,multiboot] .bootstrap = {",
      "  procnto-smp-instr",
      "}",
      "/etc/ssh/ssh_host_key = {",
      ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "),
      "}",
      "[perms=0600] /etc/shadow = {",
      `root:${hash}:0:0:0`,
      "daemon:*:0:0:0",
      "}",
    );
    expect(violations.map((v) => [v.ruleId, v.severity, v.line])).toEqual([
      ["QNX-SECRET-002", "CRITICAL", 5],
      ["QNX-SECRET-004", "HIGH", 8],
    ]);
    expect(violations[1]!.text).toBe(`root:${REDACTION_PLACEHOLDER}:0:0:0`);
  });

  it("masks a secret on a line reported by a provenance rule", () => {
    const violations = scanned(
      "build.sh",
      `PASSWORD=${FAKE_PASSWORD} qcc -Vgcc_ntox86_64 main.c -o main`,
    );
    expect(violations.map((v) => v.ruleId).sort()).toEqual(["QNX-BUILD-001", "QNX-SECRET-003"]);
    expect(JSON.stringify(violations)).not.toContain(FAKE_PASSWORD);
  });

  it("keeps secrets out of every report format", () => {
    const results = [
      scanFile("deploy.sh", source("qcc -V", `sshpass -p ${FAKE_PASSWORD} ssh root@target reboot`)),
    ];
    for (const format of ["text", "json", "sarif", "csv", "html", "markdown", "junit"] as const) {
      const report = formatScanResults(results, format);
      expect(report, format).toContain("QNX-SECRET-001");
      expect(report, format).not.toContain(FAKE_PASSWORD);
    }
  });

  it("stays fast on long lines", () => {
    const long = `qcc -V\n${"token".repeat(40000)}\n${"[".repeat(100000)}`;
    expect(scanQnxBuildFile("build.sh", long)).toEqual([]);
    expect(scanQnxBuildFile("x.build", long)).toEqual([]);
  });
});
