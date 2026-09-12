/* libmcpb host port: BSD sockets on Linux and macOS, Winsock on Windows.
 *
 * The three conventions libmcpb's correctness depends on are enforced here,
 * not left to the platform:
 *
 *   recv never returns 0   a closed peer is MCPB_ERR_CLOSED, an elapsed wait
 *                          is MCPB_ERR_TIMEOUT, and the two are never merged;
 *   send is all-or-fail    a short write is retried until the last byte or
 *                          reported as a failure, never as a partial success;
 *   open never falls back  tls != 0 is refused, in the clear is not an option
 *                          nobody asked for.
 */

#if defined(_WIN32)
#  ifndef _WIN32_WINNT
#    define _WIN32_WINNT 0x0600 /* getaddrinfo, inet_pton */
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <windows.h>
#  include <bcrypt.h>
typedef SOCKET sock_t;
typedef int socklen_arg_t;     /* Winsock takes int where POSIX takes socklen_t */
#  define SOCK_INVALID INVALID_SOCKET
#  define sock_errno() WSAGetLastError()
#  define SOCK_EINPROGRESS WSAEWOULDBLOCK
#  define SOCK_EINTR WSAEINTR
#  define sock_close(s) closesocket(s)
#else
#  define _POSIX_C_SOURCE 200809L
#  define _DEFAULT_SOURCE   /* getrandom, MSG_NOSIGNAL on glibc */
#  define _DARWIN_C_SOURCE  /* arc4random_buf, SO_NOSIGPIPE on macOS */
#  include <errno.h>
#  include <fcntl.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <sys/select.h>
#  include <sys/socket.h>
#  include <sys/time.h>
#  include <sys/types.h>
#  include <time.h>
#  include <unistd.h>
#  if defined(__linux__)
#    include <sys/random.h>
#  elif defined(__APPLE__)
#    include <stdlib.h> /* arc4random_buf */
#  else
#    include <stdio.h>  /* /dev/urandom */
#  endif
typedef int sock_t;
typedef socklen_t socklen_arg_t;
#  define SOCK_INVALID (-1)
#  define sock_errno() errno
#  define SOCK_EINPROGRESS EINPROGRESS
#  define SOCK_EINTR EINTR
#  define sock_close(s) close(s)
#endif

#include "mcpb_port_host.h"

#include <stdio.h>
#include <string.h>

#ifndef MSG_NOSIGNAL
#  define MSG_NOSIGNAL 0
#endif

/* --- Helpers --------------------------------------------------------------- */

static sock_t _sock(const mcpb_port_host_t *h)
{
    return (sock_t)h->fd;
}

typedef enum { WAIT_READ, WAIT_WRITE, WAIT_CONNECT } wait_t;

/* select() on one descriptor. Returns 1 when ready, 0 on timeout, negative
 * on error. A negative timeout waits forever, zero only looks.
 *
 * WAIT_CONNECT watches the except set as well as the write set: Winsock
 * reports a refused non-blocking connect there and nowhere else, so a
 * write-only wait on a closed port sits out the whole connect timeout
 * instead of failing at once. POSIX marks the socket writable in both cases
 * and SO_ERROR tells them apart, so the extra set costs nothing there. */
static int _wait(sock_t s, wait_t what, int timeout_ms)
{
    fd_set set, exc;
    struct timeval tv;
    struct timeval *ptv = NULL;
    for (;;)
    {
        FD_ZERO(&set);
        FD_SET(s, &set);
        FD_ZERO(&exc);
        FD_SET(s, &exc);
        if (timeout_ms >= 0)
        {
            tv.tv_sec = timeout_ms / 1000;
            tv.tv_usec = (timeout_ms % 1000) * 1000;
            ptv = &tv;
        }
        const int r = select((int)s + 1,
                             (what == WAIT_READ) ? &set : NULL,
                             (what == WAIT_READ) ? NULL : &set,
                             (what == WAIT_CONNECT) ? &exc : NULL,
                             ptv);
        if (r >= 0)
            return r;
        if (sock_errno() != SOCK_EINTR)
            return -1;
        /* Interrupted: go round again. The timeout is re-armed in full, which
         * over-waits by at most one interruption; acceptable for a port. */
    }
}

