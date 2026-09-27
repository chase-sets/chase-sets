#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/securebits.h>
#include <net/if.h>
#include <openssl/sha.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>
#include "installation.h"

#define INSTALL "/usr/local/lib/chase-sets-provider-window"
#define LAUNCHER INSTALL "/launcher"
#define LABEL "chase-sets-provider-window (unconfined)"

static pid_t owned_child;
static volatile sig_atomic_t stopped;
static void supervise(pid_t child, bool init);

static void refuse(const char *stage) {
    /* Stages are source literals. Never echo errno strings, paths or argv. */
    dprintf(STDERR_FILENO, "provider-boundary-refused:%s\n", stage);
    _exit(78);
}

static void require(bool predicate, const char *stage) {
    if (!predicate) refuse(stage);
}

static void text_file(const char *path, char *buffer, size_t capacity) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    require(fd >= 0, "read");
    ssize_t length = read(fd, buffer, capacity - 1);
    require(length >= 0 && (size_t)length < capacity - 1, "read-bound");
    buffer[length] = 0;
    close(fd);
    buffer[strcspn(buffer, "\r\n")] = 0;
}

static void write_file(const char *path, const char *value) {
    int fd = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    require(fd >= 0, "mapping-open");
    size_t length = strlen(value);
    require(write(fd, value, length) == (ssize_t)length, "mapping-write");
    close(fd);
}

static void immutable(const char *path, bool regular) {
    struct stat st;
    require(lstat(path, &st) == 0 && st.st_uid == 0 && !(st.st_mode & 0022) &&
            !(st.st_mode & (S_ISUID | S_ISGID)) &&
            (regular ? S_ISREG(st.st_mode) : S_ISDIR(st.st_mode)), "ownership");
    require(lgetxattr(path, "security.capability", NULL, 0) == -1 && errno == ENODATA, "file-capability");
}

static void immutable_path(const char *path) {
    char parent[4096];
    require(strlen(path) < sizeof(parent), "path-bound");
    strcpy(parent, path);
    for (char *p = parent + 1; *p; p++) {
        if (*p != '/') continue;
        *p = 0;
        immutable(parent, false);
        *p = '/';
    }
    immutable(path, true);
}

static void digest(const char *path, char output[65]) {
    immutable_path(path);
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    require(fd >= 0, "identity-open");
    SHA256_CTX context;
    unsigned char bytes[32768], result[SHA256_DIGEST_LENGTH];
    require(SHA256_Init(&context) == 1, "identity-hash");
    ssize_t length;
    while ((length = read(fd, bytes, sizeof(bytes))) > 0)
        require(SHA256_Update(&context, bytes, (size_t)length) == 1, "identity-hash");
    require(length == 0 && SHA256_Final(result, &context) == 1, "identity-hash");
    close(fd);
    for (size_t i = 0; i < sizeof(result); i++) sprintf(output + i * 2, "%02x", result[i]);
    output[64] = 0;
}

static void installation(void) {
    char label[256], executable[4096], actual[65], expected[128];
    text_file("/proc/self/attr/current", label, sizeof(label));
    require(strcmp(label, LABEL) == 0, "attachment");
    ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    require(length > 0 && length < (ssize_t)sizeof(executable) - 1, "executable");
    executable[length] = 0;
    require(strcmp(executable, LAUNCHER) == 0, "executable");
    immutable_path(INSTALL "/launcher.sha256");
    text_file(INSTALL "/launcher.sha256", expected, sizeof(expected));
    digest(LAUNCHER, actual);
    require(strcmp(actual, expected) == 0, "launcher-identity");
    digest(INSTALL "/files.sha256", actual);
    require(strcmp(actual, FILES_DIGEST) == 0, "inventory-identity");
    FILE *files = fopen(INSTALL "/files.sha256", "re");
    require(files != NULL, "inventory");
    char line[8192];
    unsigned count = 0;
    while (fgets(line, sizeof(line), files)) {
        require(++count <= 4096 && strlen(line) > 68 && line[64] == ' ' && line[65] == ' ', "inventory-shape");
        line[strcspn(line, "\r\n")] = 0;
        require(strncmp(line + 66, INSTALL "/", strlen(INSTALL) + 1) == 0 &&
                strstr(line + 66, "/../") == NULL && strstr(line + 66, "/./") == NULL, "inventory-path");
        digest(line + 66, actual);
        line[64] = 0;
        require(strcmp(line, actual) == 0, "dependency-identity");
    }
    require(!ferror(files) && count > 0, "inventory-complete");
    fclose(files);
}

