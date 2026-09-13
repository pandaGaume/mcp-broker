/* Bench for the TLS port. No network: the inner port is a fake whose other
 * end is an OpenSSL *server* driven in the same process, over memory BIOs of
 * its own. Every byte the TLS port hands to the fake's `send` is fed to that
 * server, and every byte the server produces is queued for the fake's `recv`.
 *
 * What that buys: the certificate checks can be exercised in both directions
 * (right name, wrong name, right CA, no CA) with a certificate under our
 * control, the clean close (close_notify) can be produced on demand, and a
 * timeout is a matter of the fake saying "nothing", not of waiting.
 *
 * The certificate and key are the ones the roundtrip uses, read from
 * MCPB_TEST_TLS_DIR at run time. Test material only: self-signed, a hundred
 * years of validity, and a private key that is in the repository. */

#include "mcpb_port_tls.h"

#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509_vfy.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef MCPB_TEST_TLS_DIR
#  error "MCPB_TEST_TLS_DIR must name the directory holding test-cert.pem and test-key.pem"
#endif

static int g_fail = 0;
static void check(int ok, const char *what)
{
    printf("  [%s] %s\n", ok ? "ok" : "FAIL", what);
    if (!ok) g_fail++;
}

/* --- The fake inner port, with a TLS server behind it -------------------- */

#define INBOX_CAPACITY 65536

typedef struct
{
    SSL_CTX *sctx;
    SSL     *server;   /* NULL when the stream is plain or closed */
    BIO     *srb;      /* server reads what the client sent */
    BIO     *swb;      /* server writes what the client will receive */

    int opened, closed;
    int tls_asked;     /* what the TLS port asked of open(): must stay 0 */
    int echo;          /* the server echoes plaintext back */
    int close_after_handshake; /* the server sends close_notify once up */
    int peer_gone;     /* recv reports MCPB_ERR_CLOSED once the inbox is drained */
    uint32_t clock;

    unsigned char inbox[INBOX_CAPACITY];
    size_t inbox_len, inbox_pos;
} fake_t;

static void inbox_push(fake_t *f, const void *data, size_t n)
{
    if (f->inbox_len + n > sizeof(f->inbox))
    {
        fputs("fake inbox overflow\n", stderr);
        exit(2);
    }
    memcpy(f->inbox + f->inbox_len, data, n);
    f->inbox_len += n;
}

/* Runs the server until it has nothing more to say, then moves what it said
 * into the inbox. */
static void server_pump(fake_t *f)
{
    unsigned char plain[4096];
    unsigned char cipher[4096];
    for (;;)
    {
        int progressed = 0;
        if (!SSL_is_init_finished(f->server))
        {
            const int r = SSL_do_handshake(f->server);
            if (r == 1)
            {
                progressed = 1;
                if (f->close_after_handshake)
                {
                    (void)SSL_shutdown(f->server);
                    f->close_after_handshake = 0;
                }
            }
            else
            {
                (void)SSL_get_error(f->server, r);
            }
        }
        else
        {
            const int r = SSL_read(f->server, plain, (int)sizeof(plain));
            if (r > 0)
            {
                progressed = 1;
                if (f->echo)
                    (void)SSL_write(f->server, plain, r);
            }
            else
            {
                (void)SSL_get_error(f->server, r);
            }
        }
        int moved = 0;
        for (;;)
        {
            const int n = BIO_read(f->swb, cipher, (int)sizeof(cipher));
            if (n <= 0)
                break;
            inbox_push(f, cipher, (size_t)n);
            moved = 1;
        }
        if (!progressed && !moved)
            break;
    }
    ERR_clear_error();
}