static int _set_blocking(sock_t s, int blocking)
{
#if defined(_WIN32)
    u_long mode = blocking ? 0u : 1u;
    return (ioctlsocket(s, (long)FIONBIO, &mode) == 0) ? 0 : -1;
#else
    const int flags = fcntl(s, F_GETFL, 0);
    if (flags < 0)
        return -1;
    const int want = blocking ? (flags & ~O_NONBLOCK) : (flags | O_NONBLOCK);
    return (fcntl(s, F_SETFL, want) == 0) ? 0 : -1;
#endif
}

/* --- The six functions ----------------------------------------------------- */

static int h_open(void *ctx, const char *host, uint16_t port, int tls,
                  int timeout_ms)
{
    mcpb_port_host_t *h = (mcpb_port_host_t *)ctx;

    /* A silent fallback to plaintext is the worst outcome, because nothing
     * reports it (mcpb_port.h). */
    if (tls)
        return MCPB_ERR_UNSUPPORTED;
    if (h->fd != -1)
        return MCPB_ERR_STATE;

    char service[8];
    snprintf(service, sizeof(service), "%u", (unsigned)port);

    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    struct addrinfo *list = NULL;
    if (getaddrinfo(host, service, &hints, &list) != 0 || list == NULL)
    {
        h->last_errno = sock_errno();
        return MCPB_ERR_IO;
    }

    int result = MCPB_ERR_IO;
    const struct addrinfo *ai;
    for (ai = list; ai != NULL; ai = ai->ai_next)
    {
        sock_t s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == SOCK_INVALID)
        {
            h->last_errno = sock_errno();
            continue;
        }

        /* Non-blocking connect, so the caller's timeout is honoured; the OS
         * default can be over a minute. */
        if (_set_blocking(s, 0) != 0)
        {
            h->last_errno = sock_errno();
            sock_close(s);
            continue;
        }

        int ok = 0;
        if (connect(s, ai->ai_addr, (socklen_arg_t)ai->ai_addrlen) == 0)
        {
            ok = 1;
        }
        else if (sock_errno() == SOCK_EINPROGRESS)
        {
            const int w = _wait(s, WAIT_CONNECT, timeout_ms);
            if (w == 0)
            {
                result = MCPB_ERR_TIMEOUT;
            }
            else if (w > 0)
            {
                int err = 0;
                socklen_arg_t len = (socklen_arg_t)sizeof(err);
                getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&err, &len);
                if (err == 0)
                    ok = 1;
                else
                    h->last_errno = err;
            }
            else
            {
                h->last_errno = sock_errno();
            }
        }
        else
        {
            h->last_errno = sock_errno();
        }

        if (!ok)
        {
            sock_close(s);
            continue;
        }

        if (_set_blocking(s, 1) != 0)
        {
            h->last_errno = sock_errno();
            sock_close(s);
            continue;
        }

        /* One JSON-RPC message per frame, and a frame is written as a header
         * then chunks: without this, Nagle would pair the header with the
         * next chunk and add a round trip per message. */
        int one = 1;
        (void)setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&one,
                         (socklen_arg_t)sizeof(one));
#if defined(SO_NOSIGPIPE)
        (void)setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one,
                         (socklen_arg_t)sizeof(one));
#endif

        h->fd = (intptr_t)s;
        result = MCPB_OK;
        break;
    }

    freeaddrinfo(list);
    return result;
}