static void map_user(void) {
    char mapping[80];
    snprintf(mapping, sizeof(mapping), "%u %u 1\n", ADMITTED_UID, ADMITTED_UID);
    write_file("/proc/self/uid_map", mapping);
    write_file("/proc/self/setgroups", "deny\n");
    snprintf(mapping, sizeof(mapping), "%u %u 1\n", ADMITTED_GID, ADMITTED_GID);
    write_file("/proc/self/gid_map", mapping);
}

static void drop_authority(void) {
    require(prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED) == 0, "securebits");
    for (int cap = 0; cap <= CAP_LAST_CAP; cap++)
        require(prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) == 0, "bounding-capabilities");
    struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct data[2] = {{0}, {0}};
    require(syscall(SYS_capset, &header, &data) == 0, "capabilities");
    require(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0, "no-new-privileges");
    require(getuid() == ADMITTED_UID && geteuid() == ADMITTED_UID && getuid() != 0, "nonroot");
}

static void no_network(void) {
    struct if_nameindex *interfaces = if_nameindex();
    require(interfaces != NULL, "interfaces");
    unsigned count = 0;
    for (struct if_nameindex *i = interfaces; i->if_index; i++) {
        require(strcmp(i->if_name, "lo") == 0, "external-interface");
        count++;
    }
    if_freenameindex(interfaces);
    require(count == 1, "interfaces");
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    struct ifreq request = {0};
    strcpy(request.ifr_name, "lo");
    require(fd >= 0 && ioctl(fd, SIOCGIFFLAGS, &request) == 0 && !(request.ifr_flags & IFF_UP), "loopback");
    close(fd);
}

static void isolated_root(void) {
    require(mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) == 0, "private-mounts");
    require(mount("tmpfs", INSTALL "/root/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777,size=268435456") == 0, "private-tmp");
    require(mount("tmpfs", INSTALL "/root/dev/shm", "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=1777,size=67108864") == 0, "private-shm");
    require(mount("proc", INSTALL "/root/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) == 0, "private-proc");
    require(chdir(INSTALL "/root") == 0 && chroot(".") == 0 && chdir("/") == 0, "private-root");
    require(mkdir("/tmp/profile", 0700) == 0, "private-profile");
    no_network();
}

static void stop_owned(int signal_number) {
    stopped = signal_number;
    if (owned_child > 0) kill(owned_child, SIGKILL);
}

static void bind_parent(pid_t parent) {
    require(prctl(PR_SET_PDEATHSIG, SIGKILL) == 0 && getppid() == parent, "parent-lifetime");
}

static void automation_endpoint(int fd, pid_t parent) {
    /* Node's stdio:pipe is an unnamed AF_UNIX socketpair on Linux. It is
     * converted to a real pipe below, never inherited by Chromium. */
    struct sockaddr_un address;
    socklen_t length = sizeof(address);
    require(getsockname(fd, (struct sockaddr *)&address, &length) == 0 &&
            address.sun_family == AF_UNIX && length == sizeof(sa_family_t), "automation-pipes");
    length = sizeof(address);
    require(getpeername(fd, (struct sockaddr *)&address, &length) == 0 &&
            address.sun_family == AF_UNIX && length == sizeof(sa_family_t), "automation-pipes");
    struct ucred peer;
    length = sizeof(peer);
    require(getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) == 0 &&
            peer.uid == ADMITTED_UID && peer.pid == parent, "automation-peer");
}

