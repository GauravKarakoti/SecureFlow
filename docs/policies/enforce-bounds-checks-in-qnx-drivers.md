# Enforce Bounds Checks in QNX Drivers

## Problem

Driver code that copies, reads or allocates using a size taken from a client message can write past its buffer or wrap an integer to a small allocation. QNX warns that `msg->i.nbytes` is [supplied by the client](https://qnx.com/developers/docs/8.0/com.qnx.doc.security.system/topic/manual/message_checking.html) and has to be checked. Unbounded string functions have the same effect with any untrusted string (CWE-120, CWE-130, CWE-190).

## Example

```c
// Vulnerable: n + 1 can wrap, and nothing says n bytes arrived
size_t n = msg->i.nbytes;
char *buf = malloc(n + 1);
resmgr_msgread(ctp, buf, n, sizeof(msg->i));
```

## Fix

Cap the length first, then confirm how many bytes were read.

```c
// Remediated: fixed maximum and a checked read
size_t n = msg->i.nbytes;
if (n > MAX_WRITE) {
    return EMSGSIZE;
}
char *buf = malloc(n + 1);
if (buf == NULL) {
    return ENOMEM;
}
if (resmgr_msgget(ctp, buf, n, sizeof(msg->i)) != n) {
    free(buf);
    return EBADMSG;
}
buf[n] = '\0';
```

## SecureFlow rules

| Rule             | Severity | Reports                                                                                                                                                                                                              |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QNX-BOUNDS-001` | HIGH     | `memcpy`, `memmove`, `strncpy`, `MsgRead`, `resmgr_msgread` or `resmgr_msgget` whose size is a `->i.` message field (or a local assigned from one) with no earlier `<`, `<=`, `>` or `>=` comparison in the function |
| `QNX-BOUNDS-002` | HIGH     | `malloc`, `realloc` or `alloca` doing `+` or `*` on such a value with no earlier comparison                                                                                                                          |
| `QNX-BOUNDS-003` | MEDIUM   | `strcpy` or `strcat` from a non-literal, `sprintf` with a non-literal format or an unbounded `%s`, `vsprintf`, `gets`                                                                                                |

## Limits of these checks

The rules read the source text. They do not compile it, expand macros or follow values between functions.

- Any relational comparison of the value counts as a bounds check, even one with the wrong limit.
- A size passed through `min()` / `MIN()` or a ternary expression is treated as bounded.
- Values read through other names, such as `msg->count` or a copied struct, are not tracked.
- Validation done in a helper function is not seen.

A clean result does not show that the driver is safe. None of the rules or examples have been built or run with a QNX toolchain.