static int f_open(void *ctx, const char *host, uint16_t port, int tls, int t)
{
    fake_t *f = (fake_t *)ctx;
    (void)host; (void)port; (void)t;
    f->tls_asked = tls;
    f->opened = 1;
    f->closed = 0;
    f->inbox_len = f->inbox_pos = 0;

    f->server = SSL_new(f->sctx);
    f->srb = BIO_new(BIO_s_mem());
    f->swb = BIO_new(BIO_s_mem());
    BIO_set_mem_eof_return(f->srb, -1);
    BIO_set_mem_eof_return(f->swb, -1);
    SSL_set_bio(f->server, f->srb, f->swb);
    SSL_set_accept_state(f->server);
    return MCPB_OK;
}

static int f_send(void *ctx, const uint8_t *b, size_t n, int t)
{
    fake_t *f = (fake_t *)ctx;
    (void)t;
    if (!f->opened)
        return MCPB_ERR_STATE;
    if (f->server == NULL)
    {
        /* Plain stream: the "server" is a bare echo. */
        inbox_push(f, b, n);
        return (int)n;
    }
    if (BIO_write(f->srb, b, (int)n) != (int)n)
        return MCPB_ERR_IO;
    server_pump(f);
    return (int)n;
}

static int f_recv(void *ctx, uint8_t *b, size_t n, int t)
{
    fake_t *f = (fake_t *)ctx;
    (void)t;
    if (!f->opened)
        return MCPB_ERR_STATE;
    const size_t avail = f->inbox_len - f->inbox_pos;
    if (avail == 0u)
        return f->peer_gone ? MCPB_ERR_CLOSED : MCPB_ERR_TIMEOUT;
    const size_t take = (avail < n) ? avail : n;
    memcpy(b, f->inbox + f->inbox_pos, take);
    f->inbox_pos += take;
    return (int)take;
}

static void f_close(void *ctx)
{
    fake_t *f = (fake_t *)ctx;
    if (f->server != NULL)
    {
        SSL_free(f->server);
        f->server = NULL;
        f->srb = f->swb = NULL;
    }
    f->opened = 0;
    f->closed = 1;
}

static uint32_t f_now(void *ctx)
{
    fake_t *f = (fake_t *)ctx;
    f->clock += 10u; /* every look at the clock costs 10 ms */
    return f->clock;
}

static int f_random(void *ctx, uint8_t *b, size_t n)
{
    (void)ctx;
    size_t i;
    for (i = 0; i < n; i++)
        b[i] = (uint8_t)(0xA5u ^ i);
    return MCPB_OK;
}

static int fake_init(fake_t *f, mcpb_port_t *p, const char *cert, const char *key)
{
    memset(f, 0, sizeof(*f));
    f->echo = 1;
    f->sctx = SSL_CTX_new(TLS_server_method());
    if (f->sctx == NULL)
        return -1;
    if (SSL_CTX_use_certificate_file(f->sctx, cert, SSL_FILETYPE_PEM) != 1 ||
        SSL_CTX_use_PrivateKey_file(f->sctx, key, SSL_FILETYPE_PEM) != 1)
    {
        ERR_print_errors_fp(stderr);
        return -1;
    }
    p->ctx = f;
    p->open = f_open; p->send = f_send; p->recv = f_recv;
    p->close = f_close; p->now_ms = f_now; p->random = f_random;
    return 0;
}

static void fake_free(fake_t *f)
{
    f_close(f);
    SSL_CTX_free(f->sctx);
    f->sctx = NULL;
}

/* --- Helpers --------------------------------------------------------------- */

static char *read_file(const char *path, size_t *len)
{
    FILE *fp = fopen(path, "rb");
    if (fp == NULL)
    {
        fprintf(stderr, "cannot open %s\n", path);
        exit(2);
    }
    static char buf[16384];
    const size_t n = fread(buf, 1, sizeof(buf) - 1u, fp);
    fclose(fp);
    buf[n] = '\0';
    if (len != NULL)
        *len = n;
    return buf;
}

/* --- Tests ----------------------------------------------------------------- */

