# Test certificate

`test-cert.pem` and `test-key.pem` are what the TLS bench (`c/ports/tls-openssl/tests`) and the wss:// phase of the roundtrip use: the Node broker serves them, the C provider is given the certificate as its CA.

Test material only. Self-signed, valid for a century, and the private key is in this repository, so nothing outside these two tests may ever trust it. Subject alternative names: `localhost` and `127.0.0.1`.

Regenerate, should it ever need to change:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout test-key.pem -out test-cert.pem -days 36500 \
  -subj "/CN=mcp-broker c roundtrip, test only" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign"
```

For a real deployment, the broker's certificate comes from your CA (or `npm run gen-cert` in `node/packages/broker` for a self-signed one), and the device is given that CA: `--ca` on `host-provider`, `ca_pem` on the ESP-IDF component, `main/certs/ca.pem` in the ESP sample. The `certs/` folders are gitignored on purpose.
