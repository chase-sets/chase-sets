#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/sched.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum { LEAVES = 256, SHARDS = 17 };
struct leaf { int fd; pid_t pid; unsigned long long start; };
struct shard { struct leaf leaves[LEAVES]; int count, error; };
struct receipt { int count, error; };

static long now_ms(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(1);
  return t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int readable(int fd, int milliseconds) {
  struct pollfd p = { .fd = fd, .events = POLLIN };
  int result;
  do { result = poll(&p, 1, milliseconds); } while (result < 0 && errno == EINTR);
  return result;
}
static int stop(int fd) {
  return syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0) == 0 || errno == ESRCH;
}
static int reap(int fd, long deadline) {
  int left = (int)(deadline - now_ms());
  if (readable(fd, left > 0 ? left : 0) != 1) return 0;
  siginfo_t info = {0};
  return waitid(P_PIDFD, fd, &info, WEXITED | WNOHANG) == 0 && info.si_pid > 0;
}
static pid_t owned_clone(int *fd, pid_t *pid, unsigned long flags) {
  struct clone_args args = {
    .flags = CLONE_PIDFD | CLONE_PARENT_SETTID | flags,
    .pidfd = (uintptr_t)fd, .parent_tid = (uintptr_t)pid, .exit_signal = SIGCHLD,
  };
  return syscall(SYS_clone3, &args, sizeof(args));
}
static unsigned long long birth(pid_t pid, pid_t parent) {
  char path[64], data[4096];
  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  FILE *f = fopen(path, "re");
  if (!f) return 0;
  size_t n = fread(data, 1, sizeof(data) - 1, f);
  int valid = feof(f) && !ferror(f);
  fclose(f);
  data[n] = 0;
  char *end = strrchr(data, ')');
  if (!valid || !end || atoi(data) != pid) return 0;
  char *save, *field = strtok_r(end + 2, " ", &save);
  for (int i = 3; field; i++, field = strtok_r(NULL, " ", &save)) {
    if (i == 4 && atoi(field) != parent) return 0;
    if (i == 22) return strtoull(field, NULL, 10);
  }
  return 0;
}
static int census(void) {
  DIR *dir = opendir("/proc");
  if (!dir) return -1;
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    if (entry->d_name[0] && strspn(entry->d_name, "0123456789") == strlen(entry->d_name)) count++;
  }
  closedir(dir);
  return count;
}

/* The shard and its guardian share only their FD table and this ownership
 * ledger. clone3 atomically publishes BOTH pidfd and PID into that ledger.
 * Killing the shard inside clone3 cannot close the guardian's leaf handles.
 * The coordinator never receives leaf FDs. No /proc-discovered PID is signalled. */
static void build(struct shard *s, int amount, int cancel, int ready, uid_t uid, gid_t gid, const char *mode) {
  for (int i = 0; i < amount; i++) {
    if (readable(cancel, 0) != 0) { s->error = ECANCELED; break; }
    if (!strcmp(mode, "construction-failure") && i == 4) { s->error = EMFILE; break; }
    struct leaf *leaf = &s->leaves[i];
    pid_t child = owned_clone(&leaf->fd, &leaf->pid, 0);
    if (child < 0) { s->error = errno; break; }
    if (!child) {
      syscall(SYS_close_range, 3, ~0U, 0);
      if (getuid() == 0 && (setgroups(0, NULL) || setresgid(gid, gid, gid) || setresuid(uid, uid, uid))) _exit(1);
      execl("/bin/sleep", "SYNTHETIC_CENSUS_LEAF", "30", (char *)NULL);
      _exit(1);
    }
    leaf->start = birth(child, getpid());
    s->count++;
    if (!leaf->start || readable(leaf->fd, 0)) { s->error = ECHILD; break; }
    if (!strcmp(mode, "shard-death") && i == 3) {
      if (write(ready, "R", 1) != 1) _exit(1);
      _exit(readable(cancel, 15000) == 1 ? 0 : 1);
    }
  }
  if (write(ready, "R", 1) != 1) _exit(1);
  if (s->error) _exit(1);
  _exit(readable(cancel, 15000) == 1 ? 0 : 1);
}