static void test_handshake_and_echo(const char *cert, const char *key, const char *ca_pem)
{
    puts("handshake against the test certificate, then bytes both ways");
    fake_t f;
    mcpb_port_t inner, port;
    mcpb_port_tls_t tls;
    check(fake_init(&f, &inner, cert, key) == 0, "fake server loads the test certificate");

    mcpb_port_tls_config_t cfg = { ca_pem, 0, NULL };
    check(mcpb_port_tls_init(&port, &tls, &inner, &cfg) == MCPB_OK, "tls port init with the test CA");

    const int rc = port.open(port.ctx, "localhost", 443, 1, 1000);
    check(rc == MCPB_OK, "open localhost with tls=1 succeeds (DNS name matches the SAN)");
    check(f.tls_asked == 0, "the inner port was asked for plain TCP, not TLS");
    check(f.opened == 1, "the inner stream is open");
    check(SSL_version((SSL *)tls.ssl) >= TLS1_2_VERSION, "negotiated TLS 1.2 or better");

    static const uint8_t hello[] = "hello over tls";
    check(port.send(port.ctx, hello, sizeof(hello), 1000) == (int)sizeof(hello), "send returns the full length");
    uint8_t got[64];
    const int n = port.recv(port.ctx, got, sizeof(got), 1000);
    check(n == (int)sizeof(hello) && memcmp(got, hello, sizeof(hello)) == 0, "recv returns the echoed plaintext");

    check(port.recv(port.ctx, got, sizeof(got), 0) == MCPB_ERR_TIMEOUT, "recv with nothing pending and timeout 0 is TIMEOUT");

    /* Larger than the staging buffer and than one TLS record: exercises the
     * send loop, several records, and recv delivering in pieces. */
    static uint8_t big[20000];
    static uint8_t back[20000];
    size_t i;
    for (i = 0; i < sizeof(big); i++)
        big[i] = (uint8_t)(i * 7u + 3u);
    check(port.send(port.ctx, big, sizeof(big), 1000) == (int)sizeof(big), "20000 bytes sent in one call");
    size_t total = 0;
    while (total < sizeof(back))
    {
        const int r = port.recv(port.ctx, back + total, sizeof(back) - total, 1000);
        if (r <= 0)
            break;
        total += (size_t)r;
    }
    check(total == sizeof(back) && memcmp(big, back, sizeof(big)) == 0, "20000 bytes received back intact, across several recv calls");

    port.close(port.ctx);
    check(f.closed == 1, "close closes the inner stream");
    check(port.open(port.ctx, "localhost", 443, 1, 1000) == MCPB_OK, "the same port opens again after close");
    mcpb_port_tls_deinit(&tls);
    check(f.closed == 1 && tls.ssl == NULL && tls.ssl_ctx == NULL, "deinit closes and releases everything");
    fake_free(&f);
}

static void test_ip_literal(const char *cert, const char *key, const char *ca_pem)
{
    puts("an IP literal is matched against the certificate's IP entries");
    fake_t f;
    mcpb_port_t inner, port;
    mcpb_port_tls_t tls;
    fake_init(&f, &inner, cert, key);
    mcpb_port_tls_config_t cfg = { ca_pem, 0, NULL };
    mcpb_port_tls_init(&port, &tls, &inner, &cfg);
    check(port.open(port.ctx, "127.0.0.1", 443, 1, 1000) == MCPB_OK, "open 127.0.0.1 succeeds (IP in the SAN)");
    port.close(port.ctx);
    check(port.open(port.ctx, "127.0.0.2", 443, 1, 1000) == MCPB_ERR_TLS, "open 127.0.0.2 is refused as MCPB_ERR_TLS");
    check(tls.last_verify == X509_V_ERR_IP_ADDRESS_MISMATCH, "the verify result names the IP mismatch");
    check(f.closed == 1, "a refused handshake closes the inner stream");
    mcpb_port_tls_deinit(&tls);
    fake_free(&f);
}

