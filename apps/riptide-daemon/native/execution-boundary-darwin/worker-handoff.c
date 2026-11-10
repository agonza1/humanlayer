#define _DARWIN_C_SOURCE 1
#include "worker-handoff.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

int darwin_kernel_getgroups(int size, gid_t *groups);

int
darwin_enter_worker_workspace(uid_t uid, gid_t gid, int workspace_fd)
{
    if (getuid() != 0 || geteuid() != 0) return EPERM;
    if (uid == 0 || gid == 0 || uid == (uid_t)-1 || gid == (gid_t)-1) return EINVAL;

    struct stat expected;
    int flags = fcntl(workspace_fd, F_GETFD);
    if (flags < 0 || fstat(workspace_fd, &expected) < 0) return errno;
    if (!(flags & FD_CLOEXEC) || !S_ISDIR(expected.st_mode) ||
        expected.st_uid != uid || expected.st_gid != gid || (expected.st_mode & 0077)) {
        return EACCES;
    }

    if (setgid(gid) < 0 || setgroups(1, &gid) < 0 || setuid(uid) < 0) return errno;
    if (getuid() != uid || geteuid() != uid || getgid() != gid || getegid() != gid) return EPERM;

    gid_t group;
    int group_count = darwin_kernel_getgroups(1, &group);
    if (group_count < 0) return errno;
    if (group_count != 1 || group != gid) return EPERM;
    if (seteuid(0) != -1 || errno != EPERM) return EPERM;
    if (setegid(0) != -1 || errno != EPERM) return EPERM;

    // Check traversal with the worker's credentials. fchdir alone can reach
    // a directory even when the worker cannot traverse its ancestors by path.
    char path[PATH_MAX];
    struct stat observed;
    if (fchdir(workspace_fd) < 0 || getcwd(path, sizeof(path)) == NULL || stat(path, &observed) < 0) {
        return errno;
    }
    return observed.st_dev == expected.st_dev && observed.st_ino == expected.st_ino ? 0 : ESTALE;
}
