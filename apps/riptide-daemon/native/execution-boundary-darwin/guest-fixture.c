#define _DARWIN_C_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/disk.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

enum {
    BLOCK_BYTES = 4096,
    NONCE_BYTES = 32,
    HEARTBEAT_OFFSET = 4096,
    PENDING_OFFSET = 8192,
    HEARTBEAT_INTERVAL_MS = 100,
    ORPHAN_WAIT_INTERVALS = 20,
    READY_TIMEOUT_MS = 10000,
    WRITER_SECONDS = 60,
    WRITER_MAX_HEARTBEATS = 600,
    PARENT_SECONDS = 90,
};

#define PROBE_CAPACITY_BYTES (UINT64_C(64) * 1024 * 1024)

struct io_block {
    _Alignas(BLOCK_BYTES) char bytes[BLOCK_BYTES];
};

_Static_assert(sizeof(struct io_block) == BLOCK_BYTES, "unexpected I/O block size");
_Static_assert(_Alignof(struct io_block) == BLOCK_BYTES, "unexpected I/O block alignment");

static bool is_digit(char value)
{
    return value >= '0' && value <= '9';
}

static bool is_virtual_mac(void)
{
    static const char prefix[] = "VirtualMac";
    char model[128];
    size_t size = sizeof(model);
    if (sysctlbyname("hw.model", model, &size, NULL, 0) < 0 ||
        size == 0 || size > sizeof(model) || model[size - 1] != '\0' ||
        strncmp(model, prefix, sizeof(prefix) - 1) != 0) {
        return false;
    }

    const char *major = model + sizeof(prefix) - 1;
    const char *end = major;
    while (is_digit(*end)) {
        ++end;
    }
    if (end == major || *end != ',') {
        return false;
    }
    const char *minor = ++end;
    while (is_digit(*end)) {
        ++end;
    }
    return end != minor && *end == '\0';
}

static bool is_whole_raw_disk_path(const char *path)
{
    static const char prefix[] = "/dev/rdisk";
    if (strncmp(path, prefix, sizeof(prefix) - 1) != 0) {
        return false;
    }
    const char *number = path + sizeof(prefix) - 1;
    if (!is_digit(*number) || (*number == '0' && number[1] != '\0')) {
        return false;
    }
    do {
        ++number;
    } while (is_digit(*number));
    return *number == '\0';
}

static bool is_nonce(const char *nonce)
{
    if (strlen(nonce) != NONCE_BYTES) {
        return false;
    }
    for (size_t index = 0; index < NONCE_BYTES; ++index) {
        char value = nonce[index];
        if (!is_digit(value) && (value < 'a' || value > 'f')) {
            return false;
        }
    }
    return true;
}

static bool validate_probe_disk(int fd, const char *nonce)
{
    struct stat metadata;
    if (fstat(fd, &metadata) < 0) {
        perror("fstat probe disk");
        return false;
    }
    if (!S_ISCHR(metadata.st_mode)) {
        fputs("Probe path must name a character device.\n", stderr);
        return false;
    }

    uint32_t sector_size = 0;
    uint64_t sector_count = 0;
    if (ioctl(fd, DKIOCGETBLOCKSIZE, &sector_size) < 0 ||
        ioctl(fd, DKIOCGETBLOCKCOUNT, &sector_count) < 0) {
        perror("read probe disk geometry");
        return false;
    }
    if ((sector_size != 512 && sector_size != BLOCK_BYTES) ||
        sector_count != PROBE_CAPACITY_BYTES / sector_size) {
        fputs("Probe disk must have 64 MiB capacity and 512 or 4096 byte sectors.\n", stderr);
        return false;
    }

    struct io_block block;
    const ssize_t read_bytes = pread(fd, block.bytes, sizeof(block.bytes), 0);
    if (read_bytes < 0) {
        perror("read probe marker");
        return false;
    }
    static const char prefix[] = "HL40B8_NATIVE_PROBE:";
    const size_t prefix_size = sizeof(prefix) - 1;
    if (read_bytes != (ssize_t)sizeof(block.bytes) ||
        memcmp(block.bytes, prefix, prefix_size) != 0 ||
        memcmp(block.bytes + prefix_size, nonce, NONCE_BYTES) != 0) {
        fputs("Probe disk marker mismatch.\n", stderr);
        return false;
    }
    return true;
}

static bool prepare_signals(void)
{
    struct sigaction defaults = { .sa_handler = SIG_DFL };
    sigset_t unblock;
    return sigemptyset(&defaults.sa_mask) == 0 &&
           sigaction(SIGALRM, &defaults, NULL) == 0 &&
           sigaction(SIGCHLD, &defaults, NULL) == 0 &&
           sigemptyset(&unblock) == 0 &&
           sigaddset(&unblock, SIGALRM) == 0 &&
           sigprocmask(SIG_UNBLOCK, &unblock, NULL) == 0;
}

static bool parent_still_waiting(int keepalive_fd, int timeout_ms)
{
    struct pollfd keepalive = { .fd = keepalive_fd, .events = POLLIN };
    return poll(&keepalive, 1, timeout_ms) == 0;
}

