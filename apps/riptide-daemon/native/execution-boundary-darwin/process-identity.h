#ifndef HUMANLAYER_DARWIN_PROCESS_IDENTITY_H
#define HUMANLAYER_DARWIN_PROCESS_IDENTITY_H

#include <mach/mach.h>
#include <sys/types.h>

// Both operations belong in the trusted supervisor. The UID must come from
// its own lease, and the token must stay local. A caller-supplied token is
// just bytes and cannot establish identity or authorization.
kern_return_t darwin_capture_process_identity(pid_t pid, uid_t uid, audit_token_t *identity);

// Returns an errno value directly, or zero if Darwin accepted delivery.
// The token is specific to one process incarnation and can go stale on exec.
// Capture samples the UIDs. Privileged delivery requires independently
// enforced membership throughout the lease. Delivery alone proves no exit.
int darwin_signal_process_identity(audit_token_t identity, int signal_number);

#endif
