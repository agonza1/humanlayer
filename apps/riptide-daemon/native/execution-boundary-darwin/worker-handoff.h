#ifndef HUMANLAYER_DARWIN_WORKER_HANDOFF_H
#define HUMANLAYER_DARWIN_WORKER_HANDOFF_H

#include <sys/types.h>

// Call in a trusted, single-threaded privileged child before it starts user
// code. The supervisor supplies a pinned, close-on-exec workspace directory
// and closes its other private descriptors. Any failure is terminal for the
// child, even if some credentials or its working directory already changed.
// Returns zero or the errno value directly.
int darwin_enter_worker_workspace(uid_t uid, gid_t gid, int workspace_fd);

#endif
