#define _DARWIN_C_SOURCE 1
#include "worker-handoff.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static bool
number(const char *text, uintmax_t *value)
{
    if (!text[0]) return false;
    for (const char *p = text; *p; p++) if (!isdigit((unsigned char)*p)) return false;
    char *end;
    errno = 0;
    *value = strtoumax(text, &end, 10);
    return !errno && !*end;
}

static bool
env_name(const char *name)
{
    if (!isalpha((unsigned char)*name) && *name != '_') return false;
    for (const char *p = name + 1; *p; p++) if (!isalnum((unsigned char)*p) && *p != '_') return false;
    return true;
}

int
main(int argc, char **argv)
{
    if (getuid() != 0 || geteuid() != 0) return 77;
    uintmax_t uid, gid, device, inode, count;
    if (argc < 12 || strcmp(argv[1], "--handoff") ||
        !number(argv[2], &uid) || !number(argv[3], &gid) ||
        uid == 0 || gid == 0 || uid >= UINT32_MAX - 1 || gid >= UINT32_MAX - 1 ||
        !number(argv[4], &device) || !number(argv[5], &inode) ||
        !number(argv[9], &count) || count > 4096 ||
        count * 2 + 11 >= (uintmax_t)argc || strcmp(argv[10 + count * 2], "--")) return 64;
    int command = 11 + (int)count * 2;
    if (argv[6][0] != '/' || argv[7][0] != '/' || argv[command][0] != '/') return 64;

    struct stat supervisor, workspace;
    if (lstat(argv[7], &supervisor) < 0 || !S_ISDIR(supervisor.st_mode) ||
        supervisor.st_uid != 0 || (supervisor.st_mode & 0077)) return 2;
    int fd = open(argv[6], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &workspace) < 0 ||
        (uintmax_t)workspace.st_dev != device || (uintmax_t)workspace.st_ino != inode) return 2;

    const char *guard = "(deny file-read* file-write* (subpath (param \"HL_SUPERVISOR_PRIVATE\")))";
    char *profile, *parameter;
    if (asprintf(&profile, "%s%s", argv[8], guard) < 0 ||
        asprintf(&parameter, "HL_SUPERVISOR_PRIVATE=%s", argv[7]) < 0) return 2;
    char **args = calloc((size_t)argc + 12, sizeof(*args));
    if (!args) return 2;
    int next = 0;
    args[next++] = "/usr/bin/sandbox-exec";
    args[next++] = "-D";
    args[next++] = parameter;
    args[next++] = "-p";
    args[next++] = profile;
    args[next++] = "/usr/bin/env";
    args[next++] = "-i";
    for (uintmax_t i = 0; i < count; i++) {
        char *name = argv[10 + i * 2];
        if (!env_name(name) || asprintf(&args[next++], "%s=%s", name, argv[11 + i * 2]) < 0) return 64;
    }
    for (int i = command; i < argc; i++) args[next++] = argv[i];

    int entered = darwin_enter_worker_workspace((uid_t)uid, (gid_t)gid, fd);
    if (entered) { fprintf(stderr, "Private worker handoff failed: %s\n", strerror(entered)); return 2; }
    // No supervisor SQLite or workspace descriptor may reach sandboxed user code.
    for (int i = 3, limit = getdtablesize(); i < limit; i++) (void)close(i);
    char *const environment[] = { "PATH=/usr/bin:/bin", "LANG=C", NULL };
    execve(args[0], args, environment);
    perror("Private worker sandbox start failed");
    return 2;
}
