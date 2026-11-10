#define _DARWIN_C_SOURCE 1
#include "worker-handoff.h"
#include "project-fixture.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <libproc.h>
#include <pwd.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static const uid_t worker_uid = 61840;
static const gid_t worker_gid = 61840;
static const int dir_flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
static const char marker[] = "private-worker\n";

static bool
no_processes(int selector)
{
    pid_t pids[2];
    errno = 0;
    return proc_listpids(selector, worker_uid, pids, sizeof(pids)) == 0 && errno == 0;
}

static bool
uid_unused(void)
{
    errno = 0;
    if (getpwuid(worker_uid) || errno != 0) return false;
    errno = 0;
    if (getgrgid(worker_gid) || errno != 0) return false;
    return no_processes(PROC_RUID_ONLY) && no_processes(PROC_UID_ONLY);
}

static bool
seed_file(int dir, const char *name, const char *data, size_t size)
{
    int fd = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    bool ok = write(fd, data, size) == (ssize_t)size && fchown(fd, worker_uid, worker_gid) == 0;
    return close(fd) == 0 && ok;
}

static int
create_worker_dir(int outer, const char *name)
{
    if (mkdirat(outer, name, 0700) < 0) return -1;
    int fd = openat(outer, name, dir_flags);
    if (fd < 0) return -1;
    if (fchown(fd, worker_uid, worker_gid) == 0) return fd;
    close(fd);
    return -1;
}

static void
run_worker(int outer, int project, int sibling, char *project_path, char *sibling_path)
{
    alarm(15);
    close(outer);
    close(sibling);
    int entered = darwin_enter_worker_workspace(worker_uid, worker_gid, project);
    if (entered != 0) {
        fprintf(stderr, "workspace handoff failed: %s\n", strerror(entered));
        _exit(2);
    }
    // Drop every inherited descriptor except the fixture's standard streams.
    for (int fd = 3, limit = getdtablesize(); fd < limit; fd++) (void)close(fd);
    struct proc_fdinfo fds[4];
    int count = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fds, sizeof(fds));
    if (count != (int)(3 * sizeof(fds[0]))) _exit(2);
    for (int i = 0; i < 3; i++) {
        if (fds[i].proc_fd < 0 || fds[i].proc_fd > 2) _exit(2);
    }
    static char policy[] =
        "(version 1)(allow default)(deny network*)"
        "(deny file-write* (require-not (require-any (literal \"/dev/null\") (subpath (param \"PROJECT\")))))"
        "(deny file-read* (subpath (param \"SIBLING\")))";
    static char script[] =
        "set -euo pipefail\n"
        "test \"$UID\" = 61840\n"
        "test \"$EUID\" = 61840\n"
        "test \"$(/bin/pwd -P)\" = \"$1\"\n"
        "test -s process-identity.h\n"
        "trap '/bin/rm -rf -- .git' EXIT\n"
        "\"$3\" init --quiet --template=\n"
        "\"$3\" add -- process-identity.h\n"
        "test \"$(\"$3\" diff --cached --name-only -- process-identity.h)\" = process-identity.h\n"
        "if { read -r guard < \"$2/guard\"; } 2>/dev/null; then exit 3; fi\n"
        "if { printf 'escape\\n' > \"$2/escape\"; } 2>/dev/null; then exit 4; fi\n"
        "printf 'private-worker\\n' > proof.tmp\n"
        "/bin/mv -- proof.tmp proof.txt\n";
    char project_param[256], sibling_param[256], home[256];
    if (snprintf(project_param, sizeof(project_param), "PROJECT=%s", project_path) >= (int)sizeof(project_param) ||
        snprintf(sibling_param, sizeof(sibling_param), "SIBLING=%s", sibling_path) >= (int)sizeof(sibling_param) ||
        snprintf(home, sizeof(home), "HOME=%s", project_path) >= (int)sizeof(home)) _exit(2);
    char *const args[] = {
        "/usr/bin/sandbox-exec", "-D", project_param, "-D", sibling_param, "-p", policy,
        "/bin/bash", "--noprofile", "--norc", "-c", script, "workspace-proof", project_path, sibling_path,
        PROJECT_GIT, NULL,
    };
    char *const env[] = {
        "PATH=/usr/bin:/bin", "LANG=C", home, "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", NULL,
    };
    execve(args[0], args, env);
    perror("start sandbox");
    _exit(2);
}

