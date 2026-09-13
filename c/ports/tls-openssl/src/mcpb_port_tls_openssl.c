/* libmcpb TLS port on OpenSSL. See mcpb_port_tls.h for the shape of it.
 *
 * The engine is driven through memory BIOs, so this file has one job: pump
 * bytes between the inner port and the two BIOs until OpenSSL is satisfied,
 * within the caller's timeout. Every function below follows the same
 * pattern: ask the engine, and when it wants bytes in or out, move them
 * through the inner port and ask again.
 *
 * The inner port's three conventions (recv never returns 0, send is
 * all-or-fail, open never falls back) are preserved outward because every
 * path here either returns the inner port's own code or a code of the same
 * family; nothing is translated to 0 and nothing is retried in the clear.
 */

#include "mcpb_port_tls.h"

#include <limits.h>
#include <string.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

/* --- Time ------------------------------------------------------------------ */

/* A deadline in the inner port's clock, or "none" for a negative timeout.
 * Every inner call gets what is left, so the caller's timeout bounds the
 * whole operation and not each of its round trips. */
typedef struct
{
    int      infinite;
    uint32_t at;
} deadline_t;

static deadline_t _deadline(const mcpb_port_tls_t *t, int timeout_ms)
{
    deadline_t d;
    d.infinite = (timeout_ms < 0);
    d.at = d.infinite ? 0u : t->inner->now_ms(t->inner->ctx) + (uint32_t)timeout_ms;
    return d;
}

static int _remaining(const mcpb_port_tls_t *t, const deadline_t *d)
{
    if (d->infinite)
        return -1;
    const int32_t left = (int32_t)(d->at - t->inner->now_ms(t->inner->ctx));
    return (left > 0) ? (int)left : 0;
}

/* --- Moving bytes ---------------------------------------------------------- */

/* Everything the engine has written for the peer goes to the inner port,
 * all of it or a failure: a TLS record delivered in part is a stream the
 * peer cannot decrypt. */
static int _flush(mcpb_port_tls_t *t, const deadline_t *d)
{
    for (;;)
    {
        const int n = BIO_read((BIO *)t->wbio, t->io, (int)sizeof(t->io));
        if (n <= 0)
            return MCPB_OK; /* empty: a memory BIO says retry, never EOF */
        const int rc = t->inner->send(t->inner->ctx, t->io, (size_t)n, _remaining(t, d));
        if (rc < 0)
            return rc;
    }
}

/* One inner recv into the engine. Returns the byte count, or the inner
 * port's own code: TIMEOUT and CLOSED pass through untouched, which is
 * what keeps the outer port honest about both. */
static int _fill(mcpb_port_tls_t *t, const deadline_t *d)
{
    const int n = t->inner->recv(t->inner->ctx, t->io, sizeof(t->io), _remaining(t, d));
    if (n <= 0)
        return (n == 0) ? MCPB_ERR_IO : n; /* 0 is outside the contract */
    if (BIO_write((BIO *)t->rbio, t->io, n) != n)
        return MCPB_ERR_IO;
    return n;
}

static void _note_failure(mcpb_port_tls_t *t)
{
    t->last_verify = SSL_get_verify_result((SSL *)t->ssl);
    t->last_ssl_error = ERR_peek_last_error();
    ERR_clear_error();
}

/* --- The six functions ----------------------------------------------------- */

static void t_close(void *ctx);

