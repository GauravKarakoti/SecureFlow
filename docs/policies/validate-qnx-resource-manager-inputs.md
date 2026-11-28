# Validate QNX Resource Manager Inputs

## Problem

A resource manager or message-passing server receives data from other processes. The client chooses the message contents, including length fields such as `msg->i.nbytes`. QNX states that the base library [does not check the payload length](https://qnx.com/developers/docs/8.0/com.qnx.doc.security.system/topic/manual/message_checking.html) of some resource manager messages, that `msg->i.nbytes` must not be used for `_IO_DEVCTL`, and that `ctp->size` should be used instead of `ctp->info.msglen`. Ignoring errors from `MsgReceive()` or from device mappings leaves the driver working on data or addresses that are not valid, and unreleased resources pile up when a driver restarts parts of itself.

## Example

```c
// Vulnerable: copies a devctl payload without knowing how much arrived
int io_devctl(resmgr_context_t *ctp, io_devctl_t *msg, iofunc_ocb_t *ocb) {
    struct config cfg;
    memcpy(&cfg, _IO_INPUT_PAYLOAD(msg), sizeof(cfg));
    return apply_config(&cfg);
}
```

## Fix

Check the received size before reading the payload.

```c
// Remediated: reject short messages
int io_devctl(resmgr_context_t *ctp, io_devctl_t *msg, iofunc_ocb_t *ocb) {
    struct config cfg;
    if (ctp->size < sizeof(msg->i) + sizeof(cfg)) {
        return EBADMSG;
    }
    memcpy(&cfg, _IO_INPUT_PAYLOAD(msg), sizeof(cfg));
    return apply_config(&cfg);
}
```

The example leaves out the `iofunc_devctl_default()` call and the permission check that a full handler also needs.

## SecureFlow rules

| Rule            | Severity | Reports                                                                                                                                                                              |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QNX-IOCTL-001` | HIGH     | A handler with an `io_devctl_t *` parameter reads `_IO_INPUT_PAYLOAD(msg)` or `_DEVCTL_DATA(msg->i)` and never refers to `ctp->size`, `srcmsglen` or a `resmgr_msg*` read function   |
| `QNX-IOCTL-002` | MEDIUM   | `msg->i.nbytes` used in a devctl handler                                                                                                                                             |
| `QNX-MSG-001`   | MEDIUM   | The result of `MsgReceive()` / `MsgReceivev()` is discarded or never compared in the function                                                                                        |
| `QNX-MSG-002`   | MEDIUM   | `ctp->info.msglen` on a `resmgr_context_t *`                                                                                                                                         |
| `QNX-MEM-001`   | MEDIUM   | The result of `mmap_device_memory()` is not compared with `MAP_FAILED`, or of `mmap_device_io()` with `MAP_DEVICE_FAILED`, in the function                                           |
| `QNX-RES-001`   | LOW      | `resmgr_attach`, `name_attach`, `InterruptAttach*`, `mmap_device_memory`, `mmap_device_io`, `ConnectAttach` or `ChannelCreate` with no matching release call in the same source file |

`QNX-RES-001` only looks at one file. If the release is in another file, or the process is meant to hold the resource until it exits, suppress it:

```c
// secureflow-ignore[rule=QNX-RES-001]: held for the lifetime of the process
```
