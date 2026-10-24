static void synthetic_egress(void) {
    bool blocked = true;
    for (int family_index = 0; family_index < 2; family_index++) {
        int family = family_index == 0 ? AF_INET : AF_INET6;
        for (int kind = SOCK_STREAM; kind <= SOCK_DGRAM; kind++) {
            no_network();
            int fd = socket(family, kind | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
            require(fd >= 0, "external-interface");
            struct sockaddr_storage address = {0};
            socklen_t length;
            if (family == AF_INET) {
                struct sockaddr_in *ipv4 = (struct sockaddr_in *)&address;
                ipv4->sin_family = AF_INET;
                ipv4->sin_port = htons(443);
                require(inet_pton(AF_INET, "198.51.100.1", &ipv4->sin_addr) == 1, "external-interface");
                length = sizeof(*ipv4);
            } else {
                struct sockaddr_in6 *ipv6 = (struct sockaddr_in6 *)&address;
                ipv6->sin6_family = AF_INET6;
                ipv6->sin6_port = htons(443);
                require(inet_pton(AF_INET6, "2001:db8::1", &ipv6->sin6_addr) == 1, "external-interface");
                length = sizeof(*ipv6);
            }
            errno = 0;
            ssize_t result = kind == SOCK_STREAM ? connect(fd, (struct sockaddr *)&address, length) :
                sendto(fd, "SYNTHETIC", 9, 0, (struct sockaddr *)&address, length);
            int observed = errno;
            close(fd);
            dprintf(STDOUT_FILENO, "SYNTHETIC_EGRESS:%d:%d:%d\n", family, kind, observed);
            int expected = family == AF_INET ? ENETUNREACH : EADDRNOTAVAIL;
            blocked = blocked && result == -1 && observed == expected;
        }
    }
    require(blocked, "external-interface");
}