static void test_wrong_name(const char *cert, const char *key, const char *ca_pem)
{
    puts("a certificate for another name is refused, and says so");
    fake_t f;
    mcpb_port_t inner, port;
    mcpb_port_tls_t tls;
    fake_init(&f, &inner, cert, key);
    mcpb_port_tls_config_t cfg = { ca_pem, 0, NULL };
    mcpb_port_tls_init(&port, &tls, &inner, &cfg);
    check(port.open(port.ctx, "broker.example.invalid", 443, 1, 1000) == MCPB_ERR_TLS, "open with the wrong host name is MCPB_ERR_TLS");
    check(tls.last_verify == X509_V_ERR_HOSTNAME_MISMATCH, "the verify result is the hostname mismatch");
    char why[128];
    mcpb_port_tls_last_error(&tls, why, sizeof(why));
    check(strstr(why, "ostname") != NULL, "last_error explains it in words");
    check(strcmp(mcpb_strerror(MCPB_ERR_TLS), "TLS handshake or certificate refused") == 0, "mcpb_strerror knows the code");
    mcpb_port_tls_deinit(&tls);
    fake_free(&f);
}

static void test_unknown_ca(const char *cert, const char *key)
{
    puts("without the private CA, the self-signed broker is refused, never trusted by default");
    fake_t f;
    mcpb_port_t inner, port;
    mcpb_port_tls_t tls;
    fake_init(&f, &inner, cert, key);
    check(mcpb_port_tls_init(&port, &tls, &inner, NULL) == MCPB_OK, "init with the platform's default store");
    check(port.open(port.ctx, "localhost", 443, 1, 1000) == MCPB_ERR_TLS, "open is MCPB_ERR_TLS");
    check(tls.last_verify == X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT || tls.last_verify == X509_V_ERR_SELF_SIGNED_CERT_IN_CHAIN,
          "the verify result is the self-signed refusal");
    mcpb_port_tls_deinit(&tls);
    fake_free(&f);
}

static void test_close_notify(const char *cert, const char *key, const char *ca_pem)
{
    puts("the peer's close_notify is MCPB_ERR_CLOSED, and so is the inner port's CLOSED");
    fake_t f;
    mcpb_port_t inner, port;
    mcpb_port_tls_t tls;
    fake_init(&f, &inner, cert, key);
    f.close_after_handshake = 1;
    mcpb_port_tls_config_t cfg = { ca_pem, 0, NULL };
    mcpb_port_tls_init(&port, &tls, &inner, &cfg);
    check(port.open(port.ctx, "localhost", 443, 1, 1000) == MCPB_OK, "handshake completes before the server closes");
    uint8_t buf[16];
    check(port.recv(port.ctx, buf, sizeof(buf), 1000) == MCPB_ERR_CLOSED, "recv reports the clean close");
    port.close(port.ctx);

    f.close_after_handshake = 0;
    check(port.open(port.ctx, "localhost", 443, 1, 1000) == MCPB_OK, "reopened");
    f.peer_gone = 1; /* the inner port loses the peer without a close_notify */
    check(port.recv(port.ctx, buf, sizeof(buf), 1000) == MCPB_ERR_CLOSED, "the inner CLOSED passes through untouched");
    mcpb_port_tls_deinit(&tls);
    fake_free(&f);
}

static void test_plain_passthrough(const char *cert, const char *key, const char *ca_pem)
{
    puts("tls=0 passes straight through: one port for ws:// and wss://");
    fake_t f;
    mcpb_port_t inner, port;
    mcpb_port_tls_t tls;
    fake_init(&f, &inner, cert, key);
    mcpb_port_tls_config_t cfg = { ca_pem, 0, NULL };
    mcpb_port_tls_init(&port, &tls, &inner, &cfg);
    check(port.open(port.ctx, "localhost", 80, 0, 1000) == MCPB_OK, "open with tls=0");
    /* Detach the fake's server so its echo is byte for byte. */
    SSL_free(f.server);
    f.server = NULL;
    static const uint8_t raw[] = "in the clear";
    check(port.send(port.ctx, raw, sizeof(raw), 1000) == (int)sizeof(raw), "send passes through");
    uint8_t got[32];
    const int n = port.recv(port.ctx, got, sizeof(got), 1000);
    check(n == (int)sizeof(raw) && memcmp(got, raw, sizeof(raw)) == 0, "recv passes through, bytes untouched");
    check(tls.ssl == NULL, "no TLS session was created");
    mcpb_port_tls_deinit(&tls);
    fake_free(&f);
}

