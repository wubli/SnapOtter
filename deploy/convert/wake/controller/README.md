# SnapOtter wake controller

Run the tests with `node --test deploy/convert/wake/controller/server.test.mjs`.
Build with `docker build -t snapotter-wake-controller deploy/convert/wake/controller`.

The controller listens on Cloud Run's `PORT` and accepts `POST /wake` with
`Authorization: Bearer <shared token>`. Set `WAKE_CONTROLLER_TOKEN` from
Secret Manager on Cloud Run and keep the same value in the calling edge service's
secret store. The project, zone, and VM are fixed in the image.

| HTTP status | JSON | Meaning |
| --- | --- | --- |
| 200 | `{"state":"running"}` | Compute Engine reports that the VM is running. |
| 202 | `{"state":"starting"}` | A start request was accepted or the VM is still starting. |
| 202 | `{"state":"stopping"}` | Wait for the stop to finish before asking again. |
| 503 | `{"error":"temporarily_unavailable"}` | The controller could not determine or change the VM state. |

The caller should honor `Retry-After` on 202 and 503 responses and probe the
SnapOtter health endpoint before directing traffic to the VM. The controller
coalesces concurrent requests within a process and reconciles start conflicts
by checking the VM state again. Retries of an ambiguous start reuse its Compute
Engine request ID during the grace period.

Use a dedicated Cloud Run service account with a custom role containing
`compute.instances.get` and `compute.instances.start`, granted on the
`convertxx/europe-central2-b/snapotter` instance. Grant that account
`roles/secretmanager.secretAccessor` on the token secret. Enable the Cloud Run
Admin API, Compute Engine API and Secret Manager API where the respective resources
live. Artifact Registry also requires its API if the container is stored there.
The controller gets its access token from the Cloud Run metadata server.

[Compute Engine get](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/get),
[Compute Engine start](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/start),
[Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity),
[Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