static int t_open(void *ctx, const char *host, uint16_t port, int tls, int timeout_ms)
{
    mcpb_port_tls_t *t = (mcpb_port_tls_t *)ctx;
    if (t->opened)
        return MCPB_ERR_STATE;

    const deadline_t d = _deadline(t, timeout_ms);

    /* The inner port is always asked for plain TCP: the encryption is this
     * file's, and asking the inner port for TLS would either fail on a port
     * without it or encrypt twice on a port with it. */
    const int rc_open = t->inner->open(t->inner->ctx, host, port, 0, _remaining(t, &d));
    if (rc_open != MCPB_OK)
        return rc_open;
    t->opened = 1;
    t->tls = 0;
    t->last_verify = 0;
    t->last_ssl_error = 0;

    if (!tls)
        return MCPB_OK;

    SSL *s = SSL_new((SSL_CTX *)t->ssl_ctx);
    BIO *rb = BIO_new(BIO_s_mem());
    BIO *wb = BIO_new(BIO_s_mem());
    if (s == NULL || rb == NULL || wb == NULL)
    {
        if (s != NULL)  SSL_free(s);
        if (rb != NULL) BIO_free(rb);
        if (wb != NULL) BIO_free(wb);
        t_close(t);
        return MCPB_ERR_IO;
    }
    /* Empty means "nothing yet", never end of stream: the stream's end is
     * the inner port's to report, through _fill. */
    BIO_set_mem_eof_return(rb, -1);
    BIO_set_mem_eof_return(wb, -1);
    SSL_set_bio(s, rb, wb); /* s owns both from here */
    t->ssl = s;
    t->rbio = rb;
    t->wbio = wb;
    t->tls = 1;

    /* The policy, on the connection rather than on the context, so that a
     * borrowed context supplies trust and nothing less than this. 1.2 is
     * the floor: what a broker on Node accepts, and below it there is
     * nothing worth the bytes. Partial writes are fine, the send loop
     * accounts for them; and a write retried after WANT_READ resumes at
     * the same offset of the same buffer, which is what the engine
     * requires.
     *
     * The context's verify callback is kept: a host that pins public keys
     * (Unreal's certificate manager does it through that callback) put it
     * there, and forcing the mode must not silence it. */
    SSL_set_verify(s, SSL_VERIFY_PEER, SSL_CTX_get_verify_callback((SSL_CTX *)t->ssl_ctx));
    (void)SSL_set_min_proto_version(s, TLS1_2_VERSION);
    SSL_set_mode(s, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);

    /* The name check. An IP literal is matched against the certificate's IP
     * entries and gets no SNI (RFC 6066 forbids it); anything else is a DNS
     * name, matched against DNS entries, and announced in SNI so a broker
     * behind a name-based front door presents the right certificate. */
    X509_VERIFY_PARAM *vp = SSL_get0_param(s);
    if (X509_VERIFY_PARAM_set1_ip_asc(vp, host) != 1)
    {
        ERR_clear_error();
        if (X509_VERIFY_PARAM_set1_host(vp, host, 0) != 1 ||
            SSL_set_tlsext_host_name(s, host) != 1)
        {
            ERR_clear_error();
            t_close(t);
            return MCPB_ERR_ARG;
        }
    }
    SSL_set_connect_state(s);

    for (;;)
    {
        const int r = SSL_do_handshake(s);
        if (r == 1)
        {
            /* The client's last flight is still in the BIO. */
            const int rc = _flush(t, &d);
            if (rc < 0)
            {
                t_close(t);
                return rc;
            }
            return MCPB_OK;
        }
        const int why = SSL_get_error(s, r);
        int rc;
        if (why == SSL_ERROR_WANT_READ)
        {
            rc = _flush(t, &d);
            if (rc == MCPB_OK)
                rc = _fill(t, &d);
        }
        else if (why == SSL_ERROR_WANT_WRITE)
        {
            rc = _flush(t, &d);
        }
        else
        {
            _note_failure(t);
            rc = MCPB_ERR_TLS;
        }
        if (rc < 0)
        {
            /* CLOSED during a handshake is the peer refusing, which for the
             * caller is the same news as a refused certificate: not a link
             * that dropped, a link that was never accepted. Reported as the
             * inner code all the same, so a log can tell the two apart. */
            t_close(t);
            return rc;
        }
    }
}