static void relay(pid_t child, int input, int output) {
    struct channel { int from, to; unsigned char bytes[65536]; size_t start, end; };
    struct channel channels[2] = {{.from = 3, .to = input}, {.from = output, .to = 4}};
    owned_child = child;
    signal(SIGTERM, stop_owned);
    signal(SIGINT, stop_owned);
    signal(SIGHUP, stop_owned);
    signal(SIGPIPE, SIG_IGN);
    for (int i = 0; i < 2; i++) {
        require(fcntl(channels[i].from, F_SETFL, O_NONBLOCK) == 0 &&
                fcntl(channels[i].to, F_SETFL, O_NONBLOCK) == 0, "automation-nonblocking");
    }
    while (!stopped) {
        struct pollfd events[4];
        for (int i = 0; i < 2; i++) {
            struct channel *c = &channels[i];
            events[i * 2] = (struct pollfd){c->from, c->end == c->start ? POLLIN : 0, 0};
            events[i * 2 + 1] = (struct pollfd){c->to, c->end > c->start ? POLLOUT : 0, 0};
        }
        int ready = poll(events, 4, -1);
        if (ready < 0 && errno == EINTR) continue;
        require(ready >= 0, "automation-poll");
        for (int i = 0; i < 2 && !stopped; i++) {
            struct channel *c = &channels[i];
            if (events[i * 2].revents & POLLIN) {
                ssize_t count = read(c->from, c->bytes, sizeof(c->bytes));
                if (count == 0) stop_owned(SIGTERM);
                else if (count > 0) { c->start = 0; c->end = (size_t)count; }
                else if (errno != EAGAIN && errno != EINTR) stop_owned(SIGTERM);
            }
            if (events[i * 2 + 1].revents & POLLOUT) {
                ssize_t count = write(c->to, c->bytes + c->start, c->end - c->start);
                if (count > 0) c->start += (size_t)count;
                else if (count < 0 && errno != EAGAIN && errno != EINTR) stop_owned(SIGTERM);
            }
            if ((events[i * 2].revents | events[i * 2 + 1].revents) & (POLLERR | POLLHUP | POLLNVAL))
                stop_owned(SIGTERM);
        }
    }
    close(3); close(4); close(input); close(output);
    supervise(child, false);
}

static void supervise(pid_t child, bool init) {
    owned_child = child;
    signal(SIGTERM, stop_owned);
    signal(SIGINT, stop_owned);
    signal(SIGHUP, stop_owned);
    int status = 0;
    pid_t reaped;
    do { reaped = waitpid(child, &status, 0); } while (reaped < 0 && errno == EINTR);
    require(reaped == child, "owned-wait");
    if (init) {
        /* PID 1 sees only this launch. Killing it is also the kernel's final
         * descendant drain on force termination, including double-forks. */
        kill(-1, SIGKILL);
        do { reaped = waitpid(-1, NULL, 0); } while (reaped > 0 || (reaped < 0 && errno == EINTR));
        require(errno == ECHILD, "owned-drain");
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) refuse("browser-exit");
    }
    _exit(stopped ? 128 + stopped : WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
}