static void test_borrowed_context(const char *cert, const char *key, const char *ca_pem)
{
    puts("a context the host owns is used, not freed, and cannot relax the policy");
    fake_t f;
    mcpb_port_t inner, port;
    mcpb_port_tls_t tls;
    fake_init(&f, &inner, cert, key);

    /* What a host like Unreal hands over: its own context, its own roots,
     * and here deliberately no verification at all, to prove the port sets
     * its own on the connection. */
    SSL_CTX *host_ctx = SSL_CTX_new(TLS_client_method());
    SSL_CTX_set_verify(host_ctx, SSL_VERIFY_NONE, NULL);

    mcpb_port_tls_config_t cfg = { NULL, 0, host_ctx };
    check(mcpb_port_tls_init(&port, &tls, &inner, &cfg) == MCPB_OK, "init with a borrowed context");
    check(tls.ssl_ctx == host_ctx && tls.ssl_ctx_owned == 0, "the port uses it and knows it is not its own");
    check(port.open(port.ctx, "localhost", 443, 1, 1000) == MCPB_ERR_TLS, "no CA in the borrowed context: refused, despite SSL_VERIFY_NONE on it");
    mcpb_port_tls_deinit(&tls);

    mcpb_port_tls_config_t cfg2 = { ca_pem, 0, host_ctx };
    check(mcpb_port_tls_init(&port, &tls, &inner, &cfg2) == MCPB_OK, "init again over the same context, with the private CA added to it");
    check(port.open(port.ctx, "localhost", 443, 1, 1000) == MCPB_OK, "open succeeds through the CA now in the host's context");
    port.close(port.ctx);
    check(port.open(port.ctx, "broker.example.invalid", 443, 1, 1000) == MCPB_ERR_TLS, "the name is still checked");
    mcpb_port_tls_deinit(&tls);
    check(SSL_CTX_get_verify_mode(host_ctx) == SSL_VERIFY_NONE, "the host's context is untouched after deinit (still alive, its own mode)");
    SSL_CTX_free(host_ctx);
    fake_free(&f);
}

static void test_bad_ca(const char *cert, const char *key)
{
    puts("a CA buffer without a certificate is refused at init");
    fake_t f;
    mcpb_port_t inner, port;
    mcpb_port_tls_t tls;
    fake_init(&f, &inner, cert, key);
    mcpb_port_tls_config_t cfg = { "not a pem file", 0, NULL };
    check(mcpb_port_tls_init(&port, &tls, &inner, &cfg) == MCPB_ERR_ARG, "init returns MCPB_ERR_ARG");
    check(mcpb_port_tls_init(&port, &tls, NULL, NULL) == MCPB_ERR_ARG, "init without an inner port returns MCPB_ERR_ARG");
    fake_free(&f);
}

int main(void)
{
    const char *cert = MCPB_TEST_TLS_DIR "/test-cert.pem";
    const char *key = MCPB_TEST_TLS_DIR "/test-key.pem";
    const char *ca_pem = read_file(cert, NULL);

    test_handshake_and_echo(cert, key, ca_pem);
    test_ip_literal(cert, key, ca_pem);
    test_wrong_name(cert, key, ca_pem);
    test_unknown_ca(cert, key);
    test_close_notify(cert, key, ca_pem);
    test_plain_passthrough(cert, key, ca_pem);
    test_borrowed_context(cert, key, ca_pem);
    test_bad_ca(cert, key);

    printf("\n%s: %d failure(s)\n", g_fail ? "FAIL" : "PASS", g_fail);
    return g_fail ? 1 : 0;
}
