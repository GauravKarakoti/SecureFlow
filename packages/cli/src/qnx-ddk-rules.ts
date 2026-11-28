/**
 * QNX / Driver Development Kit rules for C and C++ sources (#2211).
 *
 * This is a lexical analysis, not a C parser: comments and literals are masked,
 * function bodies are found by matching braces, and each rule looks for one
 * narrow pattern. It does not expand macros or follow values across functions.
 * Rules only run on files that use QNX headers or APIs.
 *
 * Policy pages: docs/policies/*qnx*.md
 */

import type { Severity, Violation } from "./scanner.js";

const POLICY_BASE_URL = "https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/policies";

const REALTIME_DOC = "bound-qnx-real-time-paths.md";
const INPUT_DOC = "validate-qnx-resource-manager-inputs.md";
const BOUNDS_DOC = "enforce-bounds-checks-in-qnx-drivers.md";

export interface QnxRule {
  id: string;
  title: string;
  severity: Severity;
  cwe?: string;
  policy: string;
  guidance: string;
}

const rule = (
  id: string,
  severity: Severity,
  policy: string,
  title: string,
  guidance: string,
  cwe?: string,
): QnxRule => ({ id, severity, policy, title, guidance, ...(cwe ? { cwe } : {}) });

export const QNX_RULES = {
  rtAlloc: rule(
    "QNX-RT-001",
    "MEDIUM",
    REALTIME_DOC,
    "Dynamic memory allocation on a real-time path",
    "Allocate before entering the interrupt thread loop or locked section.",
  ),
  rtBlocking: rule(
    "QNX-RT-002",
    "MEDIUM",
    REALTIME_DOC,
    "Blocking call on a real-time path",
    "Move the call to a lower priority thread, or bound it with a timeout.",
  ),
  removedIsr: rule(
    "QNX-API-001",
    "MEDIUM",
    REALTIME_DOC,
    "InterruptAttach() was removed in QNX 8.0",
    "Use InterruptAttachThread() or InterruptAttachEvent().",
    "CWE-477",
  ),
  uncheckedReceive: rule(
    "QNX-MSG-001",
    "MEDIUM",
    INPUT_DOC,
    "MsgReceive() result is not checked",
    "Handle -1 (error) and 0 (pulse) before reading the message.",
    "CWE-252",
  ),
  msglen: rule(
    "QNX-MSG-002",
    "MEDIUM",
    INPUT_DOC,
    "ctp->info.msglen used in a resource manager",
    "Check lengths against ctp->size, which accounts for combine messages.",
    "CWE-20",
  ),
  devctlLength: rule(
    "QNX-IOCTL-001",
    "HIGH",
    INPUT_DOC,
    "devctl payload read without checking the received length",
    "Compare ctp->size with sizeof(msg->i) plus the payload size, or read it with resmgr_msgget().",
    "CWE-20",
  ),
  devctlNbytes: rule(
    "QNX-IOCTL-002",
    "MEDIUM",
    INPUT_DOC,
    "msg->i.nbytes used in a devctl handler",
    "The value is client supplied. Use ctp->size for length checks.",
    "CWE-20",
  ),
  uncheckedMap: rule(
    "QNX-MEM-001",
    "MEDIUM",
    INPUT_DOC,
    "Device mapping result is not checked",
    "Compare with MAP_FAILED (mmap_device_memory) or MAP_DEVICE_FAILED (mmap_device_io).",
    "CWE-252",
  ),
  missingRelease: rule(
    "QNX-RES-001",
    "LOW",
    INPUT_DOC,
    "Resource is acquired but never released in this file",
    "Call the matching detach, unmap or destroy function on shutdown and error paths.",
    "CWE-772",
  ),
  clientLength: rule(
    "QNX-BOUNDS-001",
    "HIGH",
    BOUNDS_DOC,
    "Client supplied length used as a copy size without a bounds check",
    "Compare the length with both the destination size and the bytes received.",
    "CWE-130",
  ),
  allocOverflow: rule(
    "QNX-BOUNDS-002",
    "HIGH",
    BOUNDS_DOC,
    "Arithmetic on a client supplied value in an allocation size",
    "Reject values above a fixed maximum before doing the arithmetic.",
    "CWE-190",
  ),
  unboundedString: rule(
    "QNX-BOUNDS-003",
    "MEDIUM",
    BOUNDS_DOC,
    "Unbounded string function in driver code",
    "Use snprintf() or strlcpy() with the destination size.",
    "CWE-120",
  ),
} as const;