static void guardian(int amount, int cancel, int report, uid_t uid, gid_t gid, const char *mode) {
  if (prctl(PR_SET_CHILD_SUBREAPER, 1)) _exit(1);
  struct shard *s = mmap(NULL, sizeof(*s), PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (s == MAP_FAILED) _exit(1);
  for (int i = 0; i < LEAVES; i++) s->leaves[i].fd = -1;
  int event[2], workerfd = -1;
  pid_t workerpid = 0;
  if (pipe2(event, O_CLOEXEC)) _exit(1);
  pid_t worker = owned_clone(&workerfd, &workerpid, CLONE_FILES);
  if (worker < 0) _exit(1);
  if (!worker) build(s, amount, cancel, event[1], uid, gid, mode);
  struct pollfd waiters[] = {{event[0], POLLIN, 0}, {workerfd, POLLIN, 0}, {cancel, POLLIN, 0}};
  int result = poll(waiters, 3, 15000);
  struct receipt receipt = {s->count, s->error};
  if (result <= 0 || !waiters[0].revents) receipt.error = ECANCELED;
  if (!receipt.error && !strcmp(mode, "shard-death")) {
    if (!stop(workerfd)) receipt.error = ECHILD;
  }
  if (!receipt.error && strcmp(mode, "shard-death")) {
    if (write(report, &receipt, sizeof(receipt)) != sizeof(receipt)) receipt.error = EPIPE;
    struct pollfd lifetime[] = {{cancel, POLLIN, 0}, {workerfd, POLLIN, 0}};
    if (poll(lifetime, 2, 15000) <= 0) receipt.error = ETIMEDOUT;
    else if (!lifetime[0].revents) receipt.error = ECHILD;
  }
  long deadline = now_ms() + 2000;
  int clean = stop(workerfd) && reap(workerfd, deadline);
  close(workerfd);
  /* The worker is reaped before reading the atomic ledger or closing shared
   * FDs. It can no longer add a leaf, and subreaping pins each leaf until waitid. */
  int actual = 0;
  for (int i = 0; i < LEAVES; i++) {
    struct leaf *leaf = &s->leaves[i];
    if (leaf->fd < 0) continue;
    actual++;
    unsigned long long start = birth(leaf->pid, getpid());
    if (!start || (leaf->start && start != leaf->start)) clean = 0;
    if (!stop(leaf->fd)) clean = 0;
  }
  for (int i = 0; i < LEAVES; i++) {
    if (s->leaves[i].fd < 0) continue;
    if (!reap(s->leaves[i].fd, deadline)) clean = 0;
    close(s->leaves[i].fd);
  }
  if (receipt.error || !strcmp(mode, "shard-death")) {
    receipt.count = actual;
    if (!clean) receipt.error = ECHILD;
    if (write(report, &receipt, sizeof(receipt)) != sizeof(receipt)) clean = 0;
  }
  _exit(clean && (!receipt.error || receipt.error == EMFILE || receipt.error == EAGAIN || receipt.error == ENOMEM) ? 0 : 1);
}

int main(int argc, char **argv) {
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 1;
  if (argc != 4 || strspn(argv[1], "0123456789") != strlen(argv[1]) ||
      strspn(argv[2], "0123456789") != strlen(argv[2])) return 1;
  uid_t uid = (uid_t)strtoul(argv[1], NULL, 10);
  gid_t gid = (gid_t)strtoul(argv[2], NULL, 10);
  const char *mode = argv[3];
  if (!uid || (getuid() && (getuid() != uid || getgid() != gid)) ||
      (strcmp(mode, "cap") && strcmp(mode, "construction-failure") && strcmp(mode, "shard-death") && strcmp(mode, "cancel"))) return 1;
  int cancel[2], fds[SHARDS], total = 0, n = 0, error = 0;
  if (pipe2(cancel, O_CLOEXEC)) return 1;
  long construction_deadline = now_ms() + 15000;
  for (int i = 0; i < (!strcmp(mode, "cap") ? SHARDS : 1); i++) {
    if (readable(STDIN_FILENO, 0) || now_ms() >= construction_deadline) { error = ECANCELED; break; }
    int reply[2];
    if (pipe2(reply, O_CLOEXEC)) { error = errno; break; }
    int fd = -1;
    pid_t pid = 0;
    pid_t child = owned_clone(&fd, &pid, 0);
    if (child == 0) {
      close(cancel[1]); close(reply[0]);
      for (int j = 0; j < n; j++) close(fds[j]);
      guardian(!strcmp(mode, "cap") ? (i == SHARDS - 1 ? 17 : LEAVES - 1) : 8,
               cancel[0], reply[1], uid, gid, mode);
    }
    close(reply[1]);
    if (child < 0) { close(reply[0]); error = errno; break; }
    fds[n++] = fd;
    struct receipt receipt = {0};
    struct pollfd waiters[] = {{reply[0], POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}, {fd, POLLIN, 0}};
    long left = construction_deadline - now_ms();
    if (poll(waiters, 3, left > 0 ? (int)left : 0) <= 0 || !waiters[0].revents ||
        read(reply[0], &receipt, sizeof(receipt)) != sizeof(receipt)) error = ECANCELED;
    else { total += receipt.count; error = receipt.error; }
    close(reply[0]);
    if (error) break;
  }
  struct rlimit files, processes;
  if (getrlimit(RLIMIT_NOFILE, &files) || getrlimit(RLIMIT_NPROC, &processes)) error = EINVAL;
  int count = census();
  int cap = !strcmp(mode, "cap");
  if (!error && cap && (total != 4097 || count < 4097)) error = ECHILD;
  if (!error && strcmp(mode, "shard-death")) {
    printf("{\"constructed\":true,\"children\":%d,\"mode\":\"%s\",\"processCount\":%d,\"fileLimit\":%llu,\"processLimit\":%llu,\"shards\":%d,\"maxShardPidfds\":256,\"pid\":%d,\"start\":%llu}\n",
           total, mode, count, (unsigned long long)files.rlim_cur, (unsigned long long)processes.rlim_cur, n,
           getpid(), birth(getpid(), getppid()));
    fflush(stdout);
    if (readable(STDIN_FILENO, 15000) != 1) error = ETIMEDOUT;
    else { char byte; if (read(STDIN_FILENO, &byte, 1) != 0) error = EINVAL; }
  } else {
    const char *reason = error == EMFILE ? "EMFILE" : error == EAGAIN ? "EAGAIN" : error == ENOMEM ? "ENOMEM" : "construction";
    printf("{\"constructed\":false,\"reason\":\"%s\",\"children\":%d,\"fileLimit\":%llu,\"processLimit\":%llu}\n",
           reason, total, (unsigned long long)files.rlim_cur, (unsigned long long)processes.rlim_cur);
    fflush(stdout);
  }
  long deadline = now_ms() + 2000;
  close(cancel[1]);
  int clean = 1;
  for (int i = 0; i < n; i++) {
    int left = (int)(deadline - now_ms());
    siginfo_t info = {0};
    if (readable(fds[i], left > 0 ? left : 0) != 1 ||
        waitid(P_PIDFD, fds[i], &info, WEXITED | WNOHANG) || info.si_code != CLD_EXITED || info.si_status != 0) clean = 0;
    close(fds[i]);
  }
  if (!clean) { fputs("provider-boundary-owner-stimulus-refused:retirement\n", stderr); return 1; }
  puts("provider-boundary-owner-stimulus:retired");
  return error && error != EMFILE && error != EAGAIN && error != ENOMEM ? 1 : 0;
}