static int write_heartbeats(int disk_fd, const char *nonce, int ack_fd, int keepalive_fd)
{
    alarm(WRITER_SECONDS);
    for (unsigned attempt = 0; getppid() != 1; ++attempt) {
        if (attempt == ORPHAN_WAIT_INTERVALS ||
            !parent_still_waiting(keepalive_fd, HEARTBEAT_INTERVAL_MS)) {
            return EXIT_FAILURE;
        }
    }

    struct io_block block;
    for (unsigned counter = 1; counter <= WRITER_MAX_HEARTBEATS; ++counter) {
        if (!parent_still_waiting(keepalive_fd, 0)) {
            return EXIT_SUCCESS;
        }
        const pid_t parent_pid = getppid();
        if (parent_pid != 1) {
            return EXIT_FAILURE;
        }
        memset(block.bytes, 0, sizeof(block.bytes));
        const int length = snprintf(block.bytes, sizeof(block.bytes),
                                    "HL40B8:HEARTBEAT:%s:%u:%jd:%jd\n", nonce, counter,
                                    (intmax_t)getpid(), (intmax_t)parent_pid);
        if (length < 0 || (size_t)length >= sizeof(block.bytes)) {
            return EXIT_FAILURE;
        }
        if (pwrite(disk_fd, block.bytes, sizeof(block.bytes), HEARTBEAT_OFFSET) !=
            (ssize_t)sizeof(block.bytes)) {
            return EXIT_FAILURE;
        }
        if (counter == 1) {
            const char ready = 'R';
            if (write(ack_fd, &ready, sizeof(ready)) != (ssize_t)sizeof(ready)) {
                return EXIT_FAILURE;
            }
            close(ack_fd);
        }
        if (!parent_still_waiting(keepalive_fd, HEARTBEAT_INTERVAL_MS)) {
            return EXIT_SUCCESS;
        }
    }
    return EXIT_SUCCESS;
}

static _Noreturn void launch_writer(int disk_fd, const char *nonce, int ack_fd, int keepalive_fd)
{
    alarm(5);
    if (setsid() < 0) {
        _exit(EXIT_FAILURE);
    }
    const pid_t writer = fork();
    if (writer < 0) {
        _exit(EXIT_FAILURE);
    }
    if (writer > 0) {
        _exit(EXIT_SUCCESS);
    }

    for (int fd = STDIN_FILENO; fd <= STDERR_FILENO; ++fd) {
        if (fd != disk_fd && fd != ack_fd && fd != keepalive_fd) {
            close(fd);
        }
    }
    _exit(write_heartbeats(disk_fd, nonce, ack_fd, keepalive_fd));
}

static bool wait_for_first_heartbeat(int fd)
{
    struct pollfd acknowledgement = { .fd = fd, .events = POLLIN };
    char received = '\0';
    return poll(&acknowledgement, 1, READY_TIMEOUT_MS) == 1 &&
           (acknowledgement.revents & POLLIN) != 0 &&
           read(fd, &received, sizeof(received)) == (ssize_t)sizeof(received) &&
           received == 'R';
}

static int run_workload(int disk_fd, const char *nonce)
{
    int ack[2];
    if (pipe(ack) < 0) {
        perror("open heartbeat acknowledgement pipe");
        return EXIT_FAILURE;
    }
    int keepalive[2];
    if (pipe(keepalive) < 0) {
        perror("open parent keepalive pipe");
        close(ack[0]);
        close(ack[1]);
        return EXIT_FAILURE;
    }

    const pid_t launcher = fork();
    if (launcher < 0) {
        perror("fork probe launcher");
        close(ack[0]);
        close(ack[1]);
        close(keepalive[0]);
        close(keepalive[1]);
        return EXIT_FAILURE;
    }
    if (launcher == 0) {
        close(ack[0]);
        close(keepalive[1]);
        launch_writer(disk_fd, nonce, ack[1], keepalive[0]);
    }

    close(ack[1]);
    close(keepalive[0]);
    const bool acknowledged = wait_for_first_heartbeat(ack[0]);
    close(ack[0]);
    int launcher_status = 0;
    const pid_t reaped = waitpid(launcher, &launcher_status, acknowledged ? 0 : WNOHANG);
    if (!acknowledged || reaped != launcher || !WIFEXITED(launcher_status) ||
        WEXITSTATUS(launcher_status) != EXIT_SUCCESS) {
        close(keepalive[1]);
        fputs("The orphaned writer did not acknowledge its first heartbeat.\n", stderr);
        return EXIT_FAILURE;
    }

    struct io_block block = { 0 };
    const int length = snprintf(block.bytes, sizeof(block.bytes), "HL40B8:PENDING:%s\n", nonce);
    if (length < 0 || (size_t)length >= sizeof(block.bytes)) {
        close(keepalive[1]);
        return EXIT_FAILURE;
    }

    /* The export holds this request while the guest writer remains alive. */
    const ssize_t written = pwrite(disk_fd, block.bytes, sizeof(block.bytes), PENDING_OFFSET);
    const int write_error = errno;
    close(keepalive[1]);
    if (written < 0) {
        errno = write_error;
        perror("pending probe write returned");
    } else {
        fprintf(stderr, "Pending probe write returned early with %zd bytes.\n", written);
    }
    return EXIT_FAILURE;
}

int main(int argc, char *argv[])
{
    if (argc != 3 || !is_whole_raw_disk_path(argv[1]) || !is_nonce(argv[2])) {
        fputs("Usage: guest-fixture /dev/rdiskN <32 lowercase hexadecimal digits>\n", stderr);
        return EXIT_FAILURE;
    }
    if (!is_virtual_mac()) {
        fputs("The probe requires a VirtualMac guest.\n", stderr);
        return EXIT_FAILURE;
    }
    if (!prepare_signals()) {
        perror("prepare probe alarms");
        return EXIT_FAILURE;
    }
    alarm(PARENT_SECONDS);

    const int disk_fd = open(argv[1], O_RDWR | O_CLOEXEC | O_NOFOLLOW_ANY);
    if (disk_fd < 0) {
        perror("open probe disk");
        return EXIT_FAILURE;
    }
    int result = EXIT_FAILURE;
    if (validate_probe_disk(disk_fd, argv[2])) {
        result = run_workload(disk_fd, argv[2]);
    }
    close(disk_fd);
    return result;
}