const C_FAMILY = /\.(?:c|h|cc|cpp|cxx|hh|hpp|hxx)$/i;
const CPP_ONLY = /\.(?:cc|cpp|cxx|hh|hpp|hxx)$/i;
const HEADER = /\.(?:h|hh|hpp|hxx)$/i;

const QNX_INCLUDE =
  /^[ \t]*#[ \t]*include[ \t]*<(?:sys\/(?:neutrino|resmgr|iofunc|dispatch|iomsg|iomgr)\.h|devctl\.h|hw\/inout\.h)>/m;
const QNX_API =
  /\b(?:MsgReceivev?|resmgr_attach|iofunc_\w+|InterruptAttach(?:Thread|Event)|mmap_device_(?:io|memory)|name_attach|_DEVCTL_DATA|_IO_INPUT_PAYLOAD)\s*\(/;

export function shouldRunQnxAnalysis(filePath: string): boolean {
  return C_FAMILY.test(filePath);
}

/**
 * Replaces comments and the contents of string and character literals with
 * spaces. Length and newlines are preserved so offsets match the original.
 */
export function maskCSource(source: string): string {
  const out = source.split("");
  const blank = (index: number) => {
    if (out[index] !== "\n") out[index] = " ";
  };
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") blank(i++);
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (i < stop) blank(i++);
    } else if (
      char === '"' ||
      // A quote inside a number is a C++14 digit separator, not a literal
      (char === "'" && !/(?<!\w)\d[\w']*$/.test(source.slice(Math.max(0, i - 32), i)))
    ) {
      i++;
      while (i < source.length && source[i] !== char && source[i] !== "\n") {
        if (source[i] === "\\") blank(i++);
        blank(i++);
      }
      i++;
    } else {
      i++;
    }
  }

  return out.join("");
}

/** Blanks preprocessor lines (and their continuations) so macros do not count as code. */
function maskPreprocessor(masked: string): string {
  let continued = false;
  return masked
    .split("\n")
    .map((line) => {
      const directive = continued || /^[ \t]*#/.test(line);
      continued = directive && /\\\s*$/.test(line);
      return directive ? " ".repeat(line.length) : line;
    })
    .join("\n");
}

interface Brackets {
  /** Offset of an opening ( or { to its closing bracket, and the reverse. */
  close: Map<number, number>;
  open: Map<number, number>;
}

/** Pairs up () and {} in one pass so later lookups are constant time. */
function pairBrackets(code: string): Brackets {
  const brackets: Brackets = { close: new Map(), open: new Map() };
  const stacks: Record<string, number[]> = { "(": [], "{": [] };
  for (let i = 0; i < code.length; i++) {
    const char = code[i]!;
    if (char === "(" || char === "{") {
      stacks[char]!.push(i);
    } else if (char === ")" || char === "}") {
      const start = stacks[char === ")" ? "(" : "{"]!.pop();
      if (start !== undefined) {
        brackets.close.set(start, i);
        brackets.open.set(i, start);
      }
    }
  }
  return brackets;
}

interface Region {
  start: number;
  end: number;
}

interface CFunction extends Region {
  params: string;
  headerStart: number;
}

const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch"]);

function findFunctions(code: string, brackets: Brackets): CFunction[] {
  const functions: CFunction[] = [];

  for (let open = code.indexOf("{"); open !== -1; open = code.indexOf("{", open + 1)) {
    let i = open - 1;
    while (i >= 0 && /\s/.test(code[i]!)) i--;
    const trailing = /\b(?:const|noexcept|override|final)$/.exec(
      code.slice(Math.max(0, i - 8), i + 1),
    );
    if (trailing) {
      i -= trailing[0].length;
      while (i >= 0 && /\s/.test(code[i]!)) i--;
    }
    if (code[i] !== ")") continue;

    const closeParen = i;
    const openParen = brackets.open.get(closeParen);
    if (openParen === undefined) continue;
    i = openParen;

    const name = /([A-Za-z_]\w*)\s*$/.exec(code.slice(Math.max(0, i - 128), i))?.[1];
    if (!name || CONTROL_KEYWORDS.has(name)) continue;

    const end = brackets.close.get(open);
    if (end === undefined) continue;

    // The header starts after the previous statement or block
    let headerStart = i;
    while (headerStart > 0 && !";{}".includes(code[headerStart - 1]!)) headerStart--;
    functions.push({ start: open, end, params: code.slice(i + 1, closeParen), headerStart });
    open = end;
  }

  return functions;
}

/** The innermost loop (condition and body) around each InterruptWait() call. */
function findInterruptLoops(code: string, brackets: Brackets, fn: CFunction): Region[] {
  const loops: Region[] = [];
  const body = code.slice(fn.start, fn.end);

  for (const match of body.matchAll(/\b(?:for|while)\s*\(|\bdo\s*\{/g)) {
    const at = fn.start + match.index;
    const opener = at + match[0].length - 1;
    let blockStart = opener;
    if (code[opener] === "(") {
      const close = brackets.close.get(opener);
      if (close === undefined) continue;
      blockStart = close + 1;
      while (/\s/.test(code[blockStart] ?? "")) blockStart++;
    }
    if (code[blockStart] !== "{") continue;
    const end = brackets.close.get(blockStart);
    if (end !== undefined) loops.push({ start: at, end });
  }

  const found = new Map<number, Region>();
  for (const wait of body.matchAll(/\bInterruptWait(?:_r)?\s*\(/g)) {
    const at = fn.start + wait.index;
    const inner = loops
      .filter((loop) => loop.start < at && at < loop.end)
      .sort((a, b) => b.start - a.start)[0];
    if (inner) found.set(inner.start, inner);
  }
  return [...found.values()];
}

function findLockedSections(code: string, fn: CFunction): Region[] {
  const sections: Region[] = [];
  let lockedAt = -1;
  for (const match of code.slice(fn.start, fn.end).matchAll(/\bInterrupt(Lock|Unlock)\s*\(/g)) {
    if (match[1] === "Lock") {
      if (lockedAt === -1) lockedAt = fn.start + match.index;
    } else if (lockedAt !== -1) {
      sections.push({ start: lockedAt, end: fn.start + match.index });
      lockedAt = -1;
    }
  }
  return sections;
}

interface Call {
  name: string;
  index: number;
  close: number;
  args: Array<{ text: string; start: number }>;
}

/** Calls to any function whose name matches `names` (member calls excluded). */
function findCalls(code: string, brackets: Brackets, names: string, region: Region): Call[] {
  const pattern = new RegExp(`(?<![\\w.]|->)(${names})\\s*\\(`, "g");
  const calls: Call[] = [];

  for (const match of code.slice(region.start, region.end).matchAll(pattern)) {
    const index = region.start + match.index;
    const open = index + match[0].length - 1;
    const close = brackets.close.get(open);
    if (close === undefined) continue;

    const args: Call["args"] = [];
    let depth = 0;
    let from = open + 1;
    for (let i = open + 1; i <= close; i++) {
      const char = code[i]!;
      if (i === close || (char === "," && depth === 0)) {
        args.push({ text: code.slice(from, i).trim(), start: from });
        from = i + 1;
      } else if (char === "(" || char === "[" || char === "{") depth++;
      else if (char === ")" || char === "]" || char === "}") depth--;
    }
    calls.push({ name: match[1]!, index, close, args });
  }

  return calls;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Allows any spacing around `->` and `.` in an expression such as `msg->i.nbytes`. */
function expressionPattern(expression: string): string {
  return expression
    .split(/(->|\.)/)
    .map((part) => escapeRegex(part.trim()))
    .join("\\s*");
}

/** Offset where `expression` first appears next to a relational operator. */
function firstBoundsCheck(code: string, expression: string): number {
  const target = `(?<![\\w.>])${expressionPattern(expression)}(?!\\w)`;
  const match = new RegExp(
    `${target}\\s*(?:<=|>=|<(?![<=])|>(?![>=]))|(?<![-<>])(?:<=|>=|<|>)\\s*(?:\\(\\s*[\\w ]+\\)\\s*)?${target}`,
  ).exec(code);
  return match ? match.index : Infinity;
}

/**
 * The variable a call result is stored in. `checked` is true when the result is
 * compared or consumed where the call is made.
 */
function resultUse(code: string, call: Call): { checked: boolean; variable?: string } {
  const before = code.slice(Math.max(0, call.index - 160), call.index);
  const after = code.slice(call.close + 1, call.close + 40);
  if (/^[\s)]*(?:==|!=|<=|>=|<|>)/.test(after)) return { checked: true };

  const assigned = /([A-Za-z_]\w*(?:\s*(?:->|\.)\s*\w+)*)\s*=\s*(?:\([\w\s*]+\)\s*)?$/.exec(before);
  if (assigned) return { checked: false, variable: assigned[1]! };

  const discarded = /(?:[;{}]|\(\s*void\s*\))\s*$/.test(before) && /^\s*;/.test(after);
  return { checked: !discarded };
}

const ALLOCATORS = "malloc|calloc|realloc|free|strdup|strndup|aligned_alloc|posix_memalign";
const BLOCKING =
  "sleep|usleep|delay|sem_wait|pthread_cond_wait|pthread_join|printf|fprintf|puts|fopen|fread|fwrite|fflush|system|getchar|scanf";
const MSG_SEND = "MsgSend(?:v|s|sv|vs|nc|vnc|svnc|vsnc|snc)?(?:_r)?";

const RELEASE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["resmgr_attach", "resmgr_detach"],
  ["name_attach", "name_detach"],
  ["InterruptAttach(?:Array|Thread|Event|EventPriority)?", "InterruptDetach"],
  ["mmap_device_memory", "munmap_device_memory|munmap"],
  ["mmap_device_io", "munmap_device_io"],
  ["ConnectAttach", "ConnectDetach"],
  ["ChannelCreate", "ChannelDestroy"],
];

/** Scans one C / C++ source for QNX driver and real-time problems. */
export function scanQnxSource(filePath: string, content: string): Violation[] {
  if (!shouldRunQnxAnalysis(filePath)) return [];

  const masked = maskCSource(content);
  if (!QNX_INCLUDE.test(masked) && !QNX_API.test(masked)) return [];

  const code = maskPreprocessor(masked);
  const brackets = pairBrackets(code);
  const calls = (names: string, region: Region) => findCalls(code, brackets, names, region);
  const whole: Region = { start: 0, end: code.length };
  const lines = content.split("\n");
  const found = new Map<string, Violation>();
  const lineStarts = [0];
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) lineStarts.push(i + 1);

  const report = (qnxRule: QnxRule, index: number) => {
    // Number of lines starting at or before `index`
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lineStarts[middle]! <= index) low = middle + 1;
      else high = middle;
    }
    const line = low;
    const cwe = qnxRule.cwe ? `, ${qnxRule.cwe}` : "";
    found.set(`${qnxRule.id}:${line}`, {
      line,
      text: (lines[line - 1] ?? "").trim(),
      reason: `${qnxRule.title} (${qnxRule.id}${cwe})`,
      severity: qnxRule.severity,
      ruleId: qnxRule.id,
      custom: true,
      helpUrl: `${POLICY_BASE_URL}/${qnxRule.policy}`,
      guidance: qnxRule.guidance,
    });
  };

  for (const call of calls("InterruptAttach|InterruptAttachArray", whole)) {
    report(QNX_RULES.removedIsr, call.index);
  }

  const resmgrContexts = new Set(
    [...code.matchAll(/\bresmgr_context_t\s*\*\s*(?:const\s+)?([A-Za-z_]\w*)/g)].map((m) => m[1]!),
  );
  for (const name of resmgrContexts) {
    for (const m of code.matchAll(
      new RegExp(`\\b${name}\\s*->\\s*info\\s*\\.\\s*msglen\\b`, "g"),
    )) {
      report(QNX_RULES.msglen, m.index);
    }
  }

  for (const call of calls("strcpy|strcat|sprintf|vsprintf|gets", whole)) {
    const second = call.args[1];
    if (!second) {
      if (call.name === "gets") report(QNX_RULES.unboundedString, call.index);
      continue;
    }
    const raw = content.slice(second.start, call.close).trim();
    // Copying a literal, or formatting without an unbounded %s, has a known size
    if ((call.name === "strcpy" || call.name === "strcat") && raw.startsWith('"')) continue;
    if (call.name === "sprintf") {
      const format = /^"(?:[^"\\\n]|\\.)*"/.exec(raw)?.[0];
      if (format && !/%[-+ #0]*(?:\d+|\*)?(?:l|h)?s/.test(format)) continue;
    }
    report(QNX_RULES.unboundedString, call.index);
  }

  if (!HEADER.test(filePath)) {
    for (const [acquire, release] of RELEASE_PAIRS) {
      const first = calls(acquire, whole)[0];
      if (first && !new RegExp(`(?<!\\w)(?:${release})\\s*\\(`).test(code)) {
        report(QNX_RULES.missingRelease, first.index);
      }
    }
  }

  for (const fn of findFunctions(code, brackets)) {
    const body = code.slice(fn.start, fn.end);

    // Real-time paths: interrupt thread loops, spinlocked sections, and
    // functions marked with a `secureflow:realtime` comment.
    const marked = content.slice(fn.headerStart, fn.start).includes("secureflow:realtime");
    const regions = marked
      ? [fn]
      : [...findInterruptLoops(code, brackets, fn), ...findLockedSections(code, fn)];

    for (const region of regions) {
      for (const call of calls(ALLOCATORS, region)) {
        report(QNX_RULES.rtAlloc, call.index);
      }
      if (CPP_ONLY.test(filePath)) {
        const slice = code.slice(region.start, region.end);
        for (const m of slice.matchAll(/\bnew\s+[A-Za-z_:(]|\bdelete\b\s*(?:\[\s*\])?\s*\w/g)) {
          report(QNX_RULES.rtAlloc, region.start + m.index);
        }
      }
      for (const call of calls(BLOCKING, region)) {
        report(QNX_RULES.rtBlocking, call.index);
      }
      for (const call of calls(MSG_SEND, region)) {
        if (!/\bTimerTimeout(?:_r)?\s*\(/.test(code.slice(fn.start, call.index))) {
          report(QNX_RULES.rtBlocking, call.index);
        }
      }
    }

    for (const call of calls("MsgReceivev?", fn)) {
      const use = resultUse(code, call);
      if (use.checked) continue;
      if (use.variable) {
        const target = expressionPattern(use.variable);
        const compared = new RegExp(
          `(?<![\\w.>])${target}\\s*(?:==|!=|<=|>=|<(?!<)|>(?!>))|(?:==|!=|<=|>=)\\s*${target}(?!\\w)|\\bswitch\\s*\\(\\s*${target}\\s*\\)|\\bif\\s*\\(\\s*!?\\s*${target}\\s*\\)|\\breturn\\s+${target}\\s*;`,
        );
        if (compared.test(body)) continue;
      }
      report(QNX_RULES.uncheckedReceive, call.index);
    }

    for (const call of calls("mmap_device_memory|mmap_device_io", fn)) {
      const use = resultUse(code, call);
      if (use.checked) continue;
      if (use.variable) {
        const target = expressionPattern(use.variable);
        const sentinel = "(?:\\(\\s*[\\w\\s*]+\\)\\s*)?MAP_(?:DEVICE_)?FAILED";
        const compared = new RegExp(
          `${target}\\s*[!=]=\\s*${sentinel}|${sentinel}\\s*[!=]=\\s*${target}(?!\\w)`,
        );
        if (compared.test(body)) continue;
      }
      report(QNX_RULES.uncheckedMap, call.index);
    }

    const devctlMessage = /\bio_devctl_t\s*\*\s*([A-Za-z_]\w*)/.exec(fn.params)?.[1];
    if (devctlMessage) {
      // _IO_INPUT_PAYLOAD(msg) in QNX 8.0, _DEVCTL_DATA(msg->i) in older code
      const payload = new RegExp(
        `\\b(?:_IO_INPUT_PAYLOAD\\s*\\(\\s*${devctlMessage}\\b|_DEVCTL_DATA\\s*\\(\\s*${devctlMessage}\\s*->\\s*i\\b)`,
      ).exec(body);
      const context = /\bresmgr_context_t\s*\*\s*(?:const\s+)?([A-Za-z_]\w*)/.exec(fn.params)?.[1];
      const lengthCheck = new RegExp(
        `\\bresmgr_msg(?:get|getv|getsize|read|readv)\\s*\\(|\\bsrcmsglen\\b${
          context ? `|\\b${context}\\s*->\\s*size\\b` : ""
        }`,
      );
      if (payload && !lengthCheck.test(body)) {
        report(QNX_RULES.devctlLength, fn.start + payload.index);
      }
      for (const m of body.matchAll(
        new RegExp(`\\b${devctlMessage}\\s*->\\s*i\\s*\\.\\s*nbytes\\b`, "g"),
      )) {
        report(QNX_RULES.devctlNbytes, fn.start + m.index);
      }
    }

    // Values the client controls: `x->i.field`, and locals assigned directly from one
    const clientField = "[A-Za-z_]\\w*\\s*->\\s*i\\s*\\.\\s*\\w+";
    const aliases = new Map<string, string>();
    for (const m of body.matchAll(
      new RegExp(`\\b([A-Za-z_]\\w*)\\s*=\\s*(?:\\([\\w\\s]+\\)\\s*)?(${clientField})\\s*;`, "g"),
    )) {
      aliases.set(m[1]!, m[2]!.replace(/\s+/g, ""));
    }

    const checkedAt = new Map<string, number>();
    const boundedBefore = (value: string, at: number): boolean => {
      let index = checkedAt.get(value);
      if (index === undefined) {
        index = firstBoundsCheck(body, value);
        checkedAt.set(value, index);
      }
      return index < at - fn.start;
    };

    const isUnbounded = (argument: string, at: number): boolean => {
      if (/\b(?:min|MIN)\s*\(|\?/.test(argument)) return false;
      const direct = [...argument.matchAll(new RegExp(clientField, "g"))].map((m) =>
        m[0].replace(/\s+/g, ""),
      );
      if (direct.some((value) => !boundedBefore(value, at))) return true;
      return [...aliases].some(
        ([alias, source]) =>
          new RegExp(`(?<![\\w.>])${alias}(?!\\w)`).test(argument) &&
          !boundedBefore(alias, at) &&
          !boundedBefore(source, at),
      );
    };

    /** The size expression without parts whose value is fixed at compile time. */
    const dynamicPart = (argument: string) =>
      argument.replace(/\b(?:sizeof|offsetof)\s*\((?:[^()]|\([^()]*\))*\)/g, "0");

    for (const call of calls("memcpy|memmove|strncpy|MsgRead|resmgr_msgread|resmgr_msgget", fn)) {
      const size = call.args[2];
      if (size && isUnbounded(dynamicPart(size.text), call.index)) {
        report(QNX_RULES.clientLength, call.index);
      }
    }

    for (const call of calls("malloc|realloc|alloca", fn)) {
      const size = call.args[call.args.length - 1];
      if (!size) continue;
      const expression = dynamicPart(size.text).replace(/\(\s*[\w\s]+\*+\s*\)/g, "");
      if (/\+|[\w)\]]\s*\*/.test(expression) && isUnbounded(expression, call.index)) {
        report(QNX_RULES.allocOverflow, call.index);
      }
    }
  }

  return [...found.values()].sort((a, b) => a.line - b.line);
}
