# Deployment

The system splits along one line: **the worker holds a long-lived gRPC subscription to the
mirror node, and the dashboard does not.** That is why they deploy to different places.
A serverless function cannot hold that subscription open, so the worker needs a container
host; the dashboard only polls REST, so it is a natural fit for Vercel.

The two halves never talk to each other. They communicate only through HCS topics, which
means they can be deployed, restarted, and scaled independently.

## Worker → a Docker host

Currently deployed to an EC2 instance (`visa-ec2`) that also runs unrelated services, which
is exactly why it runs in a container: the image carries its own Node 22 and changes
nothing about the host's system Node.

```bash
make deploy-worker              # HOST=visa-ec2 by default
make worker-logs                # docker logs -f
make worker-status              # container state
make worker-stop
```

`scripts/deploy-worker.sh` rsyncs the source (no repository credentials needed on the
host), writes a 0600 env file, builds the image on the box, and restarts the container.

**What goes on the host, and what does not.** Only the worker's own variables:
`ACCOUNT_ID`, `PRIVATE_KEY`, `ANTHROPIC_API_KEY` and the four `TOPIC_*` ids. The device key
belongs to the boiler gateway and the operator key to the dashboard; neither has any
business on this machine, and the script refuses to copy them.

**Container settings that matter on a shared box:**

| Setting | Why |
|---|---|
| `--memory 512m` | the worker cannot starve the other services if it leaks |
| `--restart unless-stopped` | survives a reboot; does not fight a deliberate stop |
| `--log-opt max-size=10m --log-opt max-file=3` | logs cannot fill the disk |
| no published ports | only outbound connections, so nothing can collide |

Measured in practice: ~50 MB resident, ~0% CPU while idle between frames.

To undo the deployment entirely: `docker rm -f iiot-worker` and delete
`/home/ubuntu/iiot-agent`. No system packages are installed and no system state changes.

## Dashboard → Vercel

`vercel.json` at the repo root builds the `web` workspace. The root is the project
directory rather than `web/`, because the dashboard imports `../src/shared` — one
definition of a telemetry frame, shared with the pipeline — and a Vercel root of `web/`
would put those files outside the build context.

**Root Directory must be the repository root, not `web/`.** Vercel auto-detects the Next
app during import and will offer to set the root to `web/` — reject that. From inside
`web/`, `npm run build --workspace web` fails with `No workspaces found`, and more
fundamentally `../src/shared` is outside the build context, so the shared schemas the
dashboard imports do not exist. Settings → Build and Deployment → Root Directory → `./`.

A root install is ~340 packages (both workspaces). If a build log shows ~72, it installed
only the dashboard's own dependencies and the root directory is still wrong.

Import the repository at vercel.com/new and set these environment variables:

| Variable | Why the dashboard needs it |
|---|---|
| `TOPIC_TELEMETRY`, `TOPIC_ANALYSIS`, `TOPIC_REPORTS`, `TOPIC_DECISIONS` | the topics it reads |
| `ACCOUNT_ID`, `PRIVATE_KEY` | pays the fee when publishing a decision |
| `OPERATOR_PRIVATE_KEY` | signs decisions — the key the worker deliberately does not have |
| `OPERATOR_NAME` | the name recorded on each decision |
| `MIRROR_BASE_URL` | optional; defaults to the Hedera testnet mirror node |

The topic ids are not secret (anyone can read a public topic), but the keys are. See the
README's note on why server-side signing is a prototype compromise and what replaces it.

## Simulator → wherever the boiler is

The simulator stands in for a plant gateway, so it is deliberately *not* deployed. Run it
from a laptop when you want traffic:

```bash
make sim FAULT=low_water DURATION=120 START=30
```

Each frame costs about $0.0001, so a continuously running simulator is roughly $8.60/day
of testnet HBAR — run it for demos rather than leaving it on.

## Verifying a deployment

```bash
make worker-status                                  # container up, restart count 0
make sim FAULT=low_water DURATION=100 START=25      # drive it from anywhere
make worker-logs                                    # detections appear within ~1 s
make verify                                         # what actually landed on chain
```

The worker never sees the simulator directly — it learns about those readings only by
reading the telemetry topic, so a successful run proves the whole chain path end to end.
