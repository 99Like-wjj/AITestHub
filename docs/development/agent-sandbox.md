# Agent execution sandbox

The sandbox broker is a separate trusted runtime for Python office calculations. Each execution uses a new restricted Linux container; ordinary API/worker containers are not execution sandboxes. Docker containers share their host kernel and do not provide virtual machine isolation.

## Runtime wiring

The AI worker receives `SandboxBrokerClient` through its composition root and sends only a fixed execution protocol. It must not receive a Docker socket or arbitrary Docker command capability. Only the independent broker accesses Docker. The broker's endpoints are authenticated and provide start, status and cancellation for sandbox run UUIDs. A start request is not retried automatically; the durable broker journal consumes a run UUID before starting code. Recovery removes only exact previously recorded containers and never reruns their code.

`packages/agent-runtime/src/main.ts` is the broker entry point. It has no import-time startup side effects. Its explicit configuration is:

| Variable                              | Meaning                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `AITESTHUB_SANDBOX_IMAGE`             | Preprovisioned immutable Python image ID or registry digest                     |
| `AITESTHUB_SANDBOX_TOKEN_FILE`        | Restricted file containing an independent bearer secret, at least 32 characters |
| `AITESTHUB_SANDBOX_JOURNAL_DIRECTORY` | External durable directory for consumed run IDs and lifecycle states            |
| `AITESTHUB_SANDBOX_BIND_HOST`         | Private interface; defaults to loopback                                         |
| `AITESTHUB_SANDBOX_PORT`              | Broker port; defaults to 5312                                                   |

Provision the execution image explicitly. The runtime does not pull images or install dependencies. Required office/data libraries belong in an independently built and reviewed image with fixed dependencies. Never expose the broker to the public internet. For a host process, use loopback/private addressing; for Linux containers, `deploy/local/compose.sandbox.yaml` provides an internal network template. Attach only the authorized AI worker to that control network, inject its matching secret through the trusted composition root, and keep the socket exclusive to the broker. The broker image must contain Node, the Docker CLI and the compiled runtime; the main application image does not implicitly contain the CLI.

## Execution limits and results

The protocol accepts only Python code and bounded relative-path file bytes. The container has no network or host bind mounts, runs as UID 65534, drops all capabilities, forbids privilege escalation, and has a read-only root. Writable `/workspace` and `/tmp` are limited tmpfs mounts. CPU is limited to 0.5 cores, memory and memory plus swap to 256 MiB, and processes to 32. Standard execution uses at most 120 seconds, 32 files, 4 MiB per file, 16 MiB aggregate file bytes and 256 KiB captured output.

The broker runs at most two jobs and admits a global FIFO queue of at most eight waiting requests with 32 MiB aggregate wire input. Acceptance journaling also reserves a queue slot. Status reports `queued` or `running`; queued cancellation and the 120-second queue deadline prevent execution without creating a container. Queue wait does not consume the program runtime budget or extend an individual HTTP request's 15-second deadline. Concurrent uploads have a separate shared 32 MiB/eight-request budget. Terminal output is retained for up to five minutes, at most 16 results and 64 MiB in aggregate.

An uncertain cleanup continues to reserve its execution slot, including after restart, until exact cleanup of the same UUID succeeds. Queueing cannot be used to start extra containers while old containers may still exist. Shutdown reports incomplete cleanup when such uncertainty remains.

An accepted UUID is synced as `queued` before acknowledgement and as `running` before code starts. Input bytes are never journaled; restart reconciles old and queued records through exact cleanup and never replays code. A full queue or shutting-down broker returns an explicit UUID-matched `accepted:false` response only after checking for an already consumed UUID; the client reports this as a resource limit with confirmed non-execution. Other HTTP failures remain uncertain and never cause a replacement POST.

Returned artifacts remain untrusted data. The host revalidates paths and byte limits and computes their hashes. The conversation workspace service must recheck current user/conversation authorization and optimistic versions when importing them. No execution result constitutes an approved platform test result.

Cancellation acknowledgement only records a stop request. For a run that reached the executor, `cleanupConfirmed:true` requires a successful Docker query showing the exact container is absent after cleanup. A queued request cancelled before execution has no container to clean up. `cleanup_unknown` means the broker cannot prove cleanup; callers must retain this uncertainty and reconcile the same run ID through status/cancellation. Never repeat code under a replacement ID to hide an unknown result. The broker retains run metadata after output expiry, so old code cannot execute again by resubmission.

Official runtime references: [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/), [container options](https://docs.docker.com/reference/cli/docker/container/run/) and [force removal](https://docs.docker.com/reference/cli/docker/container/rm/).