static int t_send(void *ctx, const uint8_t *buf, size_t len, int timeout_ms)
{
    mcpb_port_tls_t *t = (mcpb_port_tls_t *)ctx;
    if (!t->opened)
        return MCPB_ERR_STATE;
    if (!t->tls)
        return t->inner->send(t->inner->ctx, buf, len, timeout_ms);

    const deadline_t d = _deadline(t, timeout_ms);
    SSL *s = (SSL *)t->ssl;
    size_t done = 0;
    while (done < len)
    {
        const size_t left = len - done;
        const int chunk = (left > (size_t)INT_MAX) ? INT_MAX : (int)left;
        const int r = SSL_write(s, buf + done, chunk);
        int rc;
        if (r > 0)
        {
            done += (size_t)r;
            rc = _flush(t, &d);
        }
        else
        {
            const int why = SSL_get_error(s, r);
            if (why == SSL_ERROR_WANT_READ)
            {
                /* A key update or a renegotiation the peer started: the
                 * engine needs to read before it can write. */
                rc = _flush(t, &d);
                if (rc == MCPB_OK)
                    rc = _fill(t, &d);
            }
            else if (why == SSL_ERROR_WANT_WRITE)
            {
                rc = _flush(t, &d);
            }
            else if (why == SSL_ERROR_ZERO_RETURN)
            {
                rc = MCPB_ERR_CLOSED;
            }
            else
            {
                _note_failure(t);
                rc = MCPB_ERR_TLS;
            }
        }
        if (rc < 0)
            return rc;
    }
    return (int)len;
}

static int t_recv(void *ctx, uint8_t *buf, size_t len, int timeout_ms)
{
    mcpb_port_tls_t *t = (mcpb_port_tls_t *)ctx;
    if (!t->opened)
        return MCPB_ERR_STATE;
    if (len == 0u)
        return MCPB_ERR_ARG; /* SSL_read of nothing reports nothing useful */
    if (!t->tls)
        return t->inner->recv(t->inner->ctx, buf, len, timeout_ms);

    const deadline_t d = _deadline(t, timeout_ms);
    SSL *s = (SSL *)t->ssl;
    const int want = (len > (size_t)INT_MAX) ? INT_MAX : (int)len;
    for (;;)
    {
        /* Plaintext the engine already holds comes out here without a
         * trip to the inner port, so a record decrypted in one go is
         * delivered across several calls without waiting on a socket that
         * has nothing more to offer. */
        const int r = SSL_read(s, buf, want);
        if (r > 0)
            return r;
        const int why = SSL_get_error(s, r);
        int rc;
        if (why == SSL_ERROR_WANT_READ)
        {
            rc = _flush(t, &d);
            if (rc == MCPB_OK)
                rc = _fill(t, &d);
        }
        else if (why == SSL_ERROR_WANT_WRITE)
        {
            rc = _flush(t, &d);
        }
        else if (why == SSL_ERROR_ZERO_RETURN)
        {
            return MCPB_ERR_CLOSED; /* close_notify: the peer closed cleanly */
        }
        else
        {
            _note_failure(t);
            return MCPB_ERR_TLS;
        }
        if (rc < 0)
            return rc; /* TIMEOUT, CLOSED or IO, as the inner port said */
    }
}

static void t_close(void *ctx)
{
    mcpb_port_tls_t *t = (mcpb_port_tls_t *)ctx;
    if (t->ssl != NULL)
    {
        SSL *s = (SSL *)t->ssl;
        if (t->opened)
        {
            /* Best effort: tell the peer, bounded, and do not wait for its
             * answer. A close that blocks on a dead peer is worse than a
             * close_notify that never arrives. */
            const deadline_t d = _deadline(t, 500);
            ERR_clear_error();
            if (SSL_shutdown(s) >= 0)
                (void)_flush(t, &d);
            ERR_clear_error();
        }
        SSL_free(s); /* frees the two BIOs with it */
        t->ssl = NULL;
        t->rbio = NULL;
        t->wbio = NULL;
    }
    if (t->opened)
        t->inner->close(t->inner->ctx);
    t->opened = 0;
    t->tls = 0;
}

static uint32_t t_now_ms(void *ctx)
{
    const mcpb_port_tls_t *t = (const mcpb_port_tls_t *)ctx;
    return t->inner->now_ms(t->inner->ctx);
}

static int t_random(void *ctx, uint8_t *buf, size_t len)
{
    const mcpb_port_tls_t *t = (const mcpb_port_tls_t *)ctx;
    return t->inner->random(t->inner->ctx, buf, len);
}