static bool
readback(int project)
{
    char data[sizeof(marker)];
    int fd = openat(project, "proof.txt", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return false;
    struct stat info;
    bool ok = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
        info.st_uid == worker_uid && info.st_gid == worker_gid && info.st_nlink == 1 &&
        read(fd, data, sizeof(data)) == sizeof(marker) - 1 && memcmp(data, marker, sizeof(marker) - 1) == 0;
    close(fd);
    return ok;
}

static bool
remove_known(int dir, const char *name, int flags)
{
    return unlinkat(dir, name, flags) == 0 || errno == ENOENT;
}

static pid_t
wait_until(pid_t child, int *status, int seconds)
{
    struct timespec deadline, now;
    if (clock_gettime(CLOCK_MONOTONIC, &deadline) < 0) return -1;
    deadline.tv_sec += seconds;
    for (;;) {
        pid_t observed = waitpid(child, status, WNOHANG);
        if (observed > 0 || (observed < 0 && errno != EINTR)) return observed;
        if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return -1;
        if (now.tv_sec > deadline.tv_sec ||
            (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) return 0;
        const struct timespec interval = { .tv_nsec = 20000000 };
        (void)nanosleep(&interval, NULL);
    }
}

static int
test_workspace(void)
{
    char root[] = "/private/tmp/hl-private-worker.XXXXXX";
    if (!mkdtemp(root)) { perror("create proof directory"); return 2; }
    int outer = open(root, dir_flags);
    if (outer < 0) {
        perror("open proof directory");
        if (rmdir(root) < 0) fprintf(stderr, "Disposable workspace retained at %s\n", root);
        return 2;
    }
    int project = create_worker_dir(outer, "project");
    int sibling = create_worker_dir(outer, "sibling");
    bool reaped = false, project_write = false, no_escape = false, success = false;
    pid_t child = -1;
    if (project < 0 || sibling < 0 || fchmod(outer, 0711) < 0 ||
        !seed_file(project, "process-identity.h", project_fixture, sizeof(project_fixture) - 1) ||
        !seed_file(sibling, "guard", "outside\n", 8)) {
        perror("prepare disposable workspace");
        goto cleanup;
    }
    char project_path[sizeof(root) + sizeof("/project")], sibling_path[sizeof(root) + sizeof("/sibling")];
    snprintf(project_path, sizeof(project_path), "%s/project", root);
    snprintf(sibling_path, sizeof(sibling_path), "%s/sibling", root);
    child = fork();
    if (child < 0) { perror("fork worker"); goto cleanup; }
    if (child == 0) run_worker(outer, project, sibling, project_path, sibling_path);
    int status;
    pid_t waited = wait_until(child, &status, 18);
    if (waited == 0) {
        fputs("Workspace worker exceeded the fixture deadline\n", stderr);
        // This is the fixture's own unreaped child. Default SIGCHLD and
        // exclusive wait ownership keep its PID from being reused here.
        (void)kill(child, SIGKILL);
        waited = wait_until(child, &status, 2);
    }
    reaped = waited == child;
    success = reaped && WIFEXITED(status) && WEXITSTATUS(status) == 0;
    if (reaped && !success) fprintf(stderr, "workspace worker wait status %d\n", status);
    if (reaped) {
        project_write = readback(project);
        struct stat escape;
        no_escape = fstatat(sibling, "escape", &escape, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT;
    }

cleanup:;
    bool released = uid_unused();
    bool cleaned = false;
    if (released && (child < 0 || reaped)) {
        // Only unlink fixed entries through the pinned descriptors. If a failed
        // worker leaves extra content, keep the disposable directory for review.
        if (project >= 0) {
            (void)remove_known(project, "proof.tmp", 0);
            (void)remove_known(project, "proof.txt", 0);
            (void)remove_known(project, "process-identity.h", 0);
        }
        if (sibling >= 0) {
            (void)remove_known(sibling, "guard", 0);
            (void)remove_known(sibling, "escape", 0);
        }
        cleaned = remove_known(outer, "project", AT_REMOVEDIR) &&
            remove_known(outer, "sibling", AT_REMOVEDIR) && rmdir(root) == 0;
    }
    if (project >= 0) close(project);
    if (sibling >= 0) close(sibling);
    close(outer);
    if (!cleaned) fprintf(stderr, "Disposable workspace retained at %s\n", root);
    printf("{\"uid\":%u,\"workspaceAndGit\":%s,\"writeReadback\":%s,\"outsideWriteAbsent\":%s,"
        "\"reaped\":%s,\"released\":%s,\"cleaned\":%s}\n", worker_uid,
        success ? "true" : "false", project_write ? "true" : "false", no_escape ? "true" : "false",
        reaped ? "true" : "false", released ? "true" : "false", cleaned ? "true" : "false");
    return success && project_write && no_escape && reaped && released && cleaned ? 0 : 2;
}

int
main(int argc, char **argv)
{
    if (argc != 2 || (strcmp(argv[1], "--preflight") && strcmp(argv[1], "--test"))) return 64;
    bool preflight = strcmp(argv[1], "--preflight") == 0;
    if (!preflight && (getuid() != 0 || geteuid() != 0)) return 77;
    if (!preflight) {
        sigset_t unblocked;
        sigemptyset(&unblocked);
        sigaddset(&unblocked, SIGALRM);
        if (signal(SIGCHLD, SIG_DFL) == SIG_ERR || signal(SIGALRM, SIG_DFL) == SIG_ERR ||
            sigprocmask(SIG_UNBLOCK, &unblocked, NULL) < 0) return 2;
    }
    umask(077);
    if (!uid_unused()) { fputs("Temporary UID or GID is already in use\n", stderr); return 2; }
    if (preflight) {
        printf("{\"uid\":%u,\"clear\":true}\n", worker_uid);
        return 0;
    }
    return test_workspace();
}
