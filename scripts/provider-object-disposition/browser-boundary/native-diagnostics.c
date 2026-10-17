#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    const char *mode = argv[1];
    if (strcmp(mode, "stall-term") == 0 || strcmp(mode, "stall-ignore") == 0) {
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) return 1;
        if (strcmp(mode, "stall-ignore") == 0) signal(SIGTERM, SIG_IGN);
        for (;;) pause();
    }
    if (strcmp(mode, "empty") == 0) return 78;
    if (strcmp(mode, "signal-kill") == 0) { raise(SIGKILL); return 1; }
    if (strcmp(mode, "signal-term") == 0) { raise(SIGTERM); return 1; }
    if (strcmp(mode, "handled-term") == 0) return 143;
    if (strcmp(mode, "overflow") == 0) {
        for (int i = 0; i < 8192; i++) fputc('x', stderr);
        return 78;
    }
    if (strcmp(mode, "private-marker") == 0) {
        const char *marker = getenv("SYNTHETIC_BOUNDARY_MARKER");
        if (!marker) return 1;
        fprintf(stderr, "%s\n", marker);
        return 78;
    }
    if (strcmp(mode, "wrong-stage") == 0) {
        fputs("provider-boundary-refused:mapping-write\n", stderr);
        return 78;
    }
    if (strcmp(mode, "nested") == 0) {
        fputs("{\"transition\":\"seed-joined\",\"uidMap\":\"exact\",\"gidMap\":\"exact\",\"setgroups\":\"deny\",\"seed\":\"reaped\"}\n", stdout);
        fputs("provider-boundary-refused:seed-reap\nprovider-boundary-refused:nested-sandbox\n", stderr);
        return 78;
    }
    if (strcmp(mode, "allowlisted") && strcmp(mode, "status-zero") && strcmp(mode, "multiline")) return 1;
    fputs("provider-boundary-refused:seed-deadline\n", stderr);
    if (strcmp(mode, "multiline") == 0) fputs("SYNTHETIC_UNEXPECTED_LINE\n", stderr);
    return strcmp(mode, "status-zero") == 0 ? 0 : 78;
}
