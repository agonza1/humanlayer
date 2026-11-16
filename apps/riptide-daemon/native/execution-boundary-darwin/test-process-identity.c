#include "process-identity.h"

#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static bool
read_byte(int fd, char expected)
{
    struct pollfd ready = { .fd = fd, .events = POLLIN };
    char actual;
    return poll(&ready, 1, 4000) == 1 && read(fd, &actual, 1) == 1 && actual == expected;
}

static pid_t
reap_child(pid_t child, int *status)
{
    struct timespec deadline, now;
    if (clock_gettime(CLOCK_MONOTONIC, &deadline) != 0) {
        return -1;
    }
    deadline.tv_sec++;
    for (;;) {
        pid_t waited = waitpid(child, status, WNOHANG);
        if (waited > 0 || (waited < 0 && errno != EINTR)) {
            return waited;
        }
        if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
            return -1;
        }
        if (now.tv_sec > deadline.tv_sec ||
            (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) {
            return 0;
        }
        const struct timespec interval = { .tv_nsec = 10000000 };
        (void)nanosleep(&interval, NULL);
    }
}

static void
start_child(const char *executable, const int events[2], const int control[2])
{
    close(events[0]);
    close(control[1]);
    if (dup2(events[1], STDOUT_FILENO) < 0 || dup2(control[0], STDIN_FILENO) < 0) {
        _exit(1);
    }
    close(events[1]);
    close(control[0]);
    if (setsid() < 0 || write(STDOUT_FILENO, "b", 1) != 1 || !read_byte(STDIN_FILENO, 'e')) {
        _exit(1);
    }
    execl(executable, executable, "--fixture-after-exec", NULL);
    _exit(1);
}

int
main(int argc, char **argv)
{
    if (getuid() == 0 || getuid() != geteuid()) {
        return 64;
    }
    if (argc == 2 && strcmp(argv[1], "--fixture-after-exec") == 0) {
        // An early failure closes the control pipe so the child can exit.
        return write(STDOUT_FILENO, "e", 1) == 1 && read_byte(STDIN_FILENO, 'q') ? 0 : 1;
    }
    if (argc != 1 || fcntl(STDIN_FILENO, F_GETFD) < 0 || fcntl(STDOUT_FILENO, F_GETFD) < 0) {
        return 64;
    }

    sigset_t signals;
    sigemptyset(&signals);
    sigaddset(&signals, SIGTERM);
    if (signal(SIGPIPE, SIG_IGN) == SIG_ERR || signal(SIGTERM, SIG_DFL) == SIG_ERR ||
        signal(SIGCHLD, SIG_DFL) == SIG_ERR ||
        sigprocmask(SIG_UNBLOCK, &signals, NULL) != 0) {
        return 1;
    }
    int events[2], control[2];
    if (pipe(events) != 0 || pipe(control) != 0) {
        return 1;
    }
    pid_t child = fork();
    if (child < 0) {
        return 1;
    }
    if (child == 0) {
        start_child(argv[0], events, control);
    }
    close(events[1]);
    close(control[0]);

    audit_token_t before, after, ignored;
    kern_return_t before_result = KERN_FAILURE, after_result = KERN_FAILURE;
    kern_return_t foreign_result = KERN_FAILURE;
    int stale = -1, fresh = -1;
    bool detached = false, version_changed = false;
    if (read_byte(events[0], 'b')) {
        detached = getsid(child) == child;
        before_result = darwin_capture_process_identity(child, getuid(), &before);
        uid_t other_uid = getuid() == 1 ? 2 : 1;
        foreign_result = darwin_capture_process_identity(child, other_uid, &ignored);
        if (write(control[1], "e", 1) == 1 && read_byte(events[0], 'e')) {
            after_result = darwin_capture_process_identity(child, getuid(), &after);
        }
    }
    if (detached && before_result == KERN_SUCCESS && after_result == KERN_SUCCESS) {
        version_changed = audit_token_to_pidversion(before) != audit_token_to_pidversion(after);
        stale = darwin_signal_process_identity(before, SIGTERM);
        if (stale == ESRCH) {
            fresh = darwin_signal_process_identity(after, SIGTERM);
        }
    }

    // Allow time for signal delivery while the child is waiting on the
    // control pipe. On any failure, close the pipe and reap without a PID kill.
    if (fresh == 0) {
        struct pollfd exit_event = { .fd = events[0], .events = POLLIN };
        (void)poll(&exit_event, 1, 1000);
    }
    close(control[1]);
    close(events[0]);
    int status = 0;
    pid_t waited = reap_child(child, &status);
    bool escalated = waited == 0;
    if (escalated) {
        audit_token_t current;
        if (darwin_capture_process_identity(child, getuid(), &current) == KERN_SUCCESS) {
            (void)darwin_signal_process_identity(current, SIGKILL);
        }
        waited = reap_child(child, &status);
    }
    int exit_signal = waited == child && WIFSIGNALED(status) ? WTERMSIG(status) : 0;
    printf("{\"detached\":%s,\"beforeToken\":%d,\"afterToken\":%d,\"foreignUid\":%d,"
        "\"versionChanged\":%s,\"staleSignal\":%d,\"freshSignal\":%d,"
        "\"escalated\":%s,\"reaped\":%s,\"exitSignal\":%d}\n",
        detached ? "true" : "false", before_result, after_result, foreign_result,
        version_changed ? "true" : "false", stale, fresh,
        escalated ? "true" : "false", waited == child ? "true" : "false", exit_signal);
    return !escalated && version_changed && foreign_result == KERN_PROTECTION_FAILURE && stale == ESRCH &&
        fresh == 0 && exit_signal == SIGTERM ? 0 : 1;
}