/* --- Init / deinit --------------------------------------------------------- */

static int _trust(SSL_CTX *c, const mcpb_port_tls_config_t *cfg, int borrowed)
{
    if (cfg == NULL || cfg->ca_pem == NULL)
    {
        /* A borrowed context brings its own roots; an owned one gets the
         * platform's. */
        if (borrowed)
            return MCPB_OK;
        return (SSL_CTX_set_default_verify_paths(c) == 1) ? MCPB_OK : MCPB_ERR_IO;
    }

    const size_t len = (cfg->ca_pem_len != 0u) ? cfg->ca_pem_len : strlen(cfg->ca_pem);
    if (len == 0u || len > (size_t)INT_MAX)
        return MCPB_ERR_ARG;

    BIO *b = BIO_new_mem_buf(cfg->ca_pem, (int)len);
    if (b == NULL)
        return MCPB_ERR_IO;

    X509_STORE *store = SSL_CTX_get_cert_store(c);
    int count = 0;
    for (;;)
    {
        X509 *x = PEM_read_bio_X509(b, NULL, NULL, NULL);
        if (x == NULL)
            break; /* no further PEM block, or a malformed one: the count decides */
        /* A duplicate is not a failure, the trust is the same either way;
         * 1.1.1 reports it as an error and 3.x does not. */
        (void)X509_STORE_add_cert(store, x);
        X509_free(x);
        count++;
    }
    BIO_free(b);
    ERR_clear_error(); /* PEM_read_bio_X509 leaves "no start line" at the end */
    return (count > 0) ? MCPB_OK : MCPB_ERR_ARG;
}

int mcpb_port_tls_init(mcpb_port_t *port, mcpb_port_tls_t *ctx,
                       const mcpb_port_t *inner,
                       const mcpb_port_tls_config_t *cfg)
{
    if (port == NULL || ctx == NULL || inner == NULL)
        return MCPB_ERR_ARG;
    if (mcpb_port_check(inner) != MCPB_OK)
        return MCPB_ERR_ARG;

    memset(ctx, 0, sizeof(*ctx));
    ctx->inner = inner;

    const int borrowed = (cfg != NULL && cfg->ssl_ctx != NULL);
    SSL_CTX *c = borrowed ? (SSL_CTX *)cfg->ssl_ctx : SSL_CTX_new(TLS_client_method());
    if (c == NULL)
        return MCPB_ERR_IO;

    const int rc = _trust(c, cfg, borrowed);
    if (rc != MCPB_OK)
    {
        if (!borrowed)
            SSL_CTX_free(c);
        return rc;
    }
    ctx->ssl_ctx = c;
    ctx->ssl_ctx_owned = !borrowed;

    port->ctx = ctx;
    port->open = t_open;
    port->send = t_send;
    port->recv = t_recv;
    port->close = t_close;
    port->now_ms = t_now_ms;
    port->random = t_random;
    return mcpb_port_check(port);
}

void mcpb_port_tls_deinit(mcpb_port_tls_t *ctx)
{
    if (ctx == NULL)
        return;
    t_close(ctx);
    if (ctx->ssl_ctx != NULL && ctx->ssl_ctx_owned)
        SSL_CTX_free((SSL_CTX *)ctx->ssl_ctx);
    ctx->ssl_ctx = NULL;
    ctx->ssl_ctx_owned = 0;
}

const char *mcpb_port_tls_last_error(const mcpb_port_tls_t *ctx, char *buf, size_t cap)
{
    if (buf == NULL || cap == 0u)
        return "";
    buf[0] = '\0';
    if (ctx == NULL)
        return buf;
    if (ctx->last_verify != 0)
    {
        const char *s = X509_verify_cert_error_string(ctx->last_verify);
        strncpy(buf, s, cap - 1u);
        buf[cap - 1u] = '\0';
    }
    else if (ctx->last_ssl_error != 0u)
    {
        ERR_error_string_n(ctx->last_ssl_error, buf, cap);
    }
    return buf;
}