int main(int argc, char **argv) {
    clearenv();
    require(prctl(PR_SET_DUMPABLE, 0) == 0, "process-authority");
    umask(0077);
    struct rlimit core = {0, 0};
    require(setrlimit(RLIMIT_CORE, &core) == 0, "core-files");
    require(argc == 3 && (strcmp(argv[1], "probe") == 0 || strcmp(argv[1], "browser") == 0), "arguments");
    require(strcmp(argv[2], SOURCE_DIGEST) == 0, "source-identity");
    bool probe = strcmp(argv[1], "probe") == 0;
    require(getuid() == ADMITTED_UID && geteuid() == ADMITTED_UID &&
            getgid() == ADMITTED_GID && getegid() == ADMITTED_GID && ADMITTED_UID != 0, "principal");
    installation();
    pid_t parent = getppid();
    bind_parent(parent);
    if (!probe) { automation_endpoint(3, parent); automation_endpoint(4, parent); }
    require(syscall(SYS_close_range, probe ? 3 : 5, ~0U, 0) == 0, "inherited-handles");
    int host_net = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
    require(host_net >= 0, "host-comparison");
    require(unshare(CLONE_NEWUSER) == 0, "user-namespace");
    map_user();
    require(unshare(CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS) == 0, "child-namespaces");
    require(setns(host_net, CLONE_NEWNET) == -1 && errno == EPERM, "host-rejoin");
    close(host_net);
    no_network();
    int input[2] = {-1, -1}, output[2] = {-1, -1};
    if (!probe) require(pipe2(input, O_CLOEXEC) == 0 && pipe2(output, O_CLOEXEC) == 0, "automation-pipe-create");
    int guardian = (int)syscall(SYS_pidfd_open, getpid(), 0);
    require(guardian >= 0, "guardian-lifetime");
    /* The namespace init's death drains every browser descendant, even when the
     * outer parent is force-killed and cannot run a JavaScript cleanup hook. */
    pid_t child = fork();
    require(child >= 0, "init-fork");
    if (child > 0) {
        close(guardian);
        if (!probe) { close(input[0]); close(output[1]); }
        drop_authority();
        if (!probe) relay(child, input[1], output[0]);
        supervise(child, false);
    }
    /* getppid() is 0 for a parent outside this PID namespace. */
    bind_parent(0);
    struct pollfd lifetime = {guardian, POLLIN, 0};
    require(poll(&lifetime, 1, 0) == 0, "guardian-lifetime");
    close(guardian);
    if (!probe) {
        close(3); close(4); close(input[1]); close(output[0]);
        require(dup2(input[0], 3) == 3 && dup2(output[1], 4) == 4, "automation-child-pipes");
        close(input[0]); close(output[1]);
    }
    isolated_root();
    drop_authority();
    if (probe) {
        child = fork();
        require(child >= 0, "nested-fork");
        if (child == 0) {
            require(unshare(CLONE_NEWUSER) == 0, "nested-user-namespace");
            map_user();
            require(unshare(CLONE_NEWNET) == 0, "nested-network-namespace");
            no_network();
            _exit(0);
        }
        int status = 0;
        require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0, "nested-sandbox");
        char label[256];
        text_file("/proc/self/attr/current", label, sizeof(label));
        require(strcmp(label, LABEL) == 0, "namespace-attachment");
        puts("{\"admitted\":true,\"nonroot\":true,\"network\":\"isolated\",\"hostRejoin\":\"denied\",\"capabilities\":\"dropped\",\"nestedSandbox\":true,\"handles\":\"closed\"}");
        return 0;
    }
    child = fork();
    require(child >= 0, "browser-fork");
    if (child > 0) { close(3); close(4); supervise(child, true); }
    bind_parent(1);
    int null = open("/dev/null", O_RDWR | O_CLOEXEC);
    require(null >= 0, "closed-stdio");
    for (int fd = 0; fd <= 2; fd++) require(dup2(null, fd) == fd, "closed-stdio");
    close(null);
    char *const arguments[] = {
        "/browser/chrome", "--headless", "--remote-debugging-pipe", "--user-data-dir=/tmp/profile",
        "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-sync",
        "--disable-quic", "--disable-extensions", "--disable-default-apps", NULL
    };
    char *const environment[] = {"PATH=/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "LANG=C", "LC_ALL=C", NULL};
    execve(arguments[0], arguments, environment);
    refuse("browser-exec");
}
