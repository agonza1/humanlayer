#include "process-identity.h"

#include <bsm/libbsm.h>
#include <errno.h>
#include <libproc.h>
#include <signal.h>

kern_return_t
darwin_capture_process_identity(pid_t pid, uid_t uid, audit_token_t *identity)
{
    if (pid <= 1 || uid == 0 || uid == (uid_t)-1 || identity == NULL) {
        return KERN_INVALID_ARGUMENT;
    }

    mach_port_name_t port = MACH_PORT_NULL;
    kern_return_t result = task_name_for_pid(mach_task_self(), pid, &port);
    if (result != KERN_SUCCESS) {
        return result;
    }

    audit_token_t token;
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    result = task_info(port, TASK_AUDIT_TOKEN, (task_info_t)&token, &count);
    mach_port_deallocate(mach_task_self(), port);
    if (result != KERN_SUCCESS) {
        return result;
    }
    if (count != TASK_AUDIT_TOKEN_COUNT || audit_token_to_pid(token) != pid ||
        audit_token_to_ruid(token) != uid || audit_token_to_euid(token) != uid) {
        return KERN_PROTECTION_FAILURE;
    }
    *identity = token;
    return KERN_SUCCESS;
}

int
darwin_signal_process_identity(audit_token_t identity, int signal_number)
{
    if (signal_number != SIGTERM && signal_number != SIGKILL) {
        return EINVAL;
    }
    // The kernel checks the PID and version together. Retrying via kill(pid)
    // would let an old request affect a replacement process.
    return proc_signal_with_audittoken(&identity, signal_number);
}