static int h_send(void *ctx, const uint8_t *buf, size_t len, int timeout_ms)
{
    mcpb_port_host_t *h = (mcpb_port_host_t *)ctx;
    if (h->fd == -1)
        return MCPB_ERR_STATE;
    const sock_t s = _sock(h);

    size_t sent = 0;
    while (sent < len)
    {
        if (timeout_ms >= 0)
        {
            const int w = _wait(s, WAIT_WRITE, timeout_ms);
            if (w == 0)
                return MCPB_ERR_TIMEOUT;
            if (w < 0)
            {
                h->last_errno = sock_errno();
                return MCPB_ERR_IO;
            }
        }
#if defined(_WIN32)
        const int n = send(s, (const char *)buf + sent, (int)(len - sent), 0);
#else
        const ssize_t n = send(s, buf + sent, len - sent, MSG_NOSIGNAL);
#endif
        if (n < 0)
        {
            if (sock_errno() == SOCK_EINTR)
                continue;
            h->last_errno = sock_errno();
            return MCPB_ERR_IO;
        }
        sent += (size_t)n;
    }
    return (int)len;
}

static int h_recv(void *ctx, uint8_t *buf, size_t len, int timeout_ms)
{
    mcpb_port_host_t *h = (mcpb_port_host_t *)ctx;
    if (h->fd == -1)
        return MCPB_ERR_STATE;
    const sock_t s = _sock(h);

    const int w = _wait(s, WAIT_READ, timeout_ms);
    if (w == 0)
        return MCPB_ERR_TIMEOUT;
    if (w < 0)
    {
        h->last_errno = sock_errno();
        return MCPB_ERR_IO;
    }

    for (;;)
    {
#if defined(_WIN32)
        const int n = recv(s, (char *)buf, (int)len, 0);
#else
        const ssize_t n = recv(s, buf, len, 0);
#endif
        if (n > 0)
            return (int)n;
        if (n == 0)
            return MCPB_ERR_CLOSED; /* orderly shutdown by the peer */
        if (sock_errno() == SOCK_EINTR)
            continue;
        h->last_errno = sock_errno();
        return MCPB_ERR_IO;
    }
}

static void h_close(void *ctx)
{
    mcpb_port_host_t *h = (mcpb_port_host_t *)ctx;
    if (h->fd == -1)
        return;
    sock_close(_sock(h));
    h->fd = -1;
}

static uint32_t h_now_ms(void *ctx)
{
    (void)ctx;
#if defined(_WIN32)
    return (uint32_t)GetTickCount64();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)((uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u);
#endif
}

static int h_random(void *ctx, uint8_t *buf, size_t len)
{
    (void)ctx;
#if defined(_WIN32)
    return (BCryptGenRandom(NULL, buf, (ULONG)len,
                            BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0)
               ? MCPB_OK : MCPB_ERR_IO;
#elif defined(__linux__)
    size_t got = 0;
    while (got < len)
    {
        const ssize_t n = getrandom(buf + got, len - got, 0);
        if (n < 0)
        {
            if (errno == EINTR)
                continue;
            return MCPB_ERR_IO;
        }
        got += (size_t)n;
    }
    return MCPB_OK;
#elif defined(__APPLE__)
    arc4random_buf(buf, len);
    return MCPB_OK;
#else
    FILE *f = fopen("/dev/urandom", "rb");
    if (f == NULL)
        return MCPB_ERR_IO;
    const size_t n = fread(buf, 1, len, f);
    fclose(f);
    return (n == len) ? MCPB_OK : MCPB_ERR_IO;
#endif
}

/* --- Init ------------------------------------------------------------------ */

int mcpb_port_host_init(mcpb_port_t *port, mcpb_port_host_t *ctx)
{
    if (port == NULL || ctx == NULL)
        return MCPB_ERR_ARG;

#if defined(_WIN32)
    static int winsock_ready = 0;
    if (!winsock_ready)
    {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
            return MCPB_ERR_IO;
        winsock_ready = 1;
    }
#endif

    ctx->fd = -1;
    ctx->last_errno = 0;

    port->ctx = ctx;
    port->open = h_open;
    port->send = h_send;
    port->recv = h_recv;
    port->close = h_close;
    port->now_ms = h_now_ms;
    port->random = h_random;
    return mcpb_port_check(port);
}
