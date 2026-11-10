#define _POSIX_C_SOURCE 200809L
#include <sys/types.h>
#include <unistd.h>

// Read the kernel group list even when the numeric UID has no directory account.
int
darwin_kernel_getgroups(int size, gid_t *groups)
{
    return getgroups(size, groups);
}
