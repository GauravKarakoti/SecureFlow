# Bound QNX Real-Time Paths

## Problem

An interrupt service thread or a section holding `InterruptLock()` has to finish within a predictable time. Heap allocation and calls that wait on another thread, a process or I/O can add delay with no useful upper limit and make the system miss its deadlines. QNX asks for spinlocked sections to be [as short as possible](https://qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/i/interruptlock.html). QNX 8.0 also [removed interrupt service routines](https://qnx.com/developers/docs/8.0/com.qnx.doc.qnxsdp.migration/topic/kernel.html), including `InterruptAttach()` and `InterruptAttachArray()`.

## Example

```c
// Vulnerable: allocates and sleeps on every interrupt
for (;;) {
    InterruptWait(_NTO_INTR_WAIT_FLAGS_UNMASK, NULL);
    struct sample *s = malloc(sizeof(*s));
    read_registers(s);
    sleep(1);
    publish(s);
}
```

## Fix

Allocate before the loop, and hand slow work to another thread without waiting for it.

```c
// Remediated: fixed buffer and a non-blocking notification
static struct sample s;

for (;;) {
    InterruptWait(_NTO_INTR_WAIT_FLAGS_UNMASK, NULL);
    read_registers(&s);
    MsgSendPulse(coid, -1, PULSE_SAMPLE_READY, 0);
}
```

## SecureFlow rules

The CLI runs these on `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp` and `.hxx` files that use QNX headers or APIs.

| Rule          | Severity | Reports                                                                                                                                                                                                   |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QNX-RT-001`  | MEDIUM   | `malloc`, `calloc`, `realloc`, `free`, `strdup`, `strndup`, `aligned_alloc`, `posix_memalign` (and `new` / `delete` in C++ files) on a real-time path                                                     |
| `QNX-RT-002`  | MEDIUM   | `sleep`, `usleep`, `delay`, `sem_wait`, `pthread_cond_wait`, `pthread_join`, common stdio calls, `system`, or a `MsgSend()` variant with no earlier `TimerTimeout()` in the function, on a real-time path |
| `QNX-API-001` | MEDIUM   | `InterruptAttach()` or `InterruptAttachArray()` anywhere                                                                                                                                                  |

A **real-time path** is one of:

- the innermost loop that contains `InterruptWait()`
- the code between `InterruptLock()` and `InterruptUnlock()` in one function
- a whole function with a `secureflow:realtime` comment directly above it

```c
/* secureflow:realtime */
void control_step(void) { /* ... */ }
```

Functions called from a real-time path are not followed. Mark them too if they must meet the same rule.

To accept a finding, add a reason on the line above:

```c
// secureflow-ignore[rule=QNX-RT-002]: trace output in debug builds only
```
